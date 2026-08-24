// 手入力注文の商品選択：注文サイトと同じカタログ・価格パターン別価格・カート
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const CUSTOMERS = [{ id: 'c1', code: 'C0001', name: '植山', kana: 'うえやま', price_rank: 'local', is_active: true, search_aliases: [] }];
const CATALOG = [
  { id: 'p1', display_name: 'ロース', species: 'イノシシ', grade_label: '', sort_order: 10, mark: '◎', is_orderable: true, portal_visible: true, is_active: true, parts: [], prices: [{ price_rank: 'standard', unit_price: 5000 }, { price_rank: 'local', unit_price: 4000 }, { price_rank: 'startmember', unit_price: 3500 }] },
  { id: 'p2', display_name: 'モモ', species: 'シカ', grade_label: '', sort_order: 20, mark: '△', is_orderable: true, portal_visible: true, is_active: true, parts: [], prices: [{ price_rank: 'standard', unit_price: 3000 }, { price_rank: 'local', unit_price: 2500 }, { price_rank: 'startmember', unit_price: 2000 }] }
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));

  await page.route('**/rest/v1/**', route => {
    const url = route.request().url();
    if (/\/rpc\/admin_list_portal_products/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CATALOG) });
    if (/\/rpc\//.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    if (/\/customers/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CUSTOMERS) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.addInitScript(() => { try { localStorage.setItem('tg_staff_key', 'TESTKEY'); } catch (e) {} });

  const results = [];
  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(700);
  await page.evaluate(() => openManualOrder());
  await page.waitForTimeout(500);

  // 種別タブが両方（全リスト）
  const tabs = await page.$$eval('#moSpeciesTabs .product-tab', els => els.map(e => e.textContent));
  results.push(['種別タブにイノシシ・シカ', tabs.includes('イノシシ') && tabs.includes('シカ'), tabs.join(',')]);

  // 既定 standard：ロース ¥5,000/kg
  const std = await page.$eval('#moProductList', el => el.innerText);
  results.push(['standardでロース5,000/kg', /ロース/.test(std) && /5,000\/kg/.test(std), '']);

  // 価格パターンを local に変更 → ロース ¥4,000/kg
  await page.evaluate(() => { document.getElementById('moRank').value = 'local'; renderMoProducts(); });
  await page.waitForTimeout(150);
  const loc = await page.$eval('#moProductList', el => el.innerText);
  results.push(['localでロース4,000/kg', /4,000\/kg/.test(loc) && !/5,000\/kg/.test(loc), '']);

  // 顧客選択でその顧客のパターン(local)が自動反映
  await page.evaluate(() => { document.getElementById('moRank').value = 'standard'; renderMoProducts();
    document.getElementById('moCustomer').value = 'c1'; onMoCustomerChange(); });
  await page.waitForTimeout(150);
  const rankAfterCust = await page.$eval('#moRank', el => el.value);
  results.push(['顧客選択でlocalに切替', rankAfterCust === 'local', rankAfterCust]);

  // カート追加：local価格4,000 × 2kg = 8,000
  await page.evaluate(() => { document.getElementById('mow_p1').value = '2'; addToMoCart('p1'); });
  await page.waitForTimeout(150);
  const cart = await page.evaluate(() => moCart.map(c => ({ n: c.product_name, pid: c.product_id_v2, up: c.unit_price, sub: c.subtotal, rank: c.price_rank_applied })));
  results.push(['カートにlocal価格で追加', cart.length === 1 && cart[0].up === 4000 && cart[0].sub === 8000 && cart[0].pid === 'p1' && cart[0].rank === 'local', JSON.stringify(cart)]);

  results.push(['pageerrorなし', errors.length === 0, errors.join(' / ')]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
