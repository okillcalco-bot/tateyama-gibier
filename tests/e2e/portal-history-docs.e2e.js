// 顧客ポータル: 注文履歴・納品状況＋請求書/領収書の出力・再発行表示のスモーク
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const CUSTOMER = [{ name: 'エース商店', honorific: '様' }];
const ORDERS = [{
  id: 'o1', order_code: 'DIR-20260821-001', status: '発送済',
  order_date: '2026-08-20', delivery_date: '2026-08-22', delivery_time_zone: '0812',
  total_amount: 6000, memo: null, created_at: '2026-08-20T00:00:00Z',
  can_doc: true, receipt_issued: 0, freight: 1300,
  items: [{ name: 'イノシシ ロース', species: 'イノシシ', kg: 1.2, unit_price: 5000, amount: 6000 }],
  shipments: [{ shipment_date: '2026-08-21', delivery_date: '2026-08-22', status: '出荷済', notes: '送り状番号: 1234-5678', carrier: 'ヤマト', size_code: 100, is_cool: true, freight: 1300 }]
}, {
  id: 'o2', order_code: 'ORD-2', status: '受注',
  order_date: '2026-08-23', delivery_date: '2026-08-25', total_amount: 0,
  created_at: '2026-08-23T00:00:00Z', can_doc: false, receipt_issued: 0,
  items: [{ name: 'シカ モモ', species: 'シカ', kg: 1, unit_price: 3000, amount: 3000 }], shipments: []
}];
const RECEIPT = {
  doc_type: '領収書', doc_number: 'RCP-DIR-20260821-001', reissue: false, copy_no: 1,
  issue_date: '2026-08-24', order_code: 'DIR-20260821-001', delivery_date: '2026-08-22',
  customer: { name: 'エース商店', honorific: '様', address: '千葉県館山市1-1' },
  items: [{ name: 'イノシシ ロース', qty: 1.2, unit_price: 5000, subtotal: 6000 }],
  total: 6000, freight: 1300, freight_carrier: 'ヤマト',
  issuer: { issuer_name: '合同会社アルコ', postal: '294-0014', address: '館山市山本1-3', tel: '0470-29-3919', reg_number: 'T1234567890123', bank: '千葉銀行 館山支店 普通 1234567' }
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  // 一般の rest は空配列（後から登録する rpc ルートが優先される）
  await page.route('**/rest/v1/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/rest/v1/rpc/**', route => {
    const url = route.request().url();
    const fn = url.split('/rpc/')[1].split('?')[0];
    let body;
    if (fn === 'portal_login_v2') body = [{ status: 'ok', token: 'T', must_change: false, name: 'エース商店', honorific: '様' }];
    else if (fn === 'portal_me') body = CUSTOMER;
    else if (fn === 'portal_my_orders') body = ORDERS;
    else if (fn === 'portal_issue_document') body = RECEIPT;
    else body = [];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  const results = [];
  await page.goto('file://' + path.resolve(__dirname, '../../order.html'));
  await page.waitForTimeout(400);
  // ログイン（UIフロー）
  await page.fill('#lg-id', 'C0001');
  await page.fill('#lg-pw', 'password');
  await page.click('#lg-btn');
  await page.waitForTimeout(500);
  results.push(['list画面が表示', !(await page.$eval('#scr-list', el => el.classList.contains('hidden'))), '']);
  // 注文履歴ボタン
  await page.click('button:has-text("注文履歴")');
  await page.waitForTimeout(400);
  results.push(['history画面が表示', !(await page.$eval('#scr-history', el => el.classList.contains('hidden'))), '']);

  const cards = await page.$$eval('#hist-rows .hcard', els => els.length);
  results.push(['注文カードが2件', cards === 2, cards]);
  // 納品情報（送り状番号）表示
  const shipTxt = await page.$eval('#hist-rows', el => el.innerText);
  results.push(['発送日・送り状番号を表示', /発送 2026年8月21日/.test(shipTxt) && /1234-5678/.test(shipTxt), '']);
  results.push(['納品情報に配送(ヤマト100サイズ)・送料税込1430', /ヤマト・100サイズ・クール/.test(shipTxt) && /送料 ¥1,430/.test(shipTxt), '']);
  // can_doc=false の注文には帳票ボタンが無い（ボタンは o1 の2つだけ）
  const nBtns = await page.$$eval('#hist-rows .hbtns button', els => els.length);
  results.push(['帳票ボタンは発送済のみ2つ', nBtns === 2, nBtns]);

  // 領収書を発行 → 別ウィンドウ（popup）
  const [popup] = await Promise.all([
    ctx.waitForEvent('page'),
    page.click('#hist-rows .hcard:first-child button:has-text("領収書")')
  ]);
  await popup.waitForTimeout(500);
  const docText = await popup.evaluate(() => document.body.innerText);
  results.push(['領収書ウィンドウに「領収書」', /領収書/.test(docText), '']);
  results.push(['領収文を表示', /上記金額を正に領収いたしました/.test(docText), '']);
  results.push(['但し書き「お品代として」', /お品代として/.test(docText), '']);
  results.push(['発行元（社内設定）を流用', /合同会社アルコ/.test(docText) && /登録番号: T1234567890123/.test(docText), '']);
  results.push(['商品8%対象6000を表示', /6,000/.test(docText) && /8%/.test(docText), '']);
  results.push(['送料行（ヤマト）を表示', /送料（ヤマト）/.test(docText) && /1,430/.test(docText), '']);
  results.push(['送料10%対象を表示', /10%/.test(docText), '']);
  results.push(['総合計7430（商品6000＋送料税込1430）', /7,430/.test(docText), '']);
  await popup.close();

  // 領収書発行後、ボタンが「（再発行）」に変わる
  await page.waitForTimeout(200);
  const relabel = await page.$eval('#hist-rows .hcard:first-child', el => el.innerText);
  results.push(['2回目は「再発行」表示に', /領収書（再発行）/.test(relabel), '']);

  results.push(['pageerrorなし', errors.length === 0, errors.join(' / ')]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
