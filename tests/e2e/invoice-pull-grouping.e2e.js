// 請求書「注文から取り込む」：同じ納品日・同じ部位（サブ部位の括弧は丸める）・同じ肉ランクは
// 1行にまとめ、品名に納品日と肉ランクを入れ、顧客の価格ランクで単価を自動計算する。
// 精肉時の部位分け（モモ（ソト）等）や在庫データそのものは変更しない、というのが要件。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));

  const CUSTOMER_ID = 'cust-nikuhiro';
  const CUSTOMER = { id: CUSTOMER_ID, code: 'C0591', name: 'にくひろ', price_rank: 'standard', is_active: true };
  const PRICE_MASTER = [
    { id: 'pm1', species: 'イノシシ', part_name: 'モモ', grade: '並', price_standard: 2600, price_local: 2400, price_startmember: 2100 },
    { id: 'pm2', species: 'イノシシ', part_name: 'モモ', grade: '上', price_standard: 3250, price_local: 3000, price_startmember: 3000 },
    { id: 'pm3', species: 'イノシシ', part_name: 'モモ', grade: '極上', price_standard: 3900, price_local: 3600, price_startmember: 3600 },
  ];
  // 8/5: 極上モモ4パック(在庫grade=極上・注文明細に紐付け) / 8/14: 並モモ10パック
  const mkItem = (id, part, wt, invId) => ({ id, order_id: null, inventory_id: invId, part_name: part, species: 'イノシシ', weight_kg: wt, weight: wt, unit_price: null, amount: null, subtotal: null, grade_snapshot: null });
  const ORDER_805 = {
    id: 'ord-805', customer_id: CUSTOMER_ID, order_date: '2026-08-05', delivery_date: '2026-08-05', status: '発送済', total_amount: 0,
    order_items: [
      mkItem('i1', 'モモ（シンタマ）', 1.19, 'inv1'), mkItem('i2', 'モモ（ソト）', 2.52, 'inv2'),
      mkItem('i3', 'モモ（ウチ）', 0.83, 'inv3'), mkItem('i4', 'モモ（全体）', 1.68, 'inv4'),
    ],
  };
  const ORDER_814 = {
    id: 'ord-814', customer_id: CUSTOMER_ID, order_date: '2026-08-14', delivery_date: '2026-08-14', status: '発送済', total_amount: 0,
    order_items: [
      mkItem('i5', 'モモ（ウチ）', 0.23, 'inv5'), mkItem('i6', 'モモ（シンタマ）', 0.23, 'inv6'),
      mkItem('i7', 'モモ（シンタマ）', 0.24, 'inv7'), mkItem('i8', 'モモ（全体）', 1.22, 'inv8'),
      mkItem('i9', 'モモ（全体）', 1.13, 'inv9'), mkItem('i10', 'モモ（全体）', 1.82, 'inv10'),
      mkItem('i11', 'モモ（全体）', 1.79, 'inv11'), mkItem('i12', 'モモ（全体）', 0.77, 'inv12'),
      mkItem('i13', 'モモ（全体）', 1.32, 'inv13'), mkItem('i14', 'モモ（全体）', 0.63, 'inv14'),
    ],
  };
  const INV_GRADE = {};
  ['inv1', 'inv2', 'inv3', 'inv4'].forEach(id => INV_GRADE[id] = '極上');
  ['inv5', 'inv6', 'inv7', 'inv8', 'inv9', 'inv10', 'inv11', 'inv12', 'inv13', 'inv14'].forEach(id => INV_GRADE[id] = '並');

  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = (x) => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m !== 'GET') return J([]);
    if (/\/customers\b/.test(url)) return J([CUSTOMER]);
    if (/\/price_master\b/.test(url)) return J(PRICE_MASTER);
    if (/\/inventory\b/.test(url)) {
      const m2 = url.match(/id=in\.\(([^)]*)\)/);
      const ids = m2 ? m2[1].split(',') : [];
      return J(ids.map(id => ({ id, grade: INV_GRADE[id] || null })));
    }
    if (/\/document_orders\b/.test(url)) return J([]);
    if (/\/documents\b/.test(url)) return J([]);
    if (/\/orders\b/.test(url) && /order_items/.test(url)) return J([ORDER_805, ORDER_814]);
    if (/\/orders\b/.test(url)) return J([]);
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));

  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(600);

  await page.evaluate(() => switchTab('invoice'));
  await page.waitForTimeout(100);
  await page.evaluate((cid) => { document.getElementById('invCustomerId').value = cid; }, CUSTOMER_ID);
  await page.evaluate(() => { document.getElementById('invPullPeriod').value = 'all'; });
  await page.evaluate(() => invPullSearch());
  await page.waitForTimeout(200);
  await page.evaluate(() => invPullToggleAll(true));
  await page.evaluate(() => invPullApply());
  await page.waitForTimeout(200);

  const lines = await page.evaluate(() => invLines);

  const results = [];
  const ck = (name, cond, got) => results.push([name, cond, got]);

  ck('14件の明細が2行にまとまる', lines.length === 2, JSON.stringify(lines));

  const l805 = lines.find(l => /8\/5/.test(l.name));
  const l814 = lines.find(l => /8\/14/.test(l.name));
  ck('8/5の行がある', !!l805, JSON.stringify(lines));
  ck('8/14の行がある', !!l814, JSON.stringify(lines));

  if (l805) {
    ck('8/5: 品名に納品日が入る', l805.name.startsWith('8/5納品'), l805.name);
    ck('8/5: 品名に肉ランク（極上）が入る', /（極上）/.test(l805.name), l805.name);
    ck('8/5: モモのサブ部位表記が残っていない', !/（シンタマ|ソト|ウチ|全体）/.test(l805.name), l805.name);
    ck('8/5: 重量が4パック合算(6.22kg)', Math.abs(Number(l805.qty) - 6.22) < 0.001, String(l805.qty));
    ck('8/5: 極上の標準単価3900円が自動で入る', Number(l805.price) === 3900, String(l805.price));
  }
  if (l814) {
    ck('8/14: 品名に納品日が入る', l814.name.startsWith('8/14納品'), l814.name);
    ck('8/14: 並ランクは括弧を付けない', !/（並）/.test(l814.name), l814.name);
    ck('8/14: 重量が10パック合算(9.38kg)', Math.abs(Number(l814.qty) - 9.38) < 0.001, String(l814.qty));
    ck('8/14: 並の標準単価2600円が自動で入る', Number(l814.price) === 2600, String(l814.price));
  }

  ck('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
