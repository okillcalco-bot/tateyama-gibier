// 書類発行（order-admin.html「書類発行」タブ）: 毛皮など重量を持たない品目は枚数で明細に出す
//
//   きっかけ（2026-09-10）
//     「VARIEDは毛皮の枚数（枚）で記載していたから、それを数えるようにして」との指摘。
//     毛皮はorder_items.weight_kg/weightが空欄のまま、顧客指定単価（例: 1枚500円）×枚数で
//     amountだけを記録している。consolidateItemsForBilling()はweight_kgを数量として使う
//     前提だったため、毛皮のような品目は数量0・単価は合計金額そのものという明細になり、
//     請求書に「毛皮 0kg」というおかしい行が出ていた（金額の合計自体はズレていなかったが、
//     数量・単価の内訳が実態と合わず見た目がおかしかった）。
//     重量が無い品目は、金額÷単価で枚数を逆算し、単位を「枚」にして明細に出すよう直した。
//
//   ここで測ること
//     1. 重量を持つ品目（通常の肉）は今までどおりkgで数量が出る
//     2. 重量を持たない品目（毛皮）は、金額÷単価から逆算した枚数と単位「枚」で出る
//        （合計3枚・単価500円・合計1,500円の毛皮2件をまとめて1行にした場合）
//     3. 明細の合計金額は元の金額と一致する（二重課税や取りこぼしが無い）
//     4. 出荷内訳（複数顧客まとめ請求時の備考）にも「◯枚」と出る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { await d.dismiss(); });

  const CUST = { id: 'cust-v', code: 'C0900', name: 'VARIED', address: '千葉県V市', is_active: true };
  const ORDER = {
    id: 'ord-v', customer_id: CUST.id, customer_name: CUST.name, order_code: 'DIR-V001',
    order_date: '2026-08-20', delivery_date: '2026-08-20', status: '発送済', total_amount: 2500,
    order_items: [
      // 毛皮2件（重量なし・顧客指定単価500円で金額だけ記録）→ 合わせて500+2000=2500円÷500円=5枚のはず
      { id: 'iv1', species: 'イノシシ', part_name: '毛皮', weight_kg: null, weight: null, unit_price: 500, amount: 500, subtotal: 500 },
      { id: 'iv2', species: 'イノシシ', part_name: '毛皮', weight_kg: null, weight: null, unit_price: 500, amount: 2000, subtotal: 2000 },
      // 比較用に通常の重量ベースの品目も1件入れる
      { id: 'iv3', species: 'イノシシ', part_name: 'モモ', weight_kg: 2, unit_price: 2500, amount: 5000, subtotal: 5000 },
    ],
  };

  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = x => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m === 'POST' && /\/documents\b/.test(url)) { const b = JSON.parse(req.postData() || '{}'); return J([Object.assign({ id: 'doc-1' }, b)], 201); }
    if (m === 'POST' && /\/document_orders\b/.test(url)) return J([], 201);
    if (m !== 'GET') return J([]);
    if (/\/customers\b/.test(url)) return J([CUST]);
    if (/\/documents\b/.test(url)) return J([]);
    if (/\/document_orders\b/.test(url)) return J([]);
    if (/\/orders\b/.test(url) && /order_items/.test(url)) return J([ORDER]);
    if (/\/orders\b/.test(url)) return J([]);
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));

  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(600);

  const results = [];
  const ck = (name, cond, got) => results.push([name, cond, got]);

  const consolidated = await page.evaluate(() => consolidateItemsForBilling([
    { species: 'イノシシ', part_name: '毛皮', weight_kg: null, unit_price: 500, amount: 500, subtotal: 500 },
    { species: 'イノシシ', part_name: '毛皮', weight_kg: null, unit_price: 500, amount: 2000, subtotal: 2000 },
    { species: 'イノシシ', part_name: 'モモ', weight_kg: 2, unit_price: 2500, amount: 5000, subtotal: 5000 },
  ]));
  const fur = consolidated.find(c => c.part_name.includes('毛皮'));
  const meat = consolidated.find(c => c.part_name.includes('モモ'));

  ck('毛皮2件が枚数で1行にまとまる（500+2000=2500円÷500円=5枚）', !!fur && fur.qty === 5 && fur.unit === '枚', JSON.stringify(fur));
  ck('毛皮の単価は500円のまま（合計2500円÷5枚）', fur && fur.unit_price === 500, JSON.stringify(fur));
  ck('毛皮の金額は合計2,500円で欠けない', fur && fur.amount === 2500, JSON.stringify(fur));
  ck('通常の重量品目（モモ）は従来どおりkgで出る', !!meat && meat.qty === 2 && meat.unit === 'kg', JSON.stringify(meat));

  // 書類発行タブで実際に請求書を発行し、明細と出荷内訳に「枚」と出ることを確認
  await page.evaluate(() => switchTab('documents'));
  await page.waitForTimeout(300);
  await page.evaluate(() => { document.querySelectorAll('#docOrderList input[type=checkbox]').forEach(cb => cb.checked = true); });
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.evaluate(() => generateDoc('請求書')),
  ]);
  await popup.waitForLoadState();
  const html = await popup.content();
  const furRow = html.slice(html.indexOf('毛皮'), html.indexOf('毛皮') + 400);
  ck('明細の毛皮行の数量セルが5', /<td class="num">5<\/td>/.test(furRow), furRow.replace(/\s+/g, ' '));
  ck('明細の毛皮行の単位セルが枚', /枚/.test(furRow), furRow.replace(/\s+/g, ' '));
  ck('「0kg」というおかしい表記は出ない', !/毛皮[\s\S]{0,200}?0<\/td>[\s\S]{0,50}?kg/.test(html), '');
  await popup.close();

  ck('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 250) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
