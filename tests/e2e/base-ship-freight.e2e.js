// BASE出荷にも運送会社・サイズ・クール・送料を記録できる
//   2026-09-03 追記: 購入者の都道府県（BASEの注文情報）から送料を先に入れておく。空のまま発送処理されない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const KEY = 'BK001';
const BASE_ORDERS = { orders: [{
  unique_key: KEY, ordered: 1756000000, total: '8800', last_name: '平沢', first_name: '卓也',
  dispatch_status: 'ordered', prefecture: '大阪府', address: '大阪市北区1-1',
  order_items: [{ item_id: '111', title: 'イノシシ ロース 500g', amount: 1, price: '4400', status: 'unpaid', order_item_id: 'oi1' }]
}] };
const RATES = [
  { carrier: 'ヤマト', area: '関東', size_code: 100, base_fee: 900,  cool_surcharge: 400 },
  { carrier: 'ヤマト', area: '関西', size_code: 100, base_fee: 1200, cool_surcharge: 400 },
  { carrier: 'ヤマト', area: '関西', size_code: 80,  base_fee: 1000, cool_surcharge: 300 },
  { carrier: '佐川',   area: '関西', size_code: 80,  base_fee: 700,  cool_surcharge: 300 }
];
const AREAS = [
  { carrier: 'ヤマト', pref: '大阪府', area: '関西' }, { carrier: '佐川', pref: '大阪府', area: '関西' },
  { carrier: 'ヤマト', pref: '千葉県', area: '関東' }
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let shipPosts = [];
  let ratesEnabled = true;

  await page.route('**/*', route => {
    const u = route.request().url(), m = route.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (!/\/rest\/v1\//.test(u)) { if (u.startsWith('file:')) return route.continue(); return route.fulfill({ status: 200, body: '[]' }); }
    const J = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/rpc\/base_orders/.test(u)) return J(BASE_ORDERS);
    if (/\/rpc\/base_order_detail/.test(u)) return J({ order: BASE_ORDERS.orders[0] });
    if (/\/rpc\/base_status/.test(u)) return J({ connected: true });
    if (/\/rpc\//.test(u)) return J(null);
    if (m === 'POST' && /\/shipments/.test(u)) {
      try { shipPosts.push(JSON.parse(route.request().postData() || '{}')); } catch (e) {}
      return route.fulfill({ status: 201, contentType: 'application/json', body: '[{"id":"s1"}]' });
    }
    if (m === 'POST' && /\/orders/.test(u)) return route.fulfill({ status: 201, contentType: 'application/json', body: '[{"id":"o1"}]' });
    if (m === 'POST' || m === 'PATCH') return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    if (/\/shipping_rates/.test(u)) return J(ratesEnabled ? RATES : []);
    if (/\/shipping_areas/.test(u)) return J(ratesEnabled ? AREAS : []);
    if (/\/products/.test(u)) return J([{ id: 'p1', name: 'イノシシ ロース 500g', stock_qty: 5, base_item_id: '111' }]);
    return J([]);
  });
  await page.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  page.on('dialog', d => d.accept());

  const results = [];
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(700);
  await page.evaluate(async () => { if (typeof loadBaseOrders === 'function') await loadBaseOrders(); });
  await page.waitForTimeout(600);

  // 1) 各BASE注文カードに送料の入力欄が出る
  const fields = await page.evaluate(k => ({
    track: !!document.getElementById('base-track-' + k),
    carrier: !!document.getElementById('base-carrier-' + k),
    size: !!document.getElementById('base-size-' + k),
    cool: !!document.getElementById('base-cool-' + k),
    freight: !!document.getElementById('base-freight-' + k),
    coolDefault: document.getElementById('base-cool-' + k)?.checked,
    sizeDefault: document.getElementById('base-size-' + k)?.value,
    freightValue: document.getElementById('base-freight-' + k)?.value,
    note: document.getElementById('base-freight-note-' + k)?.innerText || ''
  }), KEY);
  results.push(['送り状番号の欄がある', fields.track, '']);
  results.push(['運送会社の欄がある', fields.carrier, '']);
  results.push(['サイズの欄がある', fields.size, '']);
  results.push(['クール便の欄がある', fields.cool, '']);
  results.push(['送料の欄がある', fields.freight, '']);
  results.push(['既定はクール便ON・100サイズ', fields.coolDefault === true && fields.sizeDefault === '100', `cool=${fields.coolDefault} size=${fields.sizeDefault}`]);
  // 1b) 購入者の都道府県（大阪府→関西）から送料が先に入る（ヤマト100クール = 1200+400）
  results.push(['都道府県から送料が先に入る', fields.freightValue === '1600', fields.freightValue]);
  results.push(['根拠（都道府県と地域）を表示', /大阪府/.test(fields.note) && /関西/.test(fields.note) && /1,600/.test(fields.note), fields.note.slice(0, 60)]);

  // 1c) サイズ・運送会社を変えると再計算（佐川80クール関西 = 700+300）
  await page.evaluate(async k => {
    document.getElementById('base-carrier-' + k).value = '佐川';
    document.getElementById('base-size-' + k).value = '80';
    await baseFreightAuto(k, true);
  }, KEY);
  await page.waitForTimeout(200);
  results.push(['条件を変えると再計算', await page.$eval('#base-freight-' + KEY, el => el.value) === '1000', await page.$eval('#base-freight-' + KEY, el => el.value)]);

  // 2) 発送処理で4項目が出荷に保存される（手入力が優先）
  await page.evaluate(async k => {
    document.getElementById('base-track-' + k).value = '1234-5678';
    document.getElementById('base-carrier-' + k).value = '佐川';
    document.getElementById('base-size-' + k).value = '80';
    document.getElementById('base-cool-' + k).checked = true;
    document.getElementById('base-freight-' + k).value = '1320';
    await baseOrderShip(k);
  }, KEY);
  await page.waitForTimeout(600);
  const sp = shipPosts[shipPosts.length - 1] || {};
  results.push(['運送会社を保存', sp.carrier === '佐川', String(sp.carrier)]);
  results.push(['サイズを保存(数値)', sp.size_code === 80, String(sp.size_code)]);
  results.push(['クール便を保存', sp.is_cool === true, String(sp.is_cool)]);
  results.push(['送料を保存（手入力が優先）', sp.freight === 1320, String(sp.freight)]);
  results.push(['送り状番号はメモに残る', /1234-5678/.test(String(sp.notes || '')), String(sp.notes)]);

  // 3) 送料を消したまま発送処理しても、直前に都道府県から自動計算されて保存される（ヤマト100クール関西=1600）
  shipPosts = [];
  await page.evaluate(async () => { if (typeof loadBaseOrders === 'function') await loadBaseOrders(); });
  await page.waitForTimeout(500);
  await page.evaluate(async k => {
    document.getElementById('base-carrier-' + k).value = 'ヤマト';
    document.getElementById('base-size-' + k).value = '100';
    document.getElementById('base-freight-' + k).value = '';
    await baseOrderShip(k);
  }, KEY);
  await page.waitForTimeout(600);
  const sp2 = shipPosts[shipPosts.length - 1] || {};
  results.push(['空のまま発送→直前に自動計算して保存', sp2.freight === 1600, String(sp2.freight)]);

  // 3b) 料金表が読めない環境では、従来どおり送料なしでも発送処理は通る（記録されないだけ）
  shipPosts = [];
  ratesEnabled = false;
  await page.evaluate(() => { shipRatesCache = null; shipAreasCache = null; });
  await page.evaluate(async () => { if (typeof loadBaseOrders === 'function') await loadBaseOrders(); });
  await page.waitForTimeout(500);
  await page.evaluate(async k => {
    document.getElementById('base-freight-' + k).value = '';
    await baseOrderShip(k);
  }, KEY);
  await page.waitForTimeout(600);
  const sp3 = shipPosts[shipPosts.length - 1] || {};
  results.push(['料金表が無くても出荷は記録', !!sp3.order_id, String(sp3.order_id)]);
  results.push(['料金表が無ければ送料は入らない', sp3.freight === undefined, String(sp3.freight)]);

  results.push(['pageerrorなし', errors.length === 0, errors.join(' / ')]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' && got != null ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
