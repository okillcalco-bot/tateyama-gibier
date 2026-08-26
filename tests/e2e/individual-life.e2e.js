// 個体の一生：捕獲(生態)→検査→精肉→加工→とどけた先 を1枚でたどれる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const IND = [{
  id: 'i1', label_id: 'TGC-08-M167', species: 'イノシシ', sex: 'メス', weight_total: 42.5,
  capture_date: '2026-08-20', capture_time: '08:00', capture_city: '南房総市', capture_area: '和田',
  capture_method: 'くくり罠', hunter_name: '山﨑善夫', weather: '晴れ',
  is_juvenile: false, has_fetus: false,
  radiation_test_date: '2026-08-21', radiation_result_date: '2026-08-21', radiation_result: '検出下限値以下',
  capture_lat: null, capture_lng: null, body_length_cm: null, age_estimate: null, bait_type: null, capture_koaza: null
}];
const PARTS = [
  { id: 'v1', ident_code: 'TGC-08-M167-RO', part_name: 'ロース', weight: '2.10', weight_kg: '2.100', status: '在庫', tier: 2 },
  { id: 'v2', ident_code: 'TGC-08-M167-MU', part_name: 'ミンチ用', weight: '1.15', weight_kg: '1.150', status: '加工済', tier: 2 }
];
const LOGS = [
  { parent_ident_code: 'TGC-08-M167-MU', child_ident_code: 'TGC-MIB-20260826-001', weight: '1.15', process_type: 'ミンチ肉（粗挽き）', operator: '沖浩志' }
];
const PACKS = [
  { id: 'p1', ident_code: 'TGC-MI-20260826-001', individual_code: 'TGC-MIB-20260826-001', part_name: 'ミンチ肉（粗挽き）', process_type: 'ミンチ肉（粗挽き）', weight: '0.25', weight_kg: '0.250', status: '在庫' },
  { id: 'p2', ident_code: 'TGC-MI-20260826-002', individual_code: 'TGC-MIB-20260826-001', part_name: 'ミンチ肉（粗挽き）', process_type: 'ミンチ肉（粗挽き）', weight: '0.25', weight_kg: '0.250', status: '在庫' },
  { id: 'p3', ident_code: 'TGC-MI-20260826-003', individual_code: 'TGC-MIB-20260826-001', part_name: 'ミンチ肉（粗挽き）', process_type: 'ミンチ肉（粗挽き）', weight: '1', weight_kg: '1.000', status: '在庫' }
];
const ITEMS = [{ id: 'oi1', order_id: 'o1', inventory_id: 'v1', part_name: 'ロース', product_name: 'ロース', weight: '2.10', weight_kg: '2.100', unit_price: 5000, subtotal: 10500 }];
const ORDERS = [{ id: 'o1', order_code: 'ORD-1', order_date: '2026-08-25', status: '確定', customer_id: 'c1', customer_name: null, delivery_name: null }];
const CUSTS = [{ id: 'c1', name: 'エフユーアイジャパン', code: 'C0007' }];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));

  await page.route('**/*', route => {
    const u = route.request().url();
    if (u.includes('jsdelivr') || u.includes('cdn')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (!/\/rest\/v1\//.test(u)) { if (u.startsWith('file:')) return route.continue(); return route.fulfill({ status: 200, body: '[]' }); }
    const J = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/individuals/.test(u) && /label_id=eq\./.test(u)) return J(IND);
    if (/\/inventory/.test(u) && /individual_id=eq\./.test(u)) return J(PARTS);
    if (/\/processing_log/.test(u) && /individual_id=eq\./.test(u)) return J(LOGS);
    if (/\/inventory/.test(u) && /individual_code=in\./.test(u)) return J(PACKS);
    if (/\/order_items/.test(u) && /inventory_id=in\./.test(u)) return J(ITEMS);
    if (/\/orders/.test(u) && /id=in\./.test(u)) return J(ORDERS);
    if (/\/customers/.test(u) && /id=in\./.test(u)) return J(CUSTS);
    return J([]);
  });
  await page.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });

  const results = [];
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(700);

  await page.evaluate(async () => { await indLifeOpen('TGC-08-M167'); });
  await page.waitForTimeout(400);

  const shown = await page.$eval('#indLifeModal', el => el.style.display);
  results.push(['モーダルが開く', shown === 'block', shown]);
  const title = await page.$eval('#ind-life-title', el => el.textContent);
  results.push(['見出しに個体番号と獣種', /TGC-08-M167/.test(title) && /イノシシ/.test(title), title.trim()]);

  const t = await page.$eval('#ind-life-body', el => el.innerText);

  // ① いのち（生態）: 記録済みは値、空欄は「未記録」
  results.push(['生態: 場所・方法・捕獲者', /南房総市/.test(t) && /くくり罠/.test(t) && /山﨑善夫/.test(t), '']);
  results.push(['生態: 未入力は「未記録」表示', /未記録/.test(t), '']);
  results.push(['生態: 体重42.5kg', /42\.5 kg/.test(t), '']);

  // ② 検査
  results.push(['検査結果を表示', /検出下限値以下/.test(t), '']);

  // ③ 精肉（合計と体重比）
  results.push(['精肉2部位と合計3.25kg', /ロース/.test(t) && /ミンチ用/.test(t) && /3\.25kg/.test(t), '']);
  results.push(['体重比(歩留まり)を計算', /体重比 7\.6%/.test(t), (t.match(/体重比 [\d.]+%/) || [''])[0]]);

  // ④ 加工（バッチと規格集約）
  results.push(['加工バッチと規格集約', /TGC-MIB-20260826-001/.test(t) && /0\.25kg×2/.test(t) && /1kg×1/.test(t) && /計3パック/.test(t), '']);

  // ⑤ とどけた先（顧客名まで到達）
  results.push(['とどけた先に顧客名', /エフユーアイジャパン/.test(t), '']);

  // ⑥ 段階インジケータ
  const stageOn = await page.$$eval('#ind-life-body', els => (els[0].innerText.match(/いのち|検査|精肉|加工|とどけた|こえ/g) || []).length);
  results.push(['6段階の見出しが揃う', stageOn >= 6, String(stageOn)]);

  // 販売が無い個体でも壊れない
  await page.route('**/rest/v1/order_items**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.evaluate(async () => { await indLifeOpen('TGC-08-M167'); });
  await page.waitForTimeout(300);
  const t2 = await page.$eval('#ind-life-body', el => el.innerText);
  results.push(['販売なしでも表示できる', /まだ販売の記録がひも付いていません/.test(t2), '']);

  results.push(['pageerrorなし', errors.length === 0, errors.join(' / ')]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' && got != null ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
