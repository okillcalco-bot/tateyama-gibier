// 書類発行（order-admin.html「書類発行」タブ）: 複数注文の請求書がdoc_numberのUNIQUE制約に
// 違反せず保存できる（実際のDB制約を模した回帰テスト）
//
//   きっかけ（2026-09-10）
//     ノブレスオブリージュ宛の請求書（16注文）が「書類番号の採番が競合しました」で
//     何度発行し直しても保存できなかった。実際に本番DBを調べたところ、真の原因は
//     ブラウザキャッシュでもリトライ不足でもなく、generateDoc()が複数注文の請求書でも
//     注文ごとに"同じdoc_numberを持つ行"をdocumentsテーブルへ複数INSERTしようとしており、
//     documents.doc_numberに張られた本物のUNIQUE制約（1行目の直後に2行目で必ず違反する）
//     に構造的に違反していたことだった。採番をやり直しても、新しい番号でまた同じ数の行を
//     同じ番号でINSERTしようとするので、3回リトライしても100%失敗し続けていた。
//
//     これまでのテストは全てPOST /documentsを無条件に成功させるモックだったため、
//     このUNIQE制約違反を一度も検出できていなかった。このテストは実際のPostgRESTと
//     同じように「documents.doc_numberが重複したら23505で拒否する」モックを使い、
//     本物のDB制約に対して複数注文の請求書が本当に保存できることを確認する。
//
//   ここで測ること
//     1. 5注文（1顧客）をまとめて請求書発行すると、documentsの行は1件だけ作られる
//        （複数行に同じdoc_numberを持たせようとしないので、UNIQUE制約に違反しない）
//     2. その1件が5注文すべてとdocument_orders経由でひもづく
//     3. 採番の競合アラート（「もう一度発行し直してください」）が出ない
//     4. 続けて別の請求書を発行すると、次の連番（INV-202609-002）が使われる
//        （1件目がdocumentsに正しく保存され、採番に反映されている証拠）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const alerts = []; page.on('dialog', async d => { alerts.push(d.message()); await d.dismiss(); });

  const CUST = { id: 'cust-w', code: 'C0731', name: 'ノブレスオブリージュ', address: '東京都W区', is_active: true };
  const mkOrder = (n) => ({
    id: 'ord-' + n, customer_id: CUST.id, customer_name: CUST.name, order_code: 'ORD-' + n,
    order_date: '2026-08-0' + n, delivery_date: '2026-08-0' + n, status: '発送済', total_amount: 3000,
    order_items: [{ id: 'i' + n, species: 'イノシシ', part_name: 'モモ', weight_kg: 1, unit_price: 3000, subtotal: 3000 }],
  });
  const ORDERS = [1, 2, 3, 4, 5].map(mkOrder);

  // 実際のPostgRESTを模す: documentsテーブル全体でdoc_numberが本物のUNIQUE制約を持つ。
  // 同じ番号の行を2件以上INSERTしようとしたら（バッチ内の重複も含めて）23505で拒否する。
  const db = { documents: [], documentOrders: [] };
  let docSeq = 0;
  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = (x, status) => rt.fulfill({ status: status || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (/\/customers\b/.test(url) && m === 'GET') return J([CUST]);
    if (/\/orders\b/.test(url) && /order_items/.test(url) && m === 'GET') return J(ORDERS);
    if (/\/orders\b/.test(url) && m === 'GET') return J([]);
    if (/\/document_orders\b/.test(url) && m === 'POST') {
      let body = []; try { body = JSON.parse(req.postData() || '[]'); } catch (e) {}
      const rows = Array.isArray(body) ? body : [body];
      db.documentOrders.push(...rows);
      return J(rows);
    }
    if (/\/document_orders\b/.test(url) && m === 'GET') return J([]);
    if (/\/documents\b/.test(url) && m === 'GET' && /doc_number=like\./.test(url)) {
      const prefix = (decodeURIComponent(url).match(/doc_number=like\.([^&*]+)/) || [])[1] || '';
      return J(db.documents.filter(d => (d.doc_number || '').startsWith(prefix)).map(d => ({ doc_number: d.doc_number })));
    }
    if (/\/documents\b/.test(url) && m === 'GET') return J([]); // 発行済み突き合わせ
    if (/\/documents\b/.test(url) && m === 'POST') {
      let body; try { body = JSON.parse(req.postData() || '{}'); } catch (e) { body = {}; }
      const rows = Array.isArray(body) ? body : [body];
      // 本物のPostgRESTと同じ挙動: バッチ内の重複、既存行との重複、どちらも23505
      const nums = rows.map(r => r.doc_number);
      const dupInBatch = new Set(nums).size !== nums.length;
      const dupInDb = nums.some(n => db.documents.some(d => d.doc_number === n));
      if (dupInBatch || dupInDb) {
        return J({ code: '23505', message: 'duplicate key value violates unique constraint "documents_doc_number_key"' }, 409);
      }
      const withIds = rows.map(r => Object.assign({ id: 'doc-' + (docSeq++) }, r));
      db.documents.push(...withIds);
      return J(withIds);
    }
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));

  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(600);
  await page.evaluate(() => switchTab('documents'));
  await page.waitForTimeout(300);

  const results = [];
  const ck = (name, cond, got) => results.push([name, cond, got]);

  // ① 5注文をまとめて請求書発行
  await page.evaluate(() => { document.querySelectorAll('#docOrderList input[type=checkbox]').forEach(cb => cb.checked = true); });
  const [popup1] = await Promise.all([
    page.waitForEvent('popup'),
    page.evaluate(() => generateDoc('請求書')),
  ]);
  await popup1.waitForLoadState();
  await popup1.close();

  ck('採番の競合アラートは出ない（実際のUNIQUE制約に違反しないため）', !alerts.some(a => /採番が競合/.test(a)), JSON.stringify(alerts));
  ck('保存失敗のアラートも出ない', !alerts.some(a => /保存に失敗/.test(a)), JSON.stringify(alerts));
  ck('documentsの行は1件だけ作られる（5注文でもdoc_numberは1つ）', db.documents.length === 1, JSON.stringify(db.documents));
  ck('document_ordersで5注文すべてにひもづく', db.documentOrders.length === 5
    && [1, 2, 3, 4, 5].every(n => db.documentOrders.some(o => o.order_id === 'ord-' + n)), JSON.stringify(db.documentOrders));
  ck('document_ordersは発行したdocumentを指す', db.documents.length === 1 && db.documentOrders.every(o => o.document_id === db.documents[0].id), JSON.stringify(db));

  // 2026-09-10追記: documentsの行自体は保存できても、宛名(partner_name)・支払期限(due_date)・
  // 入金状態(billing_status)・再印刷用データ(snapshot)が抜けていたため、請求書作成タブの
  // 請求書一覧では「宛名: --」「支払期限: --」の空欄行として表示され、再印刷もできなかった
  // （書類発行タブと請求書作成タブが同じdocumentsテーブルを共有しているため）。
  const doc1 = db.documents[0] || {};
  ck('宛名(partner_name)が保存される', doc1.partner_name === 'ノブレスオブリージュ', String(doc1.partner_name));
  ck('支払期限(due_date)が保存される（発行日の翌月末）', doc1.due_date === '2026-10-31', String(doc1.due_date));
  ck('入金状態(billing_status)が未入金で保存される', doc1.billing_status === '未入金', String(doc1.billing_status));
  ck('再印刷用データ(snapshot)が保存される', !!doc1.snapshot && Array.isArray(doc1.snapshot.lines) && doc1.snapshot.lines.length > 0, JSON.stringify(doc1.snapshot).slice(0, 200));

  // ② 続けて別の請求書を発行すると、採番が正しく進んでいる（INV-202609-002）
  alerts.length = 0;
  await page.evaluate(() => { document.querySelectorAll('#docOrderList input[type=checkbox]').forEach(cb => cb.checked = (cb.dataset.oid === 'ord-1')); });
  const num2 = await page.evaluate(() => computeDocNumber('請求書', '2026-09-10'));
  ck('1件目の保存が採番に反映され、次は002になる', num2 === 'INV-202609-002', num2);

  ck('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 250) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
