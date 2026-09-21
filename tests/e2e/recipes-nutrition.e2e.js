// 料理・レシピタブ（栄養成分の自動計算・商品との紐づけ・栄養成分表示ラベル）2026-09-21
//
//   きっかけ 「加工調理とは別タブで料理タブを作って、レシピを蓄積できるようにしたい。その際に添付の栄養成分も
//   自動で計算して、商品と紐づけできるようにして。将来的にはそこからラベルも出せるようにしたい。」
//
//   ここで測ること（計算は大阪市「栄養算」と同じ: 100gあたり × g ÷ 100 の合計、人数で割って1人分）
//     1. ナビに「料理・レシピ」タブがあり、?tab=recipes で開く。成分表の食品数が出る
//     2. 登録済みの料理カードに 100gあたりの5項目と紐づけ商品名が出る
//     3. 食品検索: 「いのしし」で ○ の食品が先に出て、選ぶと材料に入る
//     4. 計算: いのしし200g＋しょうゆ20g → 合計 513kcal／1人分（2人）257／100gあたり 233、食塩相当量 100gあたり 1.4
//        出来上がり重量 180g を入れると 100gあたり 285 に変わる
//     5. 商品を選ぶと商品名の「200g」から1袋の内容量が入り、1袋あたり列（570kcal）が出る
//     6. 保存: recipes に nutrition（per100g・原材料名を重量順）が付いて POST、recipe_items は入れ替え
//     7. 栄養成分表示: 5項目・原材料名・内容量・製造者。40×60mm ラベルの HTML が用紙内（57mm以内）に収まる
//     8. 追加食品: 食塩相当量だけ入れるとナトリウムを換算して POST（番号は 19002）
//     9. 加工調理の商品カードに紐づいた料理が出る
//    10. 成分表が読めないときは赤で画面に出る（サイレント失敗なし）
//    11. マニュアルに ⑬ がある
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

// 成分表のモック（本物は58成分×2,538食品。ここでは検算に要る列だけ、値は八訂の実値に近いもの）
const KEYS = [['廃棄率', '%'], ['エネルギー', 'kcal'], ['水分', 'g'], ['たんぱく質', 'g'], ['たんぱく質\n（En計算に使用している値）', 'g'], ['脂質', 'g'], ['脂質\n（En計算に使用している値）', 'g'],
  ['炭水化物\n(利用可能炭水化物)\n（En計算に使用している値）', 'g'], ['炭水化物', 'g'], ['食物繊維総量', 'g'], ['ﾅﾄﾘｳﾑ', 'mg'], ['ｶﾘｳﾑ', 'mg'], ['鉄', 'mg'], ['ビタミン\nB1', 'mg'], ['食塩相当量', 'g']];
const F = (no, g, n, c, k, a, v) => ({ no, g, n, c, k, a, ak: '', b: '', bk: '', v });
const FOODS = [
  F(11001, 11, 'いのしし・肉・脂身つき・生', 0, 'いのしし・にく・あぶらみつき・なま', 'ぼたん肉', [0, 249, 60.1, 18.8, 16.7, 19.8, 18.6, 0.5, 0.5, 0, 45, 270, 2.5, 0.24, 0.1]),
  F(11002, 11, 'いのぶた・肉・脂身つき・生', 1, 'いのぶた・にく・あぶらみつき・なま', '', [0, 275, 56.7, 18.1, 16.0, 24.1, 22.5, 0.3, 0.3, 0, 50, 280, 0.8, 0.62, 0.1]),
  F(17007, 17, 'しょうゆ・こいくちしょうゆ', 1, 'しょうゆ・こいくちしょうゆ', '', [0, 76, 67.1, 7.7, 6.1, 0, 0, 7.9, 7.9, 0, 5700, 390, 1.7, 0.05, 14.5]),
  F(3003, 3, '砂糖・上白糖', 1, 'さとう・じょうはくとう', '', [0, 391, 0.7, 0, 0, 0, 0, 99.3, 99.3, 0, 1, 2, 0, 0, 0]),
];
const DB = { source: 'test', keys: KEYS, groups: { '3': '砂糖及び甘味類', '11': '肉類', '17': '調味料及び香辛料類' }, foods: FOODS };
const PRODUCTS = [{ id: 'p1', name: '味付け肉 みそ 200g', category: '小売', unit: '袋', price: 1000, stock_qty: 2, memo: '' }, { id: 'p2', name: 'イノシシ ミンチ 250g', category: '小売', unit: '袋', price: 1000, stock_qty: 4, memo: '' }];
const RECIPES = [{ id: 'r1', name: 'つくね（試作）', category: '味付けミンチ', servings: 4, yield_g: 400, product_id: 'p2', pack_g: 250, steps: null, memo: null, created_by: '吉田友美',
  nutrition: { per100g: { 'エネルギー': 210.4, 'たんぱく質': 15.2, '脂質': 14.1, '炭水化物': 6.3, '食塩相当量': 1.2 }, per_pack: { 'エネルギー': 526.3, 'たんぱく質': 38, '脂質': 35.3, '炭水化物': 15.8, '食塩相当量': 3 }, pack_g: 250, yield_g: 400, sum_g: 440, servings: 4, ingredients: ['いのしし肉', 'しょうゆ', '砂糖'] } }];
