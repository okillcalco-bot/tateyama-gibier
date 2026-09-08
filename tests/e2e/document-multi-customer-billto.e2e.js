// 書類発行（order-admin.html「書類発行」タブ）：複数顧客の注文を1枚の書類にまとめて発行する
//
//   きっかけ（2026-09-08）
//     仲卸業者（例：ノブレスオブリージュ）へ納品書・請求書を発行したいが、実際の注文は
//     卸先の個別の店舗名義で記録されているため、複数の顧客の出荷分を1枚の書類にまとめ、
//     宛名だけ仲卸業者にできるようにした。
//     仲卸業者自身は自社の注文を持たない（=発送実績が無い）ことが多いため、
//     「請求先（宛名）」は発送実績の有無に関わらず全顧客から選べるようにしている。
//
//   ここで測ること
//     1. 単一顧客の選択（従来どおり）: 宛名は自動でその顧客になり、品名に顧客タグは付かない
//     2. 複数顧客の注文を選び、請求先を指定しないと止まる（アラートが出て発行されない）
//     3. 請求先を指定すれば、複数顧客の明細が1枚にまとまり、宛名は請求先、
//        品名に元の顧客名がタグとして付き、金額は全注文の合算になる
//     4. 発行記録（documents POST）は、全ての元注文にひもづきつつ customer_id は請求先になる
//     5. 請求先セレクトには、発送実績が無い顧客（仲卸業者）も候補に出る
//     6. 備考検索（2026-09-08追加）: 顧客の絞り込み（Ctrl+クリックの複数選択）が非効率という指摘を受け、
//        顧客IDは卸先の実店舗のまま、備考欄のキーワードで一覧を絞り込めるようにした
//        （customer_idを請求先に付け替えると、請求先自身の顧客ポータルに他店の注文明細が漏れるため不採用）
//     7. 税の二重計上防止（2026-09-08追加）: order_items.amountは税込（顧客ポータルの
//        portal_issue_document関数にも明記）なのに、invCalcLines()は明細を税抜として
//        税率を上乗せするため、そのまま渡すと肉の分だけ二重課税になっていた不具合を修正。
//        税込金額を税抜相当に変換してから渡すことで、合計が元の税込合計と一致するようにした
//     7. フォーマット統一（2026-09-08追加）: 発行元・宛名・書式が請求書作成タブ（invRenderPrint）と
//        バラバラだった（宛名の住所・印鑑が古い決め打ち文言のまま）という指摘を受け、
//        書類発行タブもinvRenderPrint（新しいウィンドウでの印刷プレビュー）を共用するようにした
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const dialogs = [];
  page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss(); });

  const CUST_A = { id: 'cust-a', code: 'C0001', name: 'A店', address: '千葉県A市', is_active: true };
  const CUST_B = { id: 'cust-b', code: 'C0002', name: 'B店', address: '千葉県B市', is_active: true };
  const CUST_W = { id: 'cust-w', code: 'C0731', name: 'ノブレスオブリージュ', address: '東京都W区', is_active: true }; // 仲卸業者・自身の注文は無い

  const mkOrder = (id, cust, orderCode, item, date, memo) => ({
    id, customer_id: cust.id, customer_name: cust.name, order_code: orderCode,
    order_date: date || '2026-09-01', delivery_date: date || '2026-09-01', status: '発送済', total_amount: item.subtotal,
    order_items: [item], memo: memo || null,
  });
  // A店の注文だけ備考に「ノブレスオブリージュ」を記録（実運用: 卸先の店舗名義のまま、備考で請求先グループを検索できるようにする運用）
  const ORDER_A = mkOrder('ord-a', CUST_A, 'ORD-A001', { id: 'ia', species: 'イノシシ', part_name: 'モモ', weight_kg: 4, unit_price: 2500, subtotal: 10000 }, null, 'ノブレスオブリージュ');
  // Bだけ日付をずらし、備考の自動生成が「日付ごとに行を分けて並べる」ことも確認する（備考なし＝備考検索の対象外になることも確認）
  const ORDER_B = mkOrder('ord-b', CUST_B, 'ORD-B001', { id: 'ib', species: 'イノシシ', part_name: 'ロース', weight_kg: 2, unit_price: 2500, subtotal: 5000 }, '2026-09-02');

  const postedDocuments = [];
  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = x => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m === 'POST' && /\/documents\b/.test(url)) {
      let body = []; try { body = JSON.parse(req.postData() || '[]'); } catch (e) {}
      postedDocuments.push(...(Array.isArray(body) ? body : [body]));
      return J(body.map((b, i) => Object.assign({ id: 'doc-' + Date.now() + '-' + i }, b)));
    }
    if (m !== 'GET') return J([]);
    if (/\/customers\b/.test(url)) return J([CUST_A, CUST_B, CUST_W]);
    if (/\/documents\b/.test(url)) return J([]);
    if (/\/orders\b/.test(url) && /order_items/.test(url)) return J([ORDER_A, ORDER_B]);
    if (/\/orders\b/.test(url)) return J([]);
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));

  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(600);
  await page.evaluate(() => switchTab('documents'));
  await page.waitForTimeout(300);

  const results = [];
  const ck = (name, cond, got) => results.push([name, cond, got]);

  // 6) 備考検索: 卸先の店舗名義のまま、備考のキーワードで一覧を絞り込める
  let listText = await page.$eval('#docOrderList', el => el.textContent);
  ck('備考検索前: A店・B店の両方が一覧に出る', listText.includes('A店') && listText.includes('B店'), listText);
  await page.fill('#docMemoSearch', 'ノブレスオブリージュ');
  await page.waitForTimeout(150);
  listText = await page.$eval('#docOrderList', el => el.textContent);
  ck('備考検索後: 備考に一致するA店だけが残る', listText.includes('A店') && !listText.includes('B店'), listText);
  await page.fill('#docMemoSearch', '');
  await page.waitForTimeout(150);
  listText = await page.$eval('#docOrderList', el => el.textContent);
  ck('備考検索クリア後: 元通りA店・B店の両方が出る', listText.includes('A店') && listText.includes('B店'), listText);

  // 5) 請求先は検索式（入力→datalist候補）。発送実績の無いノブレスオブリージュも候補に出て、入力するとidに解決される
  const billToOptions = await page.$$eval('#docBillToList option', os => os.map(o => o.value));
  ck('請求先候補(datalist)に仲卸業者(ノブレスオブリージュ)が出る', billToOptions.some(t => t.includes('ノブレスオブリージュ')), billToOptions.join(','));
  await page.fill('#docBillToInput', 'ノブレスオブリージュ');
  await page.dispatchEvent('#docBillToInput', 'input');
  ck('請求先に店名を入力するとidに解決される', await page.$eval('#docBillTo', el => el.value) === 'cust-w', await page.$eval('#docBillTo', el => el.value));
  await page.fill('#docBillToInput', '');
  await page.dispatchEvent('#docBillToInput', 'input');
  ck('請求先を空にするとidも空に戻る', await page.$eval('#docBillTo', el => el.value) === '', await page.$eval('#docBillTo', el => el.value));
  // 絞り込み用の顧客セレクトには、発送実績の無い顧客は出ない
  const custFilterOptions = await page.$$eval('#docCustomer option', os => os.map(o => o.textContent));
  ck('絞り込み用セレクトには発送実績のある顧客のみ出る', custFilterOptions.some(t => t.includes('A店')) && custFilterOptions.some(t => t.includes('B店')) && !custFilterOptions.some(t => t.includes('ノブレスオブリージュ')), custFilterOptions.join(','));

  // ── 1) 単一顧客（A店のみ）: 従来どおり自動で宛名になる。品名に顧客タグは付かない ──
  dialogs.length = 0; // 初期化中に出た「スタッフキー」等の無関係なダイアログを除外
  await page.evaluate(() => { document.querySelectorAll('#docOrderList input[type=checkbox]').forEach(cb => cb.checked = (cb.dataset.oid === 'ord-a')); });
  let [popup1] = await Promise.all([
    page.waitForEvent('popup'),
    page.evaluate(() => generateDoc('納品書')),
  ]);
  await popup1.waitForLoadState();
  let previewHtml = await popup1.content();
  ck('単一顧客: プレビューに宛名(A店)が出る', previewHtml.includes('A店'), previewHtml.slice(0, 500));
  ck('単一顧客: 品名に顧客タグ[A店]は付かない', !previewHtml.includes('[A店]'), previewHtml);
  ck('単一顧客: 出荷内訳（備考）は出ない', !previewHtml.includes('出荷内訳'), '');
  let doc1 = postedDocuments.find(d => d.order_id === 'ord-a');
  ck('単一顧客: documentsのcustomer_idはA店本人', !!doc1 && doc1.customer_id === 'cust-a', JSON.stringify(doc1));
  ck('単一顧客: アラートは出ない', dialogs.length === 0, dialogs.join(' / '));
  await popup1.close();

  // ── 2) 複数顧客(A+B)・請求先未指定 → 止まる（ポップアップは開かない） ──
  postedDocuments.length = 0; dialogs.length = 0;
  await page.evaluate(() => { document.getElementById('docBillTo').value = ''; });
  await page.evaluate(() => { document.querySelectorAll('#docOrderList input[type=checkbox]').forEach(cb => cb.checked = true); });
  await page.evaluate(() => generateDoc('請求書'));
  await page.waitForTimeout(150);
  ck('複数顧客・請求先未指定: アラートで止まる', dialogs.some(m => m.includes('請求先')), dialogs.join(' / '));
  ck('複数顧客・請求先未指定: documentsは送信されない', postedDocuments.length === 0, JSON.stringify(postedDocuments));

  // ── 3),4) 複数顧客(A+B)・請求先=ノブレスオブリージュ（検索入力から選ぶ） ──
  dialogs.length = 0;
  await page.fill('#docBillToInput', 'C0731 ノブレスオブリージュ');
  await page.dispatchEvent('#docBillToInput', 'input');
  const [popup2] = await Promise.all([
    page.waitForEvent('popup'),
    page.evaluate(() => generateDoc('請求書')),
  ]);
  await popup2.waitForLoadState();
  previewHtml = await popup2.content();
  ck('複数顧客+請求先: アラートは出ない', dialogs.length === 0, dialogs.join(' / '));
  ck('複数顧客+請求先: 宛名はノブレスオブリージュ', previewHtml.includes('ノブレスオブリージュ'), previewHtml.slice(0, 500));
  ck('複数顧客+請求先: 品名にA店・B店のタグが付く', previewHtml.includes('[A店]') && previewHtml.includes('[B店]'), previewHtml);
  // order_items.amount(A:10,000 B:5,000)は税込のため、税抜相当に変換してから8%を計算し直す
  // （そのまま税抜扱いすると二重課税になるため。詳細はconsolidateItemsForBillingの呼び出し元を参照）
  // 変換・丸めの結果、合計はほぼ15,000円（税込の元の合計）に戻る
  ck('複数顧客+請求先: 合計金額が約15,000円（税込の二重計上なし）', /15,00[01]/.test(previewHtml), previewHtml.slice(0, 800));

  ck('複数顧客+請求先: documentsが2件（A・B双方の注文にひもづく）', postedDocuments.length === 2, JSON.stringify(postedDocuments));
  ck('複数顧客+請求先: 両方ともcustomer_idは請求先(cust-w)', postedDocuments.every(d => d.customer_id === 'cust-w'), JSON.stringify(postedDocuments));
  ck('複数顧客+請求先: order_idはそれぞれ元の注文のまま', new Set(postedDocuments.map(d => d.order_id)).size === 2
    && postedDocuments.some(d => d.order_id === 'ord-a') && postedDocuments.some(d => d.order_id === 'ord-b'), JSON.stringify(postedDocuments));
  const savedTotal = postedDocuments.find(d => d.order_id === 'ord-a')?.total_amount;
  ck('複数顧客+請求先: 保存されるtotal_amountも約15,000円（元の税込合計と一致・二重課税なし）', savedTotal >= 14990 && savedTotal <= 15010, String(savedTotal));

  // 備考（出荷内訳）: 「いつ・どこへ・何を送ったか」が日付ごとに自動で書かれる
  ck('複数顧客+請求先: 出荷内訳の見出しが出る', previewHtml.includes('出荷内訳'), '');
  ck('複数顧客+請求先: 9/1にA店の内訳が出る', previewHtml.includes('9/1 A店（イノシシ　モモ　4kg）'), previewHtml);
  ck('複数顧客+請求先: 9/2にB店の内訳が出る', previewHtml.includes('9/2 B店（イノシシ　ロース　2kg）'), previewHtml);
  ck('複数顧客+請求先: 日付順（9/1が9/2より前）に並ぶ', previewHtml.indexOf('9/1 A店') < previewHtml.indexOf('9/2 B店'), '');
  const doc0 = postedDocuments.find(d => d.order_id === 'ord-a');
  ck('複数顧客+請求先: documentsの1件目にmemoとして備考が保存される', !!doc0 && doc0.memo && doc0.memo.includes('9/1 A店') && doc0.memo.includes('9/2 B店'), JSON.stringify(doc0));
  await popup2.close();

  ck('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
