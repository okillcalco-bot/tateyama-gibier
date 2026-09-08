// 注文一覧（order-admin.html「注文一覧」タブ）：列見出しクリックで並べ替え
//
//   きっかけ（2026-09-08）
//     「注文一覧にソート機能が欲しい。日付がバラバラで二重入力もあるかもしれないので」
//     という指摘。見出しをクリックすると昇順・降順に並べ替えられるようにした。
//
//   ここで測ること
//     1. 「納品希望日」見出しをクリックすると納品日の昇順に並ぶ
//     2. もう一度クリックすると降順に切り替わる
//     3. 「顧客名」見出しをクリックすると顧客名の五十音（コードポイント）順に並ぶ
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { await d.dismiss(); });

  const ORDERS = [
    { id: 'o1', order_code: 'ORD-C', customer_name: 'C店', delivery_date: '2026-08-15', status: '受注', total_amount: 3000, order_items: [] },
    { id: 'o2', order_code: 'ORD-A', customer_name: 'A店', delivery_date: '2026-08-01', status: '受注', total_amount: 1000, order_items: [] },
    { id: 'o3', order_code: 'ORD-B', customer_name: 'B店', delivery_date: '2026-08-10', status: '受注', total_amount: 2000, order_items: [] },
  ];

  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = x => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m !== 'GET') return J([]);
    if (/\/orders\b/.test(url) && /order_items/.test(url)) return J(ORDERS);
    if (/\/orders\b/.test(url)) return J([]);
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));

  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(600);

  const results = [];
  const ck = (name, cond, got) => results.push([name, cond, got]);

  const orderCodes = async () => page.$$eval('#ordersBody tr td:first-child', els => els.map(e => e.textContent.trim()));

  // 初期表示（並べ替え無し・作成順）
  let codes = await orderCodes();
  ck('初期表示は3件出る', codes.length === 3, JSON.stringify(codes));

  // 1) 納品希望日を昇順に
  await page.click('th:has-text("納品希望日")');
  await page.waitForTimeout(100);
  codes = await orderCodes();
  ck('納品希望日クリックで昇順（ORD-A, ORD-B, ORD-C）に並ぶ', JSON.stringify(codes) === JSON.stringify(['ORD-A', 'ORD-B', 'ORD-C']), JSON.stringify(codes));
  let icon = await page.$eval('#sortIcon-delivery_date', el => el.textContent);
  ck('昇順の矢印(▲)が出る', icon.includes('▲'), icon);

  // 2) もう一度クリックで降順に
  await page.click('th:has-text("納品希望日")');
  await page.waitForTimeout(100);
  codes = await orderCodes();
  ck('もう一度クリックで降順（ORD-C, ORD-B, ORD-A）に並ぶ', JSON.stringify(codes) === JSON.stringify(['ORD-C', 'ORD-B', 'ORD-A']), JSON.stringify(codes));
  icon = await page.$eval('#sortIcon-delivery_date', el => el.textContent);
  ck('降順の矢印(▼)が出る', icon.includes('▼'), icon);

  // 3) 顧客名で並べ替え（昇順）
  await page.click('th:has-text("顧客名")');
  await page.waitForTimeout(100);
  codes = await orderCodes();
  ck('顧客名クリックでA店→B店→C店の順に並ぶ', JSON.stringify(codes) === JSON.stringify(['ORD-A', 'ORD-B', 'ORD-C']), JSON.stringify(codes));
  // 納品希望日の矢印は消えている（別の列に切り替わったため）
  const dateIcon = await page.$eval('#sortIcon-delivery_date', el => el.textContent);
  ck('別列に切り替えたら元の列の矢印は消える', dateIcon.trim() === '', dateIcon);

  ck('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
