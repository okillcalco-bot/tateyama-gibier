// イノシシの部位に肉ランク（並・上・極上）を明示する
//
//   きっかけ（2026-09-08）
//     「イノシシに関しては各部位のランクも書いて」という指摘。以前、にくひろ8/5の
//     モモが在庫では「極上」なのに「並」の単価で入っていた不具合を直した際、
//     ランク自体は画面のどこにも表示されておらず、誤りに気づきにくい状態だった。
//     請求書作成タブ（invPullApply）は既に並以外のランクを部位名に
//     「（極上）」のように付けて表示する慣習があったので、それに合わせた。
//
//   ここで測ること
//     1. 書類発行タブの請求書プレビューで、イノシシ・極上の部位には「（極上）」が付く
//     2. 同じプレビューで、イノシシ・並（ランク不明含む）の部位にはランク表記が付かない
//     3. 注文一覧「詳細」モーダルでも同様にランクが出る
//     4. イノシシ以外の品種（シカ等）にはランク表記の仕組みそのものが影響しない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { await d.dismiss(); });

  const CUST_A = { id: 'cust-a', code: 'C0001', name: 'A店', address: '千葉県A市', is_active: true };

  const ORDER = {
    id: 'ord-a', customer_id: CUST_A.id, customer_name: CUST_A.name, order_code: 'ORD-A001',
    order_date: '2026-09-01', delivery_date: '2026-09-01', status: '発送済', total_amount: 0,
    order_items: [
      // 在庫（inventory.grade）から極上と分かる部位
      { id: 'i1', species: 'イノシシ', part_name: 'モモ（ソト）', weight_kg: 1.0, unit_price: 3900, subtotal: 3900, inventory_id: 'inv-1', inventory: { grade: '極上' } },
      // grade_snapshotに記録された「上」
      { id: 'i2', species: 'イノシシ', part_name: 'ロース', weight_kg: 1.0, unit_price: 4750, subtotal: 4750, grade_snapshot: '上' },
      // 並（ランク表記は付かない）
      { id: 'i3', species: 'イノシシ', part_name: '肩ロース', weight_kg: 1.0, unit_price: 3100, subtotal: 3100, inventory_id: 'inv-3', inventory: { grade: '並' } },
      // ランク不明（在庫リンクなし・grade_snapshotなし）＝並と同様に無表記
      { id: 'i4', species: 'イノシシ', part_name: '内臓', weight_kg: 1.0, unit_price: 1000, subtotal: 1000 },
      // イノシシ以外はランクの仕組み自体が影響しない（gradeが入っていても無視される）
      { id: 'i5', species: 'シカ', part_name: 'モモ', weight_kg: 1.0, unit_price: 2600, subtotal: 2600, inventory_id: 'inv-5', inventory: { grade: '極上' } },
    ],
  };

  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = x => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m !== 'GET') return J([]);
    if (/\/customers\b/.test(url)) return J([CUST_A]);
    if (/\/documents\b/.test(url)) return J([]);
    if (/\/orders\b/.test(url) && /order_items/.test(url)) return J([ORDER]);
    if (/\/orders\b/.test(url)) return J([]);
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));

  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(600);

  const results = [];
  const ck = (name, cond, got) => results.push([name, cond, got]);

  // 3) 注文一覧「詳細」モーダル
  await page.evaluate(() => showOrderDetail('ord-a'));
  await page.waitForTimeout(150);
  const odHtml = await page.$eval('#odContent', el => el.innerHTML);
  ck('注文詳細: 在庫由来の極上に「（極上）」が付く（モモ（ソト）（極上）とは書かず、モモ（極上）に正規化）', odHtml.includes('モモ（極上）') && !odHtml.includes('モモ（ソト）'), odHtml);
  ck('注文詳細: grade_snapshot由来の「（上）」が付く', odHtml.includes('ロース（上）'), odHtml);
  ck('注文詳細: 並の部位にはランク表記が付かない', odHtml.includes('肩ロース') && !odHtml.includes('肩ロース（'), odHtml);
  ck('注文詳細: ランク不明の部位にもランク表記は付かない', odHtml.includes('内臓') && !odHtml.includes('内臓（'), odHtml);
  ck('注文詳細: イノシシ以外（シカ）はランクが入っていても表記されない', odHtml.includes('モモ') && !odHtml.includes('モモ（極上）\n') && !/シカ[^<]*（極上）/.test(odHtml), odHtml);

  // 1),2),4) 書類発行タブの請求書プレビュー
  await page.evaluate(() => switchTab('documents'));
  await page.waitForTimeout(300);
  await page.evaluate(() => { document.querySelectorAll('#docOrderList input[type=checkbox]').forEach(cb => cb.checked = true); });
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.evaluate(() => generateDoc('請求書')),
  ]);
  await popup.waitForLoadState();
  const docHtml = await popup.content();
  ck('請求書: 極上の部位に「（極上）」が付く', docHtml.includes('モモ（極上）'), docHtml.slice(0, 3000));
  ck('請求書: 上の部位に「（上）」が付く', docHtml.includes('ロース（上）'), docHtml.slice(0, 3000));
  ck('請求書: 並の部位にはランク表記が付かない', docHtml.includes('肩ロース') && !docHtml.includes('肩ロース（'), docHtml.slice(0, 3000));
  ck('請求書: シカにはランク表記が付かない（イノシシ限定）', !/シカ\s*モモ（極上）/.test(docHtml), docHtml.slice(0, 3000));
  await popup.close();

  ck('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 300) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
