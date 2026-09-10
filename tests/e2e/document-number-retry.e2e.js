// 書類発行（order-admin.html「書類発行」タブ）: 書類番号が競合しても発行できる
//
//   きっかけ（2026-09-10）
//     「請求書は出せたんだけど、このメッセージ出て発行済みにならない」との報告。
//     `duplicate key value violates unique constraint "documents_doc_number_key"`
//     でdocuments保存が失敗し、プレビューだけ出て「発行済み」記録が残らなかった。
//     採番（computeDocNumber）と保存（POST documents）の間に別の発行が挟まると
//     番号が競合しうる問題で、請求書作成タブ（invIssue）には既にリトライ処理が
//     あったが、書類発行タブ（generateDoc）には無かった。同じリトライを追加した。
//
//   ここで測ること
//     1. documentsへの保存が重複キーで1回失敗しても、採番し直して自動で
//        リトライし、最終的に発行済みとして保存される
//     2. プレビュー（印刷ポップアップ）は実際に保存できた番号で開く
//        （保存に失敗した番号のままプレビューだけ出ることがない）
//     3. 重複以外のエラーはリトライせずすぐにエラー表示する
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const alerts = []; page.on('dialog', async d => { alerts.push(d.message()); await d.dismiss(); });

  const CUST_A = { id: 'cust-a', code: 'C0001', name: 'A店', address: '千葉県A市', is_active: true };
  const ORDER = {
    id: 'ord-a', customer_id: CUST_A.id, customer_name: CUST_A.name, order_code: 'ORD-A',
    order_date: '2026-09-08', delivery_date: '2026-09-08', status: '発送済', total_amount: 0,
    order_items: [{ id: 'i1', species: 'イノシシ', part_name: 'モモ', weight_kg: 2, unit_price: 3000, subtotal: 6000 }],
  };

  let existingMax = 1; // documents に INV-202609-001 が既にある想定
  let postAttempts = 0;

  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = (x, status) => rt.fulfill({ status: status || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (/\/customers\b/.test(url) && m === 'GET') return J([CUST_A]);
    if (/\/orders\b/.test(url) && /order_items/.test(url) && m === 'GET') return J([ORDER]);
    if (/\/orders\b/.test(url) && m === 'GET') return J([]);
    if (/\/documents\b/.test(url) && m === 'GET') {
      // computeDocNumber()の採番クエリ: 既存の最大値だけ返す（001が既にある）
      return J([{ doc_number: 'INV-202609-' + String(existingMax).padStart(3, '0') }]);
    }
    if (/\/documents\b/.test(url) && m === 'POST') {
      postAttempts++;
      if (postAttempts === 1) {
        // 1回目: 採番時点のmaxとまだ食い違っておらず、001のまま衝突（他の発行が先に001を確保した想定）
        return J({ code: '23505', message: 'duplicate key value violates unique constraint "documents_doc_number_key"' }, 409);
      }
      // 2回目以降: 競合が解消済み（他の発行を検知してmaxが進む）→成功
      existingMax++;
      return J([{ id: 'doc-' + postAttempts }], 201);
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

  await page.evaluate(() => { document.querySelectorAll('#docOrderList input[type=checkbox]').forEach(cb => cb.checked = true); });
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.evaluate(() => generateDoc('請求書')),
  ]);
  await popup.waitForLoadState();

  ck('保存は2回試みられる（1回目は競合、2回目で成功）', postAttempts === 2, String(postAttempts));
  ck('「保存に失敗しました」のアラートは出ない（自動でリトライして成功するため）', !alerts.some(a => /保存に失敗/.test(a)), JSON.stringify(alerts));
  ck('採番の競合アラートも出ない（3回未満で成功したため）', !alerts.some(a => /採番が競合/.test(a)), JSON.stringify(alerts));

  await popup.close();
  ck('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
