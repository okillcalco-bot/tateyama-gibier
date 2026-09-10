// 書類発行（order-admin.html「書類発行」タブ）: 顧客の絞り込みセレクトに検索と期間連動を追加
//
//   きっかけ（2026-09-10）
//     「ここにも検索あった方がいいのと、そもそも表示するのは期間設定した時に
//     出荷データがある顧客だけ表示するようにして」との指摘。従来は「発送実績が
//     一度でもある顧客」を全期間から出していたため、期間を変えても候補が
//     減らず、件数が多いと目当ての顧客を探しにくかった。
//
//   ここで測ること
//     1. 顧客セレクトに検索欄があり、入力すると候補が絞り込まれる
//     2. 選んだ期間（今月/先月/カスタム）に出荷実績が無い顧客は候補に出ない
//     3. 期間を切り替えると候補も切り替わる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { await d.dismiss(); });

  const CUST_A = { id: 'cust-a', code: 'C0001', name: 'A店', address: '千葉県A市', is_active: true };
  const CUST_B = { id: 'cust-b', code: 'C0002', name: 'B店', address: '千葉県B市', is_active: true };
  const CUST_C = { id: 'cust-c', code: 'C0003', name: 'カフェC', address: '千葉県C市', is_active: true };

  const mkOrder = (id, cust, code, date) => ({
    id, customer_id: cust.id, customer_name: cust.name, order_code: code,
    order_date: date, delivery_date: date, status: '発送済', total_amount: 1000,
    order_items: [{ id: id + '-i', species: 'イノシシ', part_name: 'モモ', weight_kg: 1, unit_price: 1000, subtotal: 1000 }],
  });
  // A店: 今月(9月)に出荷実績あり。B店: 先月(8月)のみ。カフェC: 出荷実績なし
  const ORDERS = [
    mkOrder('ord-a', CUST_A, 'ORD-A001', '2026-09-05'),
    mkOrder('ord-b', CUST_B, 'ORD-B001', '2026-08-15'),
  ];

  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = x => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m !== 'GET') return J([]);
    if (/\/customers\b/.test(url)) return J([CUST_A, CUST_B, CUST_C]);
    if (/\/orders\b/.test(url) && /order_items/.test(url)) return J(ORDERS);
    if (/\/orders\b/.test(url)) return J([]);
    if (/\/documents\b/.test(url)) return J([]);
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));

  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(600);
  await page.evaluate(() => switchTab('documents'));
  await page.waitForTimeout(300);

  const results = [];
  const ck = (name, cond, got) => results.push([name, cond, got]);

  ck('検索欄がある', await page.$('#docCustomerSearch') !== null, '');

  const optionTexts = async () => page.$$eval('#docCustomer option', os => os.map(o => o.textContent));

  // ① 既定は「今月」。今月(9月)に出荷実績があるA店だけ出る（B店は先月のみ・カフェCは実績なし）
  let opts = await optionTexts();
  ck('今月はA店だけ候補に出る', opts.some(t => t.includes('A店')) && !opts.some(t => t.includes('B店')) && !opts.some(t => t.includes('カフェC')), JSON.stringify(opts));

  // ② 「先月」に切り替えるとB店だけになる
  await page.selectOption('#docPeriod', 'lastMonth');
  await page.waitForTimeout(200);
  opts = await optionTexts();
  ck('先月に切り替えるとB店だけ候補に出る', opts.some(t => t.includes('B店')) && !opts.some(t => t.includes('A店')), JSON.stringify(opts));

  // ③ 「今年度」に戻せば両方出る（絞り込みが効いていること自体の確認）
  await page.selectOption('#docPeriod', 'thisYear');
  await page.waitForTimeout(200);
  opts = await optionTexts();
  ck('今年度なら両方出る', opts.some(t => t.includes('A店')) && opts.some(t => t.includes('B店')), JSON.stringify(opts));

  // ④ 検索欄でA店だけに絞り込める
  await page.fill('#docCustomerSearch', 'A店');
  await page.waitForTimeout(100);
  opts = await optionTexts();
  ck('検索欄「A店」で絞り込むとA店だけになる', opts.length === 1 && opts[0].includes('A店'), JSON.stringify(opts));

  await page.fill('#docCustomerSearch', '');
  await page.waitForTimeout(100);
  opts = await optionTexts();
  ck('検索欄を空にすると両方戻る', opts.some(t => t.includes('A店')) && opts.some(t => t.includes('B店')), JSON.stringify(opts));

  ck('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
