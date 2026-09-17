// 公的データ解析（public-analysis.html）：県・市・国の公表値（public_stats）× うちのデータ
//   「公的データで解析できそうなことについては、データが重くならないなら全部やってみて」（2026-09-17）
//   1. 13項目が全部出て、実データで出せた／一部／未着手 の印がつく
//   2. 搬入率＝センター搬入 ÷ 市の有害捕獲。地区別で「市の捕獲が多いのに搬入率が低い地区」が出る
//   3. 被害額×前年の捕獲の相関、高齢化率×捕獲者の「途切れる候補」、上位10人の割合、放射能の検出件数、相場×販売単価 が数字で出る
//   4. うちのデータの一部（注文など）が読めなくても他の解析は出て、読めなかったことが画面に出る。public_stats が読めなければエラーが出る
//   5. グラフの CDN が無くても簡易バーで出る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const PS = [];
const add = (dataset, o) => PS.push(Object.assign({ dataset, fiscal_year: null, cal_year: null, month: null, city: null, area: null, category: null, metric: '', value: null, unit: null }, o));
const MO = [4,5,6,7,8,9,10,11,12,1,2,3];
// 館山市 市内捕獲状況: R6 1,200頭（月100）、R7 2,400頭（月200）
[6,7].forEach(y => MO.forEach(m => add('tateyama_capture_species', { fiscal_year: y, month: m, city: '館山市', category: 'イノシシ', metric: '捕獲頭数', value: y === 6 ? 100 : 200 })));
// 地区別 R7: 豊房 800（搬入 40 → 5%）、神戸 600（搬入 300 → 50%）、館野 100
[['豊房', 800], ['神戸', 600], ['館野', 100]].forEach(([d, v]) => MO.forEach((m, i) => add('tateyama_boar_district', { fiscal_year: 7, month: m, city: '館山市', area: d, category: 'イノシシ', metric: '捕獲頭数', value: i === 0 ? v - 11 : 1 })));
// 南房総 R6 3,000頭
add('minamiboso_capture_species', { fiscal_year: 6, city: '南房総市', category: 'イノシシ', metric: '捕獲頭数', value: 3000 });
// 被害額（全鳥獣） R1–R7 館山: 捕獲が多い翌年に減る形
[[1,20000],[2,27000],[3,10000],[4,15000],[5,16000],[6,8000],[7,14000]].forEach(([y,v]) => add('chiba_damage_city', { fiscal_year: y, city: '館山市', category: '全鳥獣', metric: '被害金額', value: v }));
[[7,21000]].forEach(([y,v]) => add('chiba_damage_city', { fiscal_year: y, city: '南房総市', category: '全鳥獣', metric: '被害金額', value: v }));
[[7,26000]].forEach(([y,v]) => add('chiba_damage_city', { fiscal_year: y, city: '鴨川市', category: '全鳥獣', metric: '被害金額', value: v }));
[[7,6000]].forEach(([y,v]) => add('chiba_damage_city', { fiscal_year: y, city: '鋸南町', category: '全鳥獣', metric: '被害金額', value: v }));
[1,2,3,4,5].forEach(y => add('tateyama_capture_species', { fiscal_year: y, month: 4, city: '館山市', category: 'イノシシ', metric: '捕獲頭数', value: [0,900,2357,1233,1138,2192][y] }));
// 国勢調査: 茂名（高齢化 50%・捕獲者1）、神余（高齢化 30%・捕獲者3）
[['茂名', 200, 100], ['神余', 300, 90], ['全市', 45000, 20000]].forEach(([a, pop, old]) => { add('census_oaza', { cal_year: 2020, city: '館山市', area: a, metric: '人口', value: pop }); add('census_oaza', { cal_year: 2020, city: '館山市', area: a, metric: '65歳以上', value: old }); add('census_oaza', { cal_year: 2020, city: '館山市', area: a, metric: '15〜64歳', value: pop - old - 10 }); });
// 免許
[2015, 2021].forEach(y => ['20～29歳','30～39歳','40～49歳','50～59歳','60歳以上'].forEach((g, i) => add('license_national_age', { cal_year: y, city: '全国', category: g, metric: '免許所持者数', value: 1000 * (i + 1) })));
add('license_chiba', { cal_year: 1978, city: '千葉県', category: '合計', metric: '免許所持者数', value: 20653 });
// 観光
[2023, 2024].forEach(y => [1,2,3,4,5,6,7,8,9,10,11,12].forEach(m => add('tourism_awa_month', { cal_year: y, month: m, city: '安房地域', metric: '宿泊客数', value: m === 8 ? 400000 : 200000 })));
// 放射能: 館山市産 検出0、君津市産 検出あり、勝浦市（解除済）
[[3,'館山市',104,0],[7,'館山市',621,0],[7,'南房総市',186,0],[7,'君津市',757,73],[5,'勝浦市',120,0]].forEach(([y,c,n,d]) => { add('radiation_facility', { fiscal_year: y, city: c, area: '施設', metric: '検体数', value: n }); add('radiation_facility', { fiscal_year: y, city: c, area: '施設', metric: '検出あり', value: d }); });
// 相場
[[2026,7,700,2400],[2026,8,720,2450]].forEach(([y,m,p,b]) => { add('meat_price_month', { cal_year: y, month: m, category: '豚枝肉（極上・上）', metric: '卸売価格', value: p }); add('meat_price_month', { cal_year: y, month: m, category: '牛枝肉（東京・大阪 加重平均）', metric: '卸売価格', value: b }); });
const SRC = [{ dataset: 'tateyama_capture_species', source: '館山市 市内捕獲状況', source_url: 'https://www.city.tateyama.chiba.jp/files/300368997.pdf', fetched_at: '2026-09-17T00:00:00Z', rows_n: 24, y_from: 6, y_to: 7 }, { dataset: 'radiation_facility', source: '千葉県 放射性物質検査結果', source_url: 'https://www.pref.chiba.lg.jp/x', fetched_at: '2026-09-17T00:00:00Z', rows_n: 10, y_from: 3, y_to: 7 }];
// うちの個体: R7 館山 600頭（豊房 40 = 神余、神戸 300 = 茂名、その他 260 = 山本）、南房総 190、R6 館山 300
const INDS = [];
let k = 0; const ind = (fy, city, area, m, hunter, w) => INDS.push({ label_id: 'T' + (k++), fiscal_year: fy, species: 'イノシシ', capture_date: `${m >= 4 ? 2018 + fy : 2019 + fy}-${String(m).padStart(2,'0')}-10`, city, area, hunter_name: hunter, weight: w });
for (let i = 0; i < 40; i++) ind(7, '館山市', '神余', 10, '大物 太郎', 50);
for (let i = 0; i < 300; i++) ind(7, '館山市', '茂名', MO[i % 12], i < 250 ? '大物 太郎' : '猟師' + (i % 30), 40);
for (let i = 0; i < 260; i++) ind(7, '館山市', '山本', MO[i % 12], '猟師' + (i % 30), 45);
for (let i = 0; i < 190; i++) ind(7, '南房総市', '宮下', MO[i % 12], '南 次郎', 42);
for (let i = 0; i < 300; i++) ind(6, '館山市', '茂名', MO[i % 12], '大物 太郎', 38);
for (let i = 0; i < 50; i++) ind(8, '館山市', '茂名', 5, '大物 太郎', 41);
const HUNTERS = [{ name: '大物 太郎', city: '館山市', trap_area: '館山市茂名' }, { name: '甲', city: '館山市', trap_area: '神余' }, { name: '乙', city: '館山市', trap_area: '館山市神余' }, { name: '丙', city: '館山市', trap_area: '神余（山側）' }];
const DIST = [{ oaza: '神余', district: '豊房' }, { oaza: '茂名', district: '神戸' }, { oaza: '山本', district: '館野' }];
const ORDERS = [{ order_date: '2026-08-05', status: '納品完了', order_items: [{ amount: 20000, weight_kg: 10 }] }, { order_date: '2026-08-20', status: 'キャンセル', order_items: [{ amount: 99999, weight_kg: 1 }] }, { order_date: '2026-09-02', status: '受付', order_items: [{ amount: 15000, weight_kg: 5 }, { amount: 6000, weight_kg: 5 }] }];

