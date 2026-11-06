// 請求書: その場で現金で受け取った注文（備考に【現金受領済】）は請求書に載せない（2026-11-05）
//   きっかけ: 「代金は受領済」と備考にあった注文に月まとめで請求書が出ていた（二重請求のおそれ）。
//   測ること（顧客・金額はすべて架空）
//     1. 月まとめ: 現金受領済の注文は未請求に入らず、「現金受領済 N件は対象外」と出る
//     2. 同じ顧客のふつうの注文は今までどおり請求の対象
//     3. 請求書作成の「注文から取り込む」にも出ない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.dismiss());
  const C = { id: 'c1', code: 'C9201', name: '架空食堂', address: '千葉県架空市1', is_active: true, price_rank: 'standard', notes: '' };
  const it = (id, amt) => ({ id, species: 'イノシシ', part_name: 'ロース', weight_kg: 1, weight: 1, unit_price: amt, amount: amt, subtotal: amt, grade_snapshot: '並' });
  const ORD = [
    { id: 'o1', order_code: 'T-1', customer_id: 'c1', customer_name: '架空食堂', order_date: '2026-10-05', delivery_date: '2026-10-05', status: '発送済', total_amount: 3800, notes: '', order_items: [it('i1', 3800)], shipments: [] },
    { id: 'o2', order_code: 'T-2', customer_id: 'c1', customer_name: '架空食堂', order_date: '2026-10-09', delivery_date: '2026-10-09', status: '発送済', total_amount: 2900, notes: '【現金受領済】領収証（控）', order_items: [it('i2', 2900)], shipments: [] },
  ];
  await page.route('**/rest/v1/**', rt => {
    const u = decodeURIComponent(rt.request().url()); const J = x => rt.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    if (rt.request().method() !== 'GET') return J([]);
    if (/\/customers\b/.test(u)) return J([C]);
    if (/\/orders\b/.test(u) && /order_items/.test(u)) return J(ORD);
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));
  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html')); await page.waitForTimeout(700);
  const R = []; const ck = (n, c, g) => R.push([n, !!c, g == null ? '' : String(g)]);
  const b = await page.evaluate(async () => { switchTab('invoice'); document.getElementById('invBatchMonth') && (document.getElementById('invBatchMonth').value = '2026-10'); await invBatchSearch(); return { res: document.getElementById('invBatchResult').textContent, groups: invBatchGroups.map(g => ({ n: g.orders.length, ids: g.orders.map(o => o.id), total: g.total })) }; });
  ck('1. 現金受領済の注文は未請求に入らない（o1だけ）', b.groups.length === 1 && b.groups[0].ids.join(',') === 'o1', JSON.stringify(b));
  ck('1. 「現金受領済 1件は対象外」と出る', /現金受領済 1件は対象外/.test(b.res), b.res);
  ck('2. ふつうの注文は今までどおり請求の対象', b.groups[0] && b.groups[0].total > 0, JSON.stringify(b.groups));
  const p = await page.evaluate(async () => { document.getElementById('invCustomerId').value = 'c1'; const pp = document.getElementById('invPullPeriod'); if (pp) pp.value = 'all'; await invPullSearch(); return invPullOrders.map(o => o.id); });
  ck('3. 「注文から取り込む」にも現金受領済は出ない', p.join(',') === 'o1', JSON.stringify(p));
  ck('pageerrorなし', errors.length === 0, errors.join(' / '));
  await browser.close();
  let pass = 0; for (const [n, ok, g] of R) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (g ? '  [' + g.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${R.length} passed`); process.exit(pass === R.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
