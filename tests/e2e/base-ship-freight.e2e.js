// BASE出荷にも運送会社・サイズ・クール・送料を記録できる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const KEY = 'BK001';
const BASE_ORDERS = { orders: [{
  unique_key: KEY, ordered: 1756000000, total: '8800', last_name: '平沢', first_name: '卓也',
  dispatch_status: 'ordered',
  order_items: [{ item_id: '111', title: 'イノシシ ロース 500g', amount: 1, price: '4400', status: 'unpaid', order_item_id: 'oi1' }]
}] };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let shipPosts = [];

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
    if (/\/products/.test(u)) return J([{ id: 'p1', name: 'イノシシ ロース 500g', stock_qty: 5, base_item_id: '111' }]);
    return J([]);
  });
  await page.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  page.on('dialog', d => d.accept());

  const results = [];
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(700);
  await page.evaluate(async () => { if (typeof loadBaseOrders === 'function') await loadBaseOrders(); });
  await page.waitForTimeout(500);

  // 1) 各BASE注文カードに送料の入力欄が出る
  const fields = await page.evaluate(k => ({
    track: !!document.getElementById('base-track-' + k),
    carrier: !!document.getElementById('base-carrier-' + k),
    size: !!document.getElementById('base-size-' + k),
    cool: !!document.getElementById('base-cool-' + k),
    freight: !!document.getElementById('base-freight-' + k),
    coolDefault: document.getElementById('base-cool-' + k)?.checked,
    sizeDefault: document.getElementById('base-size-' + k)?.value
  }), KEY);
  results.push(['送り状番号の欄がある', fields.track, '']);
  results.push(['運送会社の欄がある', fields.carrier, '']);
  results.push(['サイズの欄がある', fields.size, '']);
  results.push(['クール便の欄がある', fields.cool, '']);
  results.push(['送料の欄がある', fields.freight, '']);
  results.push(['既定はクール便ON・100サイズ', fields.coolDefault === true && fields.sizeDefault === '100', `cool=${fields.coolDefault} size=${fields.sizeDefault}`]);

  // 2) 発送処理で4項目が出荷に保存される
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
  results.push(['送料を保存', sp.freight === 1320, String(sp.freight)]);
  results.push(['送り状番号はメモに残る', /1234-5678/.test(String(sp.notes || '')), String(sp.notes)]);

  // 3) 送料が空でも発送処理は通る（記録されないだけ）
  shipPosts = [];
  await page.evaluate(async () => { if (typeof loadBaseOrders === 'function') await loadBaseOrders(); });
  await page.waitForTimeout(400);
  await page.evaluate(async k => {
    document.getElementById('base-freight-' + k).value = '';
    await baseOrderShip(k);
  }, KEY);
  await page.waitForTimeout(600);
  const sp2 = shipPosts[shipPosts.length - 1] || {};
  results.push(['送料未入力でも出荷は記録', !!sp2.order_id, String(sp2.order_id)]);
  results.push(['送料未入力なら送料は入らない', sp2.freight === undefined, String(sp2.freight)]);

  results.push(['pageerrorなし', errors.length === 0, errors.join(' / ')]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' && got != null ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
