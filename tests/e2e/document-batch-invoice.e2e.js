// 書類発行（order-admin.html「書類発行」タブ）: 未発行の請求書を1件ずつ処理
//
//   きっかけ（2026-09-10）
//     「請求書発行してない顧客に対して、1回1回選択してpdfにするのは面倒だから、
//     個別にファイル名付けて吐き出せるようにして欲しいのと、その際に
//     『先月の請求書をお送りします』ってメッセージ文も出せるようにして」との要望。
//     ブラウザの仕様上、開いたページから勝手にファイル保存はできないため、
//     1人ずつ印刷プレビューを開く方式にした（プレビューのタイトル＝PDF保存時の
//     既定ファイル名は既存のinvRenderPrint()がすでに顧客名入りで設定している）。
//     メッセージ文は顧客ごとにLINE等へ貼り付けられるようコピーボタン付きで出す。
//
//   ここで測ること
//     1. 今の絞り込みの中で「請求書」未発行の顧客だけがキューに入る
//        （発行済みの顧客・請求書以外の書類だけ出ている顧客は除く）
//     2. 顧客ごとにメッセージ文（期間ラベル入り）が表示される
//     3. 「発行してプレビューを開く」で実際に発行され（documents保存＋印刷プレビュー）、
//        ボタンが「発行済み」に変わる
//     4. 「次へ」で次の顧客に進み、最後まで行くとパネルが閉じる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { await d.dismiss(); });

  const CUST_A = { id: 'cust-a', code: 'C0001', name: 'A店', address: '千葉県A市', is_active: true };
  const CUST_B = { id: 'cust-b', code: 'C0002', name: 'B店', address: '千葉県B市', is_active: true };
  const CUST_C = { id: 'cust-c', code: 'C0003', name: 'C店', address: '千葉県C市', is_active: true };

  const mkOrder = (id, cust, code, amount) => ({
    id, customer_id: cust.id, customer_name: cust.name, order_code: code,
    order_date: '2026-08-15', delivery_date: '2026-08-15', status: '発送済', total_amount: amount,
    order_items: [{ id: id + '-i', species: 'イノシシ', part_name: 'モモ', weight_kg: 1, unit_price: amount, subtotal: amount }],
  });
  const ORDERS = [
    mkOrder('ord-a', CUST_A, 'ORD-A001', 5000),
    mkOrder('ord-b', CUST_B, 'ORD-B001', 3000),
    mkOrder('ord-c', CUST_C, 'ORD-C001', 2000),
  ];
  // B店は既に請求書発行済み、C店は納品書のみ発行済み（請求書はまだ）
  const DOCS = [
    { order_id: 'ord-b', doc_type: '請求書' },
    { order_id: 'ord-c', doc_type: '納品書' },
  ];

  const postedDocs = [];
  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = x => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m === 'POST' && /\/documents\b/.test(url)) { const b = JSON.parse(req.postData() || '[]'); postedDocs.push(...(Array.isArray(b) ? b : [b])); return J(b, 201); }
    if (m !== 'GET') return J([]);
    if (/\/customers\b/.test(url)) return J([CUST_A, CUST_B, CUST_C]);
    if (/\/orders\b/.test(url) && /order_items/.test(url)) return J(ORDERS);
    if (/\/orders\b/.test(url)) return J([]);
    if (/\/documents\b/.test(url)) return J(DOCS);
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));

  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(600);
  await page.evaluate(() => switchTab('documents'));
  await page.evaluate(() => { document.getElementById('docPeriod').value = 'lastMonth'; });
  await page.evaluate(() => { populateDocCustomerDropdown(); loadDocOrders(); });
  await page.waitForTimeout(400);

  const results = [];
  const ck = (name, cond, got) => results.push([name, cond, got]);

  // ① キューにはA店だけが入る（B店は請求書発行済み、C店は納品書だけで請求書は未発行→C店も入るはず）
  const queue = await page.evaluate(() => docBatchQueue().map(q => q.customerName));
  ck('請求書が未発行のA店・C店だけキューに入る', queue.includes('A店') && queue.includes('C店') && !queue.includes('B店'), JSON.stringify(queue));

  await page.evaluate(() => docBatchStart());
  await page.waitForTimeout(200);

  ck('パネルが開く', await page.$eval('#docBatchModal', el => el.style.display) === 'flex', '');
  ck('進捗表示が出る（1 / 2件）', (await page.$eval('#docBatchProgress', el => el.textContent)).includes('1 / 2'), await page.$eval('#docBatchProgress', el => el.textContent));

  const firstName = await page.$eval('#docBatchCustomer', el => el.textContent);
  ck('1人目の顧客名が表示される（A店かC店）', firstName === 'A店' || firstName === 'C店', firstName);

  const msg = await page.$eval('#docBatchMsg', el => el.value);
  ck('メッセージ文に期間ラベル「先月」が入る', msg.includes('先月の請求書をお送りします'), msg);
  ck('メッセージ文に顧客名が入る', msg.includes(firstName + '様'), msg);

  // ③ 発行してプレビューを開く
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.click('#docBatchIssueBtn'),
  ]);
  await popup.waitForLoadState();
  ck('documentsに請求書が保存される', postedDocs.some(d => d.doc_type === '請求書'), JSON.stringify(postedDocs));
  ck('発行ボタンが「発行済み」に変わる', (await page.$eval('#docBatchIssueBtn', el => el.textContent)).includes('発行済み'), await page.$eval('#docBatchIssueBtn', el => el.textContent));
  await popup.close();

  // ④ 次へ進むと2人目、さらに次へで最後まで行くとパネルが閉じる
  await page.click('button:has-text("次へ")');
  await page.waitForTimeout(100);
  ck('進捗表示が2 / 2件になる', (await page.$eval('#docBatchProgress', el => el.textContent)).includes('2 / 2'), await page.$eval('#docBatchProgress', el => el.textContent));

  await page.click('button:has-text("次へ")');
  await page.waitForTimeout(100);
  ck('最後まで進むとパネルが閉じる', await page.$eval('#docBatchModal', el => el.style.display) === 'none', await page.$eval('#docBatchModal', el => el.style.display));

  ck('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
