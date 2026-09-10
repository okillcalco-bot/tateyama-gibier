// 書類発行タブ：既にその種類の書類が発行済みの注文をもう一度選んで発行しようとしたら、
// 二重発行の警告を出して確認を求める（請求書作成タブのinvPullApply()には元からあった
// チェックが、書類発行タブのgenerateDoc()には無かった）。
//
//   きっかけ（2026-09-10）
//     ある顧客の注文が、書類発行タブと請求書作成タブの両方から、あるいは書類発行タブの
//     「全選択」を使った際に、同じ注文へ複数回請求書が発行されてしまう事故が実際に起きた。
//     一覧のチェックボックスは「発行済」バッジを出すだけで選択自体はブロックしておらず、
//     全選択すると発行済みの注文も一緒に再送信されてしまっていた。
//
//   もう一つ: 取消した書類の注文がずっと「発行済」バッジのままになる不具合もあった
//     （docDocsMapの突き合わせがstatus='取消'を見ていなかったため）。取消後は
//     再発行しても警告が出ない（＝未発行として扱われる）ことも確認する。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const confirms = []; let confirmAnswer = true;
  page.on('dialog', async d => { confirms.push(d.message()); await (confirmAnswer ? d.accept() : d.dismiss()); });

  const CUST = { id: 'cust-x', code: 'C0999', name: 'テスト商店', address: '千葉県X市', is_active: true };
  const ORDER = {
    id: 'ord-x', customer_id: CUST.id, customer_name: CUST.name, order_code: 'DIR-X001',
    order_date: '2026-08-10', delivery_date: '2026-08-10', status: '発送済', total_amount: 3000,
    order_items: [{ id: 'ix1', species: 'イノシシ', part_name: 'モモ', weight_kg: 1, unit_price: 3000, subtotal: 3000 }],
  };
  let existingDocs = [{ order_id: 'ord-x', doc_type: '請求書', status: '発行済' }];
  let postedDocs = [];

  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = (x, status) => rt.fulfill({ status: status || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m === 'GET' && /\/customers\b/.test(url)) return J([CUST]);
    if (m === 'GET' && /\/orders\b/.test(url) && /order_items/.test(url)) return J([ORDER]);
    if (m === 'GET' && /\/orders\b/.test(url)) return J([]);
    if (m === 'GET' && /\/documents\b/.test(url) && /order_id=in/.test(url)) {
      return J(existingDocs.filter(d => d.status !== '取消').map(d => ({ order_id: d.order_id, doc_type: d.doc_type })));
    }
    if (m === 'GET' && /\/document_orders\b/.test(url)) return J([]); // 中間テーブル経由の紐づけは無し（単独注文のケース）
    if (m === 'GET' && /\/documents\b/.test(url) && /doc_number=like/.test(url)) return J([]);
    if (m === 'POST' && /\/documents\b/.test(url)) { const b = JSON.parse(req.postData() || '{}'); postedDocs.push(b); return J([Object.assign({ id: 'doc-new' }, b)], 201); }
    if (m === 'POST' && /\/document_orders\b/.test(url)) return J([], 201);
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));

  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(600);
  await page.evaluate(() => switchTab('documents'));
  await page.waitForTimeout(300);

  const results = [];
  const ck = (name, cond, got) => results.push([name, cond, got]);

  // ① 既に請求書が発行済みの注文を選んで「請求書」を押すと確認ダイアログが出る
  await page.evaluate(() => { document.querySelectorAll('#docOrderList input[type=checkbox]').forEach(cb => cb.checked = true); });
  confirmAnswer = false; // キャンセルする
  await page.evaluate(() => generateDoc('請求書'));
  await page.waitForTimeout(200);
  ck('発行済みの注文を再選択すると確認ダイアログが出る', confirms.some(m => /既に請求書が発行済み/.test(m)), JSON.stringify(confirms));
  ck('キャンセルするとdocumentsは作られない', postedDocs.length === 0, JSON.stringify(postedDocs));

  // ② 確認して続行すれば発行される
  confirms.length = 0; confirmAnswer = true;
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.evaluate(() => generateDoc('請求書')),
  ]);
  await popup.waitForLoadState(); await popup.close();
  ck('確認して続行すればdocumentsが作られる', postedDocs.length === 1, JSON.stringify(postedDocs));

  // ③ 取消済みの書類は「発行済」扱いされず、警告が出ない
  // （同じページで2回目のwindow.open()はブラウザにポップアップとして
  //   ブロックされることがあるため、ここではpopupを待たずdocumentsへの
  //   保存だけを確認する＝②までで確認ダイアログの仕組み自体は検証済み）
  existingDocs = [{ order_id: 'ord-x', doc_type: '請求書', status: '取消' }];
  postedDocs = []; confirms.length = 0;
  await page.evaluate(() => loadDocOrders());
  await page.waitForTimeout(300);
  await page.evaluate(() => { document.querySelectorAll('#docOrderList input[type=checkbox]').forEach(cb => cb.checked = true); });
  await page.evaluate(() => generateDoc('請求書'));
  await page.waitForTimeout(500);
  ck('取消済みの書類は警告の対象にならない', confirms.length === 0, JSON.stringify(confirms));
  ck('取消後は普通に発行できる', postedDocs.length === 1, JSON.stringify(postedDocs));

  ck('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 250) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
