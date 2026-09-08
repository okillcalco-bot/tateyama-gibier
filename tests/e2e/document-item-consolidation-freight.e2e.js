// 書類発行（order-admin.html「書類発行」タブ）：明細の自動まとめ ＆ 送料の自動反映
//
//   きっかけ（2026-09-08）
//     ノブレスオブリージュ向けの請求書を作ったところ、
//       1. モモ（全体・ウチ・ソト・シンタマ）が精肉時の呼び分けのまま個別の明細行になっていた
//          （請求時にはモモの区分けは不要、という指摘）
//       2. 同じ部位が複数パックに分かれていた場合もそれぞれ別の明細行になっていた
//          （請求時には1行にまとめてほしい、という指摘）
//       3. 送料（shipments.freight）が発行書類の明細・合計にまったく反映されていなかった
//          （CLAUDE.mdに記載の既知の課題「送料が入っているのは0件」と同じ症状）
//     という3つの不具合が見つかったため、まとめて実測テストにする。
//
//   ここで測ること
//     1. モモ（全体/ウチ/ソト/シンタマ）は1つの「モモ」行にまとまり、重量・金額は合算される
//     2. 同じ品種・部位（例: ロース）の複数行も1行にまとまる
//     3. 送料（shipments.freight）が明細に「送料（クール◯◯）」として自動で追加され、合計にも反映される
//     4. 送料が0/未設定の注文では送料行が出ない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { await d.dismiss(); });

  const CUST_A = { id: 'cust-a', code: 'C0001', name: 'A店', address: '千葉県A市', is_active: true };

  // モモの部位違い3行 + ロースの重複2行 + 送料あり
  const ORDER_A = {
    id: 'ord-a', customer_id: CUST_A.id, customer_name: CUST_A.name, order_code: 'ORD-A001',
    order_date: '2026-09-01', delivery_date: '2026-09-01', status: '発送済', total_amount: 0,
    order_items: [
      { id: 'i1', species: 'イノシシ', part_name: 'モモ（全体）', weight_kg: 1.0, unit_price: 2600, subtotal: 2600 },
      { id: 'i2', species: 'イノシシ', part_name: 'モモ（ウチ）', weight_kg: 0.3, unit_price: 2600, subtotal: 780 },
      { id: 'i3', species: 'イノシシ', part_name: 'モモ（ソト）', weight_kg: 0.2, unit_price: 2600, subtotal: 520 },
      { id: 'i4', species: 'イノシシ', part_name: 'ロース', weight_kg: 1.0, unit_price: 3800, subtotal: 3800 },
      { id: 'i5', species: 'イノシシ', part_name: 'ロース', weight_kg: 0.5, unit_price: 3800, subtotal: 1900 },
    ],
    shipments: [{ freight: 1300, carrier: 'ヤマト', size_code: 100, is_cool: true }],
  };
  // 送料が0の注文（送料行が出ないことの確認用）
  const ORDER_B = {
    id: 'ord-b', customer_id: CUST_A.id, customer_name: CUST_A.name, order_code: 'ORD-B001',
    order_date: '2026-09-02', delivery_date: '2026-09-02', status: '発送済', total_amount: 1000,
    order_items: [{ id: 'i6', species: 'イノシシ', part_name: '内臓', weight_kg: 1.0, unit_price: 1000, subtotal: 1000 }],
    shipments: [{ freight: 0, carrier: 'ヤマト', size_code: 60, is_cool: true }],
  };

  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = x => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m !== 'GET') return J([]);
    if (/\/customers\b/.test(url)) return J([CUST_A]);
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

  await page.evaluate(() => { document.querySelectorAll('#docOrderList input[type=checkbox]').forEach(cb => cb.checked = (cb.dataset.oid === 'ord-a')); });
  const [popup1] = await Promise.all([
    page.waitForEvent('popup'),
    page.evaluate(() => generateDoc('請求書')),
  ]);
  await popup1.waitForLoadState();
  let previewHtml = await popup1.content();

  // 1) モモの部位違いが1行「モモ」にまとまる（1.0+0.3+0.2=1.5kg、2600*1.5=3900円）
  ck('モモの部位違いが1行にまとまる（部位名の細分けは出ない）', !previewHtml.includes('モモ（'), previewHtml);
  ck('モモの合算重量1.5kgが出る', previewHtml.includes('1.5'), previewHtml);
  ck('モモの合算金額3,900円が出る', /3,900/.test(previewHtml), previewHtml);

  // 2) ロースの重複行が1行にまとまる（1.0+0.5=1.5kg、3800*1.5=5700円）
  const rosuCount = (previewHtml.match(/ロース/g) || []).length;
  ck('ロースの行が1つだけにまとまる', rosuCount === 1, `ロースの出現回数=${rosuCount}`);
  ck('ロースの合算金額5,700円が出る', /5,700/.test(previewHtml), previewHtml);

  // 3) 送料が明細行として自動で入り、ラベルにサイズ・クールが出る
  ck('送料の明細行が出る（クール100）', previewHtml.includes('送料（クール100）'), previewHtml);
  ck('送料の金額1,300円が明細に出る', /1,300/.test(previewHtml), previewHtml);

  // 合計 = 肉(3900+5700=9600・8%)の税768 + 送料(1300・10%)の税130 = 小計10,900+税898 = 11,798
  ck('送料込みの合計金額11,798円が出る', /11,798/.test(previewHtml), previewHtml.slice(0, 3000));
  await popup1.close();

  // 4) 送料0の注文では送料行が出ない
  await page.evaluate(() => { document.querySelectorAll('#docOrderList input[type=checkbox]').forEach(cb => cb.checked = (cb.dataset.oid === 'ord-b')); });
  const [popup2] = await Promise.all([
    page.waitForEvent('popup'),
    page.evaluate(() => generateDoc('請求書')),
  ]);
  await popup2.waitForLoadState();
  previewHtml = await popup2.content();
  ck('送料0の注文では送料行が出ない', !previewHtml.includes('送料'), previewHtml);
  await popup2.close();

  ck('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 300) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
