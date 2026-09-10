// 受発注管理（order-admin.html）：「出荷データ」タブ（一次データ）
//
//   きっかけ（2026-09-10）
//     「受発注管理で、注文一覧の前段で『出荷データ』が欲しい。一次データで
//     いつどこに何をどれくらい送ったかがわかるように。顧客検索もしやすく。」
//     という要望。shipments起点で、注文の状態やタブをまたがず
//     日付・顧客・内容・重量・送料・注文番号・ステータスを直接見られるようにした。
//
//   ここで測ること
//     1. タブバーの最初（注文一覧より前）に「出荷データ」があり、初期表示でそれが開く
//     2. 出荷日・顧客名・内容（品目＋重量）・合計重量・送料・注文番号・ステータスが出る
//     3. 顧客名・注文番号で検索できる
//     4. 見出しクリックで日付・顧客名・重量の並べ替えができる
//
//   追記（2026-09-10）
//     「出荷データは部位ごとの明細も知りたい。これだと分からない」という指摘。
//     内容欄が1行にtext-overflow:ellipsisで詰め込まれ、モモの複数梱包などが
//     「イノシシ モモ（全体）2.4kg、イノシシ モモ（全体）2.3…」のように
//     途中で切れてホバーしないと読めなかった。まずは請求書作成タブと同じ
//     consolidateItemsForBilling で部位ごとにまとめる形にした。
//
//   追記2（2026-09-10）
//     「出荷データに関しては、部位ごとにまとめる必要無くて、出荷した一次データの
//     全ての情報を知りたい。個体番号ごとの部位とその重量まで記載して」という
//     指摘で、上の部位まとめ方針を撤回。一次データなのでまとめずに
//     個体番号（inventory.individual_id）ごとに1明細1行で全部並べる。
//     5. 同じ部位の複数梱包もまとめず、個体番号つきでそれぞれ別行のまま見える
//     6. 各行に個体番号（例: TGC-08-T307）が出る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { await d.dismiss(); });

  const SHIPMENTS = [
    {
      id: 'sh-1', order_id: 'ord-1', shipment_date: '2026-09-08', delivery_date: '2026-09-08',
      status: '出荷済', freight: 1300, carrier: 'ヤマト',
      orders: {
        order_code: 'DIR-A001', customer_name: 'A店', customer_id: 'cust-a', order_date: '2026-09-08',
        order_items: [{ species: 'イノシシ', part_name: 'モモ', weight_kg: 4 }],
      },
    },
    {
      id: 'sh-2', order_id: 'ord-2', shipment_date: '2026-09-09', delivery_date: '2026-09-09',
      status: '準備中', freight: null, carrier: null,
      orders: {
        order_code: 'DIR-B001', customer_name: 'B店', customer_id: 'cust-b', order_date: '2026-09-09',
        order_items: [{ species: 'シカ', part_name: 'ロース', weight_kg: 2 }, { species: 'シカ', part_name: 'バラ', weight_kg: 1.5 }],
      },
    },
    {
      // 実例（2026-09-08 澄川精肉店）: 同じ部位の梱包が複数に分かれ、内容欄が
      // 「モモ（全体）2.4kg、モモ（全体）2.3…」のように途中で切れて読めなかった
      id: 'sh-3', order_id: 'ord-3', shipment_date: '2026-09-08', delivery_date: '2026-09-08',
      status: '出荷済', freight: 800, carrier: 'ヤマト',
      orders: {
        order_code: 'DIR-C001', customer_name: '澄川精肉店', customer_id: 'cust-c', order_date: '2026-09-08',
        order_items: [
          { species: 'イノシシ', part_name: 'モモ（全体）', weight_kg: 2.4, inventory: { individual_id: 'TGC-08-T307' } },
          { species: 'イノシシ', part_name: 'モモ（全体）', weight_kg: 2.3, inventory: { individual_id: 'TGC-08-T310' } },
          { species: 'イノシシ', part_name: 'モモ（ウチ）', weight_kg: 1.2, inventory: { individual_id: 'TGC-08-T307' } },
          { species: 'イノシシ', part_name: 'ロース', weight_kg: 5, inventory: { individual_id: 'TGC-08-T312' } },
        ],
      },
    },
  ];

  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = x => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m !== 'GET') return J([]);
    if (/\/shipments\b/.test(url)) return J(SHIPMENTS);
    if (/\/orders\b/.test(url)) return J([]);
    if (/\/customers\b/.test(url)) return J([]);
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));

  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(600);

  const results = [];
  const ck = (name, cond, got) => results.push([name, cond, got]);

  // 1) 初期表示で出荷データタブが開いている
  ck('出荷データタブが初期表示でactive', await page.$eval('#tab-shipdata', el => el.classList.contains('active')), '');
  ck('出荷データタブボタンがactive', await page.$eval('.tab[data-tab="shipdata"]', el => el.classList.contains('active')), '');
  ck('注文一覧タブは初期表示でactiveでない', !(await page.$eval('#tab-orders', el => el.classList.contains('active'))), '');

  // 2) 内容が正しく出る
  let bodyText = await page.$eval('#shipDataBody', el => el.textContent);
  ck('A店・出荷日・内容・送料が出る', bodyText.includes('A店') && bodyText.includes('2026-09-08') && bodyText.includes('イノシシ') && bodyText.includes('モモ') && bodyText.includes('1,300'), bodyText);
  ck('B店・複数品目の合計重量(3.50kg)が出る', bodyText.includes('B店') && bodyText.includes('3.50kg'), bodyText);
  ck('送料未設定は「未設定」と出る', bodyText.includes('未設定'), '');
  ck('注文番号が出る', bodyText.includes('DIR-A001') && bodyText.includes('DIR-B001'), '');
  ck('ステータスが出る', bodyText.includes('出荷済') && bodyText.includes('準備中'), '');

  // 2b) 一次データなので部位ごとにまとめず、個体番号つきで全件別行のまま見える（澄川精肉店の実例）
  const sumiRow = await page.$$eval('#shipDataBody tr', trs =>
    trs.find(tr => tr.textContent.includes('澄川精肉店'))?.outerHTML || '');
  ck('モモ（全体）2.4kgがTGC-08-T307つきで出る（まとめない）', /TGC-08-T307　イノシシ モモ（全体）　2\.4kg/.test(sumiRow), sumiRow);
  ck('同じ部位でも別個体(TGC-08-T310)のモモ2.3kgは別行のまま', /TGC-08-T310　イノシシ モモ（全体）　2\.3kg/.test(sumiRow), sumiRow);
  ck('モモ（ウチ）1.2kgも部位名のまま（モモに丸められない）', /TGC-08-T307　イノシシ モモ（ウチ）　1\.2kg/.test(sumiRow), sumiRow);
  ck('ロース(TGC-08-T312)も省略されずに別行で見える', /TGC-08-T312　イノシシ ロース　5kg/.test(sumiRow), sumiRow);
  ck('「…」で途中省略されない', !sumiRow.includes('…'), sumiRow);

  // 3) 顧客名・注文番号で検索できる
  await page.fill('#shipDataSearch', 'A店');
  await page.waitForTimeout(100);
  bodyText = await page.$eval('#shipDataBody', el => el.textContent);
  ck('顧客名検索: A店だけになる', bodyText.includes('A店') && !bodyText.includes('B店'), bodyText);
  await page.fill('#shipDataSearch', 'DIR-B001');
  await page.waitForTimeout(100);
  bodyText = await page.$eval('#shipDataBody', el => el.textContent);
  ck('注文番号検索: B店だけになる', bodyText.includes('B店') && !bodyText.includes('A店'), bodyText);
  await page.fill('#shipDataSearch', '');
  await page.waitForTimeout(100);

  // 4) 並べ替え（出荷日クリックで昇順→9/8の2件(A店・澄川精肉店)が先、もう一度で降順→9/9のB店が先）
  await page.click('th:has-text("出荷日")');
  await page.waitForTimeout(100);
  let names = await page.$$eval('#shipDataBody tr td:nth-child(2)', els => els.map(e => e.textContent.trim()));
  ck('出荷日クリックで昇順（A店・澄川精肉店が先、B店が最後）', JSON.stringify(names) === JSON.stringify(['A店', '澄川精肉店', 'B店']), JSON.stringify(names));
  await page.click('th:has-text("出荷日")');
  await page.waitForTimeout(100);
  names = await page.$$eval('#shipDataBody tr td:nth-child(2)', els => els.map(e => e.textContent.trim()));
  ck('もう一度クリックで降順（B店が先）', names[0] === 'B店', JSON.stringify(names));

  ck('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
