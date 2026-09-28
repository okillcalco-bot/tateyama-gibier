// 道の駅の店頭在庫: 「期限切れ・廃棄」と「訂正」を記録できるようにする（2026-09-28）
//
//   きっかけ
//     委託販売先「金谷おふくろ」から、販売報告を間違えた（うま辛120g×2 と報告すべきところを
//     250g×2 と報告してしまった）が、先方の入力画面からは訂正できないとの相談があった。
//     また、賞味期限切れで廃棄した分を入力する場所が無く、実際の店舗在庫数とズレてしまう
//     とも指摘された。
//
//   ここで測ること
//     1. 「期限切れ・廃棄」を記録すると、店頭在庫だけ減り、センター在庫は変わらない
//        （すでにセンターから出た商品なので、センターへ戻ってくるわけではない）
//     2. 「訂正」は符号付きの数量を入力できる（＋で在庫を戻す・−でさらに減らす）
//     3. 「訂正」は理由（メモ）が無いと保存できない（履歴で追える必須項目）
//     4. 元の（間違った）記録は消さず、訂正はあくまで新しい行として追加される（削除しない）
//     5. 履歴を開くと、納品・販売・期限切れ・訂正がすべて時系列で見える
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());

  const OUTLET = { id: 'out-1', name: '金谷おふくろ', delivery_notes: null };
  const PROD_120 = { id: 'p120', name: '味付け肉 うま辛 120g', unit: '袋', stock_qty: 20, price: 500 };
  const PROD_250 = { id: 'p250', name: '味付け肉 うま辛 250g', unit: '袋', stock_qty: 20, price: 1000 };
  let movements = []; // 蓄積されたproduct_movements（POSTのたびに追加）
  let staffPatches = [];

  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = x => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m === 'GET' && /\/retail_outlets\b/.test(url)) return J([OUTLET]);
    if (m === 'GET' && /\/products\b/.test(url)) return J([PROD_120, PROD_250]);
    if (m === 'GET' && /\/staff\b/.test(url)) return J([{ name: 'テスト職員' }]);
    if (m === 'GET' && /\/product_movements\b/.test(url)) {
      if (/movement_type=eq\.店頭販売/.test(url)) return J([]); // 売れゆきサマリー用
      return J(movements.map(x => ({ ...x })));
    }
    if (m === 'POST' && /\/product_movements\b/.test(url)) {
      let body = []; try { body = JSON.parse(req.postData() || '[]'); } catch (e) {}
      const rows = Array.isArray(body) ? body : [body];
      movements.push(...rows);
      return J(rows.map((r, i) => ({ id: 'mv' + movements.length + '-' + i, ...r })));
    }
    if (m === 'PATCH' && /\/products\b/.test(url)) {
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
      staffPatches.push({ url, body });
      return J([{ ...body }]);
    }
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));

  await page.goto('file://' + path.resolve(__dirname, '../../outlet.html'));
  await page.waitForTimeout(600);

  const results = []; const ck = (n, c, g) => results.push([n, c, g]);

  // 道の駅を選ぶ
  await page.evaluate(() => pick('金谷おふくろ'));
  await page.waitForTimeout(200);

  // ── 1) センター在庫だけを見せる元の納品を先に1件入れておく（うま辛120g×5を納品済とする） ──
  movements = [{ product_id: 'p120', product_name: PROD_120.name, movement_type: '納品', qty: 5, staff_name: 'テスト職員', destination: '金谷おふくろ' }];
  await page.evaluate(() => load());
  await page.waitForTimeout(200);

  const stockBefore = await page.evaluate(() => stockMap['p120|金谷おふくろ'] || 0);
  ck('納品5個で店頭在庫が5になる', stockBefore === 5, String(stockBefore));

  // ── 2) 期限切れ・廃棄を2個記録 → 店頭在庫は減るが、センター在庫（products.stock_qty）は変わらない ──
  await page.evaluate(() => openForm('期限切れ'));
  await page.waitForTimeout(200);
  await page.selectOption('#f-staff', 'テスト職員');
  await page.fill('.f-qty[data-pid="p120"]', '2');
  await page.fill('#f-note', '賞味期限切れのため廃棄');
  await page.evaluate(() => saveForm());
  await page.waitForTimeout(200);

  const afterExpiry = movements.find(m => m.movement_type === '期限切れ');
  ck('期限切れが記録される（qty=2・メモ付き）', !!afterExpiry && Number(afterExpiry.qty) === 2 && afterExpiry.note === '賞味期限切れのため廃棄', JSON.stringify(afterExpiry));
  ck('期限切れではセンター在庫（products）を更新しない', staffPatches.length === 0, JSON.stringify(staffPatches));
  const stockAfterExpiry = await page.evaluate(() => stockMap['p120|金谷おふくろ'] || 0);
  ck('店頭在庫が5→3に減る', stockAfterExpiry === 3, String(stockAfterExpiry));

  // ── 3) 訂正なしでは保存できない（理由必須） ──
  await page.evaluate(() => openForm('訂正'));
  await page.waitForTimeout(200);
  await page.selectOption('#f-staff', 'テスト職員');
  await page.fill('.f-qty[data-pid="p120"]', '2');
  const movesBeforeBadSave = movements.length;
  await page.evaluate(() => saveForm());
  await page.waitForTimeout(150);
  ck('訂正: 理由が無いと保存されない', movements.length === movesBeforeBadSave, String(movements.length));

  // ── 4) 訂正: 間違えた120g×2を+2で戻し、正しい250g×2を-2で減らす。元の記録は消えない ──
  await page.fill('#f-note', 'うま辛120g×2 → 250g×2 の入力ミス');
  await page.fill('.f-qty[data-pid="p250"]', '-2');
  await page.evaluate(() => saveForm());
  await page.waitForTimeout(200);

  const corrections = movements.filter(m => m.movement_type === '訂正');
  ck('訂正が2行（+2 120g・-2 250g）記録される', corrections.length === 2, JSON.stringify(corrections));
  const corr120 = corrections.find(m => m.product_id === 'p120');
  const corr250 = corrections.find(m => m.product_id === 'p250');
  ck('120gの訂正は+2', !!corr120 && Number(corr120.qty) === 2, JSON.stringify(corr120));
  ck('250gの訂正は-2', !!corr250 && Number(corr250.qty) === -2, JSON.stringify(corr250));
  ck('訂正にも理由メモが入る', corrections.every(m => m.note === 'うま辛120g×2 → 250g×2 の入力ミス'), JSON.stringify(corrections));
  ck('元の期限切れ・納品の記録は消えずそのまま残る（削除しない）', movements.some(m => m.movement_type === '納品') && movements.some(m => m.movement_type === '期限切れ'), String(movements.length));

  const stockAfterCorrection120 = await page.evaluate(() => stockMap['p120|金谷おふくろ'] || 0);
  const stockAfterCorrection250 = await page.evaluate(() => stockMap['p250|金谷おふくろ'] || 0);
  ck('訂正後: 120gの店頭在庫が3→5に戻る', stockAfterCorrection120 === 5, String(stockAfterCorrection120));
  ck('訂正後: 250gの店頭在庫が0→-2になる（元々在庫が無いのに販売報告した分の是正）', stockAfterCorrection250 === -2, String(stockAfterCorrection250));

  // ── 5) 履歴を開くと、納品・期限切れ・訂正がすべて見える ──
  await page.evaluate(() => toggleHistory());
  await page.waitForTimeout(150);
  const historyText = await page.$eval('#history-body', el => el.innerText);
  ck('履歴に納品が見える', historyText.includes('納品'), historyText);
  ck('履歴に期限切れ・廃棄が見える', historyText.includes('期限切れ・廃棄'), historyText);
  ck('履歴に訂正が見える', historyText.includes('訂正'), historyText);
  ck('履歴に訂正の理由メモが見える', historyText.includes('入力ミス'), historyText);

  ck('ページエラーなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 250) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
