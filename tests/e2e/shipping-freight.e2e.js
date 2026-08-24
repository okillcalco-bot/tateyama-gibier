// 出荷確定の配送情報UI（業者/サイズ/クール）と運賃計算ヘルパーのスモーク
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let lastFreightReq = null;

  // rpc/tgc_compute_freight は送信引数を記録して固定値を返す（住所→千葉100クール=1300想定）
  await page.route('**/rest/v1/**', route => {
    const url = route.request().url();
    if (/\/rpc\/tgc_compute_freight/.test(url)) {
      try { lastFreightReq = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      return route.fulfill({ status: 200, contentType: 'application/json', body: '1300' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.addInitScript(() => { try { localStorage.setItem('tg_staff_key', 'TESTKEY'); } catch (e) {} });

  const results = [];
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(700);

  // 配送セレクタが存在する
  const hasUI = await page.evaluate(() =>
    !!document.getElementById('ship-carrier') && !!document.getElementById('ship-size') && !!document.getElementById('ship-cool'));
  results.push(['配送UI（業者/サイズ/クール）が存在', hasUI, '']);

  // 既定値：ヤマト・100・クールON
  const opts = await page.evaluate(() => shipDeliveryOpts());
  results.push(['既定はヤマト/100/クールON', opts.carrier === 'ヤマト' && opts.size === 100 && opts.cool === true, JSON.stringify(opts)]);

  // shipComputeFreight が RPC を正しい引数で呼び、値を返す
  const freight = await page.evaluate(() => shipComputeFreight('千葉県館山市西長田1163-5', { carrier: 'ヤマト', size: 100, cool: true }));
  results.push(['運賃計算が値を返す（1300）', freight === 1300, freight]);
  results.push(['RPC引数が正しい', lastFreightReq && lastFreightReq.p_carrier === 'ヤマト' && lastFreightReq.p_size === 100 && lastFreightReq.p_is_cool === true && /千葉県/.test(lastFreightReq.p_address || ''), JSON.stringify(lastFreightReq)]);

  // 住所なしは null（RPCを呼ばない）
  const nullFreight = await page.evaluate(() => shipComputeFreight('', { carrier: 'ヤマト', size: 100, cool: true }));
  results.push(['住所なしは null', nullFreight === null, nullFreight]);

  // プレビュー表示（注文未選択時の案内）
  await page.evaluate(() => { window.shipSelectedOrderId = null; return shipFreightPreview(); });
  await page.waitForTimeout(100);
  const prev = await page.$eval('#ship-freight-preview', el => el.textContent);
  results.push(['未選択時のプレビュー案内', /注文を選ぶと/.test(prev), prev]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