const ITEMS = [{ id: 'i1', recipe_id: 'r1', food_no: 11001, food_name: 'いのしし・肉・脂身つき・生', grams: 400, note: null, sort: 0 }, { id: 'i2', recipe_id: 'r1', food_no: 17007, food_name: 'しょうゆ・こいくちしょうゆ', grams: 30, note: null, sort: 1 }, { id: 'i3', recipe_id: 'r1', food_no: 3003, food_name: '砂糖・上白糖', grams: 10, note: null, sort: 2 }];
const CUSTOM = [{ id: 'c1', food_no: 19001, name: '焼肉のたれ（甘口）', kana: 'やきにくのたれ', nutrients: { 'エネルギー': 150, 'たんぱく質': 2.5, '脂質': 0.5, '炭水化物': 33, 'ナトリウム': 2900, '食塩相当量': 7.4 }, memo: '', deleted_at: null }];

async function open(browser, { query = '?tab=recipes', failDb = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await ctx.addInitScript(() => { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  const calls = [];
  await page.route('**/*', rt => {
    const u = decodeURIComponent(rt.request().url()), m = rt.request().method();
    if (/food-composition-8th\.json/.test(u)) return failDb ? rt.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' }) : rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(DB) });
    if (u.startsWith('file:')) return rt.continue();
    if (/cdnjs|jsdelivr|fonts\./.test(u)) return rt.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    const J = x => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m !== 'GET') { let b = null; try { b = JSON.parse(rt.request().postData() || 'null'); } catch (e) {} calls.push({ m, u, b });
      if (/\/recipes(\?|$)/.test(u) && m === 'POST') return J([{ id: 'r-new', ...b }]);
      return J(Array.isArray(b) ? b : [b]); }
    if (/\/rest\/v1\/recipes\b/.test(u)) return J(/product_id=not\.is\.null/.test(u) ? RECIPES.filter(r => r.product_id) : RECIPES);
    if (/\/rest\/v1\/recipe_items/.test(u)) return J(ITEMS);
    if (/\/rest\/v1\/recipe_foods/.test(u)) return J(CUSTOM);
    if (/\/rest\/v1\/products/.test(u)) return J(PRODUCTS);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html') + query);
  await page.waitForTimeout(1000);
  return { page, errors, calls };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = []; const ck = (n, c, g) => results.push([n, c, g]);
  const { page, errors, calls } = await open(browser);

  const ui = await page.evaluate(() => ({ nav: (document.querySelector('.tab-btn[data-tab="recipes"]') || {}).textContent, active: document.getElementById('panel-recipes').classList.contains('active'),
    status: document.getElementById('rc-status').textContent, count: document.getElementById('rc-count').textContent, cards: [...document.querySelectorAll('#rc-grid .rc-card')].map(c => c.textContent.replace(/\s+/g, ' ')) }));
  ck('ナビに「料理・レシピ（栄養成分）」があり ?tab=recipes で開く', /料理・レシピ/.test(ui.nav || '') && ui.active, ui.nav);
  ck('成分表の食品数と追加食品の件数が出る', /成分表 4食品/.test(ui.status) && /追加食品 1件/.test(ui.status), ui.status);
  ck('登録済みの料理カード: 100gあたり 5項目と紐づけ商品名', ui.cards.length === 1 && /210kcal/.test(ui.cards[0].replace(/\s/g, '')) && /1\.2g/.test(ui.cards[0]) && /イノシシ ミンチ 250g/.test(ui.cards[0]) && /1件の料理（商品と紐づき 1件）/.test(ui.count), ui.cards[0]);

  // 新規登録 → 検索 → 材料 → 計算
  await page.evaluate(() => rcOpenNew());
  await page.fill('#rc-f-name', '味付け肉 みそ（テスト）');
  await page.fill('#rc-f-servings', '2');
  await page.fill('#rc-food-q', 'いのしし');
  await page.waitForTimeout(150);
  const hits = await page.evaluate(() => [...document.querySelectorAll('#rc-food-results .rc-hit')].map(h => h.textContent.replace(/\s+/g, ' ')));
  ck('「いのしし」で検索: 別名ぼたん肉も含めて出る', hits.length >= 1 && hits.some(h => /いのしし・肉・脂身つき・生/.test(h) && /ぼたん肉/.test(h)), hits.join(' | '));
  await page.evaluate(() => rcAddFood(11001));
  await page.fill('#rc-items input[data-f="grams"]', '200');
  await page.evaluate(() => rcAddFood(17007));
  await page.fill('#rc-items tr:nth-child(2) input[data-f="grams"]', '20');
  await page.waitForTimeout(100);
  const calc1 = await page.evaluate(() => ({ text: document.getElementById('rc-calc').textContent.replace(/\s+/g, ' '), c: rcEdit.calc }));
  const kcal = calc1.c.totals[1], kcal100 = calc1.c.per100[1], kcalServ = calc1.c.perServ[1], salt100 = calc1.c.per100[14];
  ck('合計 = 249×2 + 76×0.2 = 513.2kcal、材料合計 220g', Math.abs(kcal - 513.2) < 0.01 && calc1.c.sumG === 220, String(kcal));
  ck('1人分（2人）= 256.6kcal、100gあたり = 513.2÷220×100 = 233.3kcal', Math.abs(kcalServ - 256.6) < 0.01 && Math.abs(kcal100 - 233.27) < 0.01, JSON.stringify([kcalServ, kcal100]));
  ck('食塩相当量 100gあたり = (0.1×2 + 14.5×0.2)÷220×100 = 1.41g', Math.abs(salt100 - 1.409) < 0.01, String(salt100));
  ck('画面の表: 合計 513／1人分 257／100gあたり 233（栄養算と同じ丸め）', /材料合計 220g/.test(calc1.text) && /513/.test(calc1.text) && /257/.test(calc1.text) && /233/.test(calc1.text), calc1.text.slice(0, 200));

  await page.fill('#rc-f-yield_g', '180');
  await page.waitForTimeout(100);
  const calc2 = await page.evaluate(() => rcEdit.calc);
  ck('出来上がり重量 180g → 100gあたり = 513.2÷180×100 = 285.1kcal', Math.abs(calc2.per100[1] - 285.11) < 0.01 && calc2.yieldG === 180, String(calc2.per100[1]));

  await page.selectOption('#rc-f-product_id', 'p1');
  await page.waitForTimeout(100);
  const calc3 = await page.evaluate(() => ({ pack: document.getElementById('rc-f-pack_g').value, c: rcEdit.calc, text: document.getElementById('rc-calc').textContent.replace(/\s+/g, ' ') }));
  ck('商品「味付け肉 みそ 200g」を選ぶと 1袋の内容量 200 が入り、1袋あたり 570kcal の列が出る', calc3.pack === '200' && calc3.c.perPack && Math.abs(calc3.c.perPack[1] - 570.22) < 0.01 && /1袋（200g）/.test(calc3.text) && /570/.test(calc3.text), JSON.stringify([calc3.pack, calc3.c.perPack && calc3.c.perPack[1]]));

  // 栄養算の表示値（En計算値）と全成分
  await page.check('#rc-show-en'); await page.check('#rc-show-all'); await page.waitForTimeout(100);
  const calc4 = await page.evaluate(() => document.getElementById('rc-calc').textContent.replace(/\s+/g, ' '));
  ck('「栄養算の表示値」「ビタミン・ミネラル」を出すと En計算値・ナトリウム・鉄・ビタミンB1 の行が増える', /En計算値/.test(calc4) && /ナトリウム/.test(calc4) && /鉄/.test(calc4) && /ビタミンB1/.test(calc4), calc4.slice(0, 120));

  // 保存
  await page.fill('#rc-items tr:nth-child(2) input[data-f="note"]', 'しょうゆ（大豆・小麦を含む）');
  await page.evaluate(() => rcSave());
  await page.waitForTimeout(500);
  const post = calls.find(c => c.m === 'POST' && /\/recipes\b/.test(c.u));
  const del = calls.find(c => c.m === 'DELETE' && /recipe_items\?recipe_id=eq\.r-new/.test(c.u));
  const items = calls.find(c => c.m === 'POST' && /recipe_items/.test(c.u));
  ck('保存: recipes に POST（名前・2人分・出来上がり180g・商品p1・1袋200g）', post && post.b.name === '味付け肉 みそ（テスト）' && post.b.servings === 2 && post.b.yield_g === 180 && post.b.product_id === 'p1' && post.b.pack_g === 200, JSON.stringify(post && post.b).slice(0, 200));
  ck('保存: nutrition に 100gあたり 285.1kcal・1袋 570.2kcal・原材料名は重量順（いのしし肉、しょうゆのメモ名）', post && Math.abs(post.b.nutrition.per100g['エネルギー'] - 285.111) < 0.01 && Math.abs(post.b.nutrition.per_pack['エネルギー'] - 570.222) < 0.01 && post.b.nutrition.ingredients.join(',') === 'いのしし肉,しょうゆ（大豆・小麦を含む）', post && JSON.stringify(post.b.nutrition.ingredients));
  ck('保存: 材料は DELETE → POST で入れ替え（2行・food_no と grams）', del && items && items.b.length === 2 && items.b[0].food_no === 11001 && items.b[0].grams === 200 && items.b[1].grams === 20 && items.b.every(x => x.recipe_id === 'r-new'), JSON.stringify(items && items.b));
  ck('保存するとモーダルが閉じる', await page.evaluate(() => document.getElementById('recipeModal').style.display === 'none'), '');

  // 栄養成分表示・ラベル
  const printed = [];
  await page.evaluate(() => { window.pmPrintLabelHtml = html => { window.__printed = (window.__printed || []); window.__printed.push(html); }; });
  await page.evaluate(() => rcLabelOpen('r1'));
  await page.waitForTimeout(100);
  const lbl = await page.evaluate(() => document.getElementById('rc-lbl-body').textContent.replace(/\s+/g, ' '));
  ck('栄養成分表示: 1袋（250g）あたりの5項目、原材料名（重量順）、内容量、製造者', /1袋（250g）あたり/.test(lbl) && /エネルギー\s*526kcal/.test(lbl) && /食塩相当量\s*3\.0g/.test(lbl) && /原材料名 いのしし肉、しょうゆ、砂糖/.test(lbl) && /内容量 250g/.test(lbl) && /合同会社アルコ/.test(lbl), lbl.slice(0, 220));
  ck('ラベルの決まり（30cm²以下は省略可・今の40×60は24cm²）を説明している', /30cm²以下/.test(lbl) && /24cm²/.test(lbl), '');
  await page.evaluate(() => rcLabelPrint('label'));
  await page.evaluate(() => rcLabelPrint('a4'));
  const html = await page.evaluate(() => window.__printed || []);
  ck('40×60mm ラベルと A4 の HTML が出る（@page 40mm 60mm ／ A4）', html.length === 2 && /size:40mm 60mm/.test(html[0]) && /size:A4/.test(html[1]) && /栄養成分表示/.test(html[0]) && /原材料名/.test(html[0]) && /イノシシ ミンチ 250g/.test(html[0]), String(html.length));
  // 40×60mm を実寸で描いて、印字できる 57mm 以内に収まるか測る
  const lp = await browser.newPage({ viewport: { width: 400, height: 600 } });
  await lp.setContent(html[0]);
  const mm = await lp.evaluate(() => { const px = n => n / 96 * 25.4; const els = [...document.body.children]; const bottom = Math.max(...els.map(e => e.getBoundingClientRect().bottom)); return { bottom: px(bottom), right: Math.max(...els.map(e => px(e.getBoundingClientRect().right))) }; });
  await lp.close();
  ck('40×60mm ラベル: 内容の下端が 57mm 以内・右端が 40mm 以内', mm.bottom <= 57 && mm.right <= 40.5, JSON.stringify(mm));

  // 追加食品
  await page.evaluate(() => rcFoodsOpen());
  const foodsRows = await page.evaluate(() => document.querySelectorAll('#rc-foods-body tr').length);
  await page.evaluate(() => rcFoodEdit(''));
  await page.fill('#rc-cf-name', '自家製みそだれ');
  await page.fill('#rc-cf-エネルギー', '180'); await page.fill('#rc-cf-たんぱく質', '4'); await page.fill('#rc-cf-脂質', '2'); await page.fill('#rc-cf-炭水化物', '34'); await page.fill('#rc-cf-食塩相当量', '1.5');
  await page.evaluate(() => rcFoodSave());
  await page.waitForTimeout(300);
  const cf = calls.find(c => c.m === 'POST' && /recipe_foods/.test(c.u));
  ck('追加食品: 一覧に1件、新規は 19002 で POST。食塩 1.5g → ナトリウム 591mg を換算', foodsRows === 1 && cf && cf.b.food_no === 19002 && cf.b.nutrients['食塩相当量'] === 1.5 && cf.b.nutrients['ナトリウム'] === 591, JSON.stringify(cf && cf.b));

  // 加工調理の商品カードに紐づけ（開いているモーダルを閉じてからタブを押す）
  await page.evaluate(() => ['rcFoodModal', 'rcLabelModal', 'recipeModal'].forEach(id => document.getElementById(id).style.display = 'none'));
  await page.click('.tab-btn[data-tab="products"]');
  await page.waitForTimeout(600);
  const note = await page.evaluate(() => { const c = document.querySelector('#products-grid [data-product-id="p2"] .rc-prod-note'); const o = document.querySelector('#products-grid [data-product-id="p1"] .rc-prod-note'); return { p2: c ? c.textContent : null, p1: !!o }; });
  ck('加工調理: 「イノシシ ミンチ 250g」のカードに 🍳 つくね（試作）と 100gあたりが出て、紐づけの無い商品には出ない', note.p2 && /つくね（試作）/.test(note.p2) && /210kcal/.test(note.p2.replace(/\s/g, '')) && !note.p1, note.p2);

  // マニュアル
  await page.click('.tab-btn[data-tab="manual"]');
  await page.waitForTimeout(300);
  const man = await page.evaluate(() => [...document.querySelectorAll('#manual-index > div')].some(d => /⑬ 料理・レシピ/.test(d.textContent)));
  ck('マニュアルに「⑬ 料理・レシピ（栄養成分の自動計算）」', man, '');
  ck('pageerrorなし', errors.length === 0, errors.join(' / '));
  await page.context().close();

  // 成分表が読めない
  const p2 = await open(browser, { failDb: true });
  const err = await p2.page.evaluate(() => document.getElementById('rc-grid').textContent);
  ck('成分表が読めないときは赤で「読み込めませんでした」と出る', /読み込めませんでした/.test(err) && /HTTP 500/.test(err), err.slice(0, 120));
  await p2.page.context().close();

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 240) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
