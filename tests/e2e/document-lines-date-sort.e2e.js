// 書類発行（order-admin.html「書類発行」タブ）：明細を納品日の古い順に並べる
//
//   きっかけ（2026-09-08）
//     「請求書は上から古い順の日付にして」という指摘。選択した注文の並び順のまま
//     明細を積んでいたため、選んだ順によっては新しい日付が先に出てしまっていた。
//
//   ここで測ること
//     選択（チェックした）順が新しい日付→古い日付でも、発行される明細は
//     常に納品日の古い順（8/1が8/2より先）に並ぶ
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { await d.dismiss(); });

  const CUST_A = { id: 'cust-a', code: 'C0001', name: 'A店', address: '千葉県A市', is_active: true };

  // わざと新しい日付の注文を配列の先頭（＝一覧で先にレンダリングされる側）に置く
  const ORDER_NEW = {
    id: 'ord-new', customer_id: CUST_A.id, customer_name: CUST_A.name, order_code: 'ORD-NEW',
    order_date: '2026-08-20', delivery_date: '2026-08-20', status: '発送済', total_amount: 0,
    order_items: [{ id: 'iN', species: 'イノシシ', part_name: 'ヒレ', weight_kg: 1.0, unit_price: 3800, subtotal: 3800 }],
  };
  const ORDER_OLD = {
    id: 'ord-old', customer_id: CUST_A.id, customer_name: CUST_A.name, order_code: 'ORD-OLD',
    order_date: '2026-08-01', delivery_date: '2026-08-01', status: '発送済', total_amount: 0,
    order_items: [{ id: 'iO', species: 'イノシシ', part_name: '内臓', weight_kg: 1.0, unit_price: 1000, subtotal: 1000 }],
  };

  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = x => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m !== 'GET') return J([]);
    if (/\/customers\b/.test(url)) return J([CUST_A]);
    if (/\/documents\b/.test(url)) return J([]);
    // わざと新しい日付を先頭で返す（並び順に頼れないことを確認するため）
    if (/\/orders\b/.test(url) && /order_items/.test(url)) return J([ORDER_NEW, ORDER_OLD]);
    if (/\/orders\b/.test(url)) return J([]);
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));

  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(600);
  await page.evaluate(() => switchTab('documents'));
  await page.waitForTimeout(300);

  const results = [];
  const ck = (name, cond, got) => results.push([name, cond, got]);

  // 一覧の並び（未発行優先→新しい発送順）に関わらず両方チェックする
  await page.evaluate(() => { document.querySelectorAll('#docOrderList input[type=checkbox]').forEach(cb => cb.checked = true); });
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.evaluate(() => generateDoc('請求書')),
  ]);
  await popup.waitForLoadState();
  const html = await popup.content();

  const idxHire = html.indexOf('ヒレ');   // 8/20（新しい）
  const idxNaizo = html.indexOf('内臓');  // 8/1（古い）
  ck('内臓（8/1・古い）とヒレ（8/20・新しい）が両方出る', idxHire >= 0 && idxNaizo >= 0, `idxHire=${idxHire} idxNaizo=${idxNaizo}`);
  ck('古い日付（内臓・8/1）が新しい日付（ヒレ・8/20）より上に出る', idxNaizo >= 0 && idxHire >= 0 && idxNaizo < idxHire, html.slice(0, 3000));

  await popup.close();
  ck('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
