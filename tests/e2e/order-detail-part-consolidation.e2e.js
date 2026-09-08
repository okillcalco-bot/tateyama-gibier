// 注文一覧（order-admin.html「注文一覧」タブ）：注文詳細モーダルの明細まとめ
//
//   きっかけ（2026-09-08）
//     書類発行タブでは部位の合算・モモの区分まとめを直したが、「注文一覧」タブの
//     「詳細」ボタン（showOrderDetail）は別コードパスで、まだ精肉時の個別パック・
//     部位区分（モモの全体/ウチ/ソト/シンタマ）がそのまま行ごとに出ていた、という指摘。
//
//   ここで測ること
//     1. 同じ部位の複数パックが1行にまとまり、合計重量が出る
//     2. モモ（全体・ウチ・ソト・シンタマ）は「モモ」1行にまとまる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { await d.dismiss(); });

  const ORDER = {
    id: 'ord-1', customer_id: 'cust-a', customer_name: 'A店', order_code: 'ORD-0001',
    order_date: '2026-09-01', delivery_date: '2026-09-01', status: '発送済', total_amount: 0, channel: '直販',
    order_items: [
      { id: 'i1', species: 'イノシシ', part_name: 'モモ（全体）', weight_kg: 1.0, unit_price: 2600, subtotal: 2600 },
      { id: 'i2', species: 'イノシシ', part_name: 'モモ（ウチ）', weight_kg: 0.3, unit_price: 2600, subtotal: 780 },
      { id: 'i3', species: 'イノシシ', part_name: 'モモ（ソト）', weight_kg: 0.2, unit_price: 2600, subtotal: 520 },
      { id: 'i4', species: 'イノシシ', part_name: 'ロース', weight_kg: 1.0, unit_price: 3800, subtotal: 3800 },
      { id: 'i5', species: 'イノシシ', part_name: 'ロース', weight_kg: 0.5, unit_price: 3800, subtotal: 1900 },
    ],
  };

  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = x => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m !== 'GET') return J([]);
    if (/\/customers\b/.test(url)) return J([{ id: 'cust-a', code: 'C0001', name: 'A店', is_active: true }]);
    if (/\/orders\b/.test(url) && /order_items/.test(url)) return J([ORDER]);
    if (/\/orders\b/.test(url)) return J([]);
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));

  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(600);
  await page.evaluate(() => showOrderDetail('ord-1'));
  await page.waitForTimeout(150);
  const html = await page.$eval('#odContent', el => el.innerHTML);

  const results = [];
  const ck = (name, cond, got) => results.push([name, cond, got]);

  ck('モモの部位区分（全体・ウチ・ソト・シンタマ）は出ない', !html.includes('モモ（'), html);
  ck('モモが合算重量1.5kgの1行になる', html.includes('モモ') && html.includes('1.5'), html);
  ck('モモの合算金額3,900円が出る', /3,900/.test(html), html);
  const rosuCount = (html.match(/ロース/g) || []).length;
  ck('ロースの複数パックが1行にまとまる', rosuCount === 1, `ロースの出現回数=${rosuCount}`);
  ck('ロースの合算重量1.5kg・金額5,700円が出る', html.includes('1.5') && /5,700/.test(html), html);
  ck('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 300) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