async function open(browser, { failOrders = false, failPs = false, noChart = false } = {}) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => sessionStorage.setItem('tg_role_v1', 'admin'));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => {
    const u = decodeURIComponent(r.request().url());
    if (u.startsWith('file:')) return r.continue();
    if (/cdnjs|fonts\./.test(u)) return r.fulfill({ status: 200, contentType: 'application/javascript', body: noChart ? '' : '' });
    const J = (b, st) => r.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/rest\/v1\/public_stats/.test(u)) return failPs ? r.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' }) : J(PS);
    if (/\/rest\/v1\/v_public_sources/.test(u)) return J(SRC);
    if (/\/rest\/v1\/v_individuals_all/.test(u)) return J(INDS);
    if (/\/rest\/v1\/hunters/.test(u)) return J(HUNTERS);
    if (/\/rest\/v1\/tateyama_districts/.test(u)) return J(DIST);
    if (/\/rest\/v1\/orders/.test(u)) return failOrders ? r.fulfill({ status: 500, contentType: 'text/plain', body: 'orders down' }) : J(ORDERS);
    if (/\/rest\/v1\/inventory/.test(u)) return J([{ updated_at: '2026-08-10T00:00:00Z', weight_kg: 12 }, { updated_at: '2026-09-01T00:00:00Z', weight_kg: 30 }]);
    if (/\/rest\/v1\/individuals/.test(u)) return /capture_lat/.test(u) ? J([{ label_id: 'a' }, { label_id: 'b' }]) : J([{ radiation_test_date: '2026-05-01', radiation_result: '検出下限値以下' }]);
    if (/\/rest\/v1\/customers/.test(u)) return J([{ address: '千葉県館山市1' }, { address: '東京都港区1' }, { address: '千葉県南房総市2' }]);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../public-analysis.html'));
  await page.waitForTimeout(900);
  return { page, errors };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = []; const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  const { page, errors } = await open(browser);
  const ui = await page.evaluate(() => ({
    secs: [...document.querySelectorAll('.sec[id^=sec-]')].map(s => s.id.replace('sec-', '')),
    badges: [...document.querySelectorAll('.sec[id^=sec-] .badge')].map(b => b.textContent).filter(t => /実データ|一部|未着手/.test(t)),
    toc: document.querySelectorAll('#toc a').length,
    status: document.getElementById('statusBar').textContent,
    intake: document.getElementById('body-intake').textContent.replace(/\s+/g, ' '),
    damage: document.getElementById('body-damage').textContent.replace(/\s+/g, ' '),
    census: document.getElementById('body-census').textContent.replace(/\s+/g, ' '),
    license: document.getElementById('body-license').textContent.replace(/\s+/g, ' '),
    acorn: document.getElementById('body-acorn').textContent.replace(/\s+/g, ' '),
    rad: document.getElementById('body-radiation').textContent.replace(/\s+/g, ' '),
    price: document.getElementById('body-price').textContent.replace(/\s+/g, ' '),
    econ: document.getElementById('body-econ').textContent.replace(/\s+/g, ' '),
    tourism: document.getElementById('body-tourism').textContent.replace(/\s+/g, ' '),
    ksj: document.getElementById('body-ksj').textContent,
    src: document.getElementById('srcTable').textContent,
    fallback: document.querySelectorAll('.fallback-bars').length,
  }));
  T('13項目が全部出る', ui.secs.length === 13 && ui.secs.join() === 'intake,damage,census,census_agri,license,ksj,weather,acorn,co2,tourism,radiation,econ,price', ui.secs.join());
  T('印: 実データ 6・一部 5・未着手 2', ui.badges.filter(t=>/実データ/.test(t)).length === 6 && ui.badges.filter(t=>/一部/.test(t)).length === 5 && ui.badges.filter(t=>/未着手/.test(t)).length === 2, JSON.stringify(ui.badges));
  T('目次に13件', ui.toc === 13, String(ui.toc));
  T('読み込んだ件数が出る', /公的データ \d+ 行・個体 1,140 頭/.test(ui.status), ui.status);
  // 搬入率: R7 館山 600/2400=25%、R6 300/1200=25%
  T('搬入率: 令和6年度 25% → 令和7年度 25%（市 2,400・搬入 600）', /令和6年度 25% → 令和7年度 25%/.test(ui.intake) && /2,400/.test(ui.intake) && /600/.test(ui.intake), ui.intake.slice(0, 200));
  T('南房総は市の公表待ちで出せない（R6 市 3,000 頭・うち受入 0 頭）', /3,000頭/.test(ui.intake) && /受入は0頭/.test(ui.intake), (ui.intake.match(/南房総市は[^。]*。/)||[''])[0]);
  T('地区別: 豊房（市 800・搬入 40・5%）が「搬入率が低い地区」に出る。神戸（50%）は出ない', /豊房（市 800頭・搬入 40頭・5%）/.test(ui.intake) && !/神戸（市 600/.test(ui.intake), (ui.intake.match(/地区別[^。]*。/)||[''])[0]);
  T('来年度の見込みの幅（令和2年度以降の市の捕獲 1,138〜2,400 × 搬入率25% → 285〜600頭）', /285〜600 頭/.test(ui.intake), (ui.intake.match(/令和8年度の館山市分は[^。]*/)||[''])[0]);
  // 被害
  T('被害額: 鴨川市・鋸南町は被害があるのに搬入ゼロ、と出る', /鴨川市・鋸南町は被害があるのに搬入ゼロ/.test(ui.damage) && /鴨川市 26,000千円/.test(ui.damage), '');
  T('被害額×前年捕獲の相関 r が数字で出る（負の向き）', /r = -0\.\d+/.test(ui.damage) && /翌年は被害が減る向き/.test(ui.damage), (ui.damage.match(/r = [^（]*/)||[''])[0]);
  // 国勢調査
  T('高齢化率45%以上で捕獲者1人以下の大字＝茂名（50%）が出て、神余（30%・捕獲者3）は出ない', /大字は 1（茂名 50%・350頭）/.test(ui.census) && !/神余 30%/.test(ui.census), (ui.census.match(/大字は[^。]*。/)||[''])[0]);
  T('国勢調査の表に 人口・高齢化率・捕獲者数（茂名 200・50%・1）', /茂名/.test(ui.census) && /50%/.test(ui.census), '');
  // 免許
  T('担い手: 令和7年度の捕獲者数と上位10人の割合が出る（大物太郎が290/600 → 上位10人で 60%超）', /令和7年度は上位10人で頭数の [\d.]+%/.test(ui.license) && /20,653人 → 令和2年 6,578人/.test(ui.license), (ui.license.match(/上位10人で頭数の [\d.]+%/)||[ui.license.slice(-300)])[0]);
  // ドングリ
  T('ドングリ: 県の公表なし → 秋の平均体重で代用（令和7 45.0kg 台）', /公表していません/.test(ui.acorn) && /令和7 4\d\.\dkg/.test(ui.acorn), (ui.acorn.match(/令和7 [^、]*/)||[''])[0]);
  // 放射能
  T('放射能: 館山市産・南房総市産 911 検体・検出 0 件、君津市は検出あり、勝浦市に解除済の印', /911 検体のうち[^0-9]*0 件/.test(ui.rad) && /検出73/.test(ui.rad) && /勝浦市 解除済/.test(ui.rad), (ui.rad.match(/イノシシ肉 [^。]*。/)||[''])[0]);
  // 相場
  T('相場: 豚 720・牛 2,450、センターの販売単価 2,100 円/kg（キャンセルは除く）', /豚枝肉 720 円\/kg、牛枝肉 2,450 円\/kg/.test(ui.price) && /販売単価は 2,100 円\/kg/.test(ui.price), (ui.price.match(/直近の相場[^。]*。/)||[''])[0]);
  T('経済センサス: 未取込と明記、顧客の都道府県分布（千葉県 2件）', /まだ取り込んでいません/.test(ui.econ) && /千葉県 2件/.test(ui.econ), '');
  T('観光: 8月が多い、出荷は2か月分', /8月/.test(ui.tourism) && /2 か月分/.test(ui.tourism), '');
  T('国土数値情報: 緯度経度が入っている頭数（2頭）', /2 頭/.test(ui.ksj), '');
  T('出どころの表に dataset と取得日', /tateyama_capture_species/.test(ui.src) && /2026-09-17/.test(ui.src), '');
  T('CDN が無いので簡易バー（fallback）で描く', ui.fallback >= 8, String(ui.fallback));
  T('pageerrorなし', errors.length === 0, errors.join(' / '));
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });
  await page.context().close();

  // うちのデータの一部が読めない
  const p2 = await open(browser, { failOrders: true });
  const st2 = await p2.page.evaluate(() => ({ status: document.getElementById('statusBar').textContent, secs: document.querySelectorAll('.sec[id^=sec-]').length, price: document.getElementById('body-price').textContent }));
  T('注文が読めなくても13項目は出て、読めなかったことが画面に出る', st2.secs === 13 && /注文: /.test(st2.status) && /読めませんでした/.test(st2.status), st2.status);
  T('pageerrorなし（注文なし）', p2.errors.length === 0, p2.errors.join(' / '));
  await p2.page.context().close();

  // public_stats が読めない
  const p3 = await open(browser, { failPs: true });
  const st3 = await p3.page.evaluate(() => document.getElementById('statusBar').textContent);
  T('public_stats が読めなければエラーが画面に出る（握り潰さない）', /読み込めませんでした/.test(st3) && /public_stats/.test(st3), st3);
  await p3.page.context().close();

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 240) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
