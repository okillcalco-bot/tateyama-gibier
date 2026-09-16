// フードマイレージ解析（mileage-analysis.html）：
//   山→センターは「捕獲地区の概ね中心」（地区マスタの座標）、センター→お客さんは「住所の市区町村の中心」で距離を出す。
//   住所から市区町村を正しく切り出せること。距離・t·km・kg加重平均が合うこと。
//   座標が無い場所は隠さず一覧に出し、「まとめて取得」で地理院から取って保存（見つからずも保存）できること。
//   手で貼った座標も保存できること。読み込み失敗は画面に出ること（サイレント失敗を作らない）。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const CENTER = { lat: 34.968, lng: 139.8535 };
const DATA = {
  app_settings: [{ value: { name: '館山ジビエセンター', lat: CENTER.lat, lng: CENTER.lng } }],
  area_master: [
    { id: 1, city: '館山市', oaza: '神余', district: '神戸', sort_order: 1, lat: 34.95, lng: 139.86 },
    { id: 2, city: '館山市', oaza: '山本', district: '館野', sort_order: 2, lat: null, lng: null },
  ],
  individuals: [
    { id: 'i1', label_id: 'TGC-08-T001', species: 'イノシシ', capture_date: '2026-08-01', capture_city: '館山市', capture_area: '神余', capture_lat: null, capture_lng: null, weight_total: 40 },
    { id: 'i2', label_id: 'TGC-08-T002', species: 'イノシシ', capture_date: '2026-08-05', capture_city: '館山市', capture_area: '神余', capture_lat: null, capture_lng: null, weight_total: 30 },
    { id: 'i3', label_id: 'TGC-08-T003', species: 'イノシシ', capture_date: '2026-08-09', capture_city: '館山市', capture_area: '山本', capture_lat: null, capture_lng: null, weight_total: 50 },
    { id: 'i4', label_id: 'TGC-TEST-9', species: 'イノシシ', capture_date: '2026-08-09', capture_city: '館山市', capture_area: '神余', weight_total: 50 },
    { id: 'i5', label_id: 'TGC-08-シ001', species: 'シカ', capture_date: '2026-08-09', capture_city: '館山市', capture_area: '神余', weight_total: 50 },
  ],
  inventory: [{ individual_id: 'i1', weight_kg: 6 }, { individual_id: 'i1', weight_kg: 4 }, { individual_id: 'i2', weight_kg: 5 }, { individual_id: 'i3', weight_kg: 8 }],
  orders: [
    { id: 'o1', order_code: 'DIR-1', order_date: '2026-08-10', status: '発送済', customer_id: 'c1', customer_name: '横浜の店', delivery_address: null, channel: '直販', carrier: 'ヤマト' },
    { id: 'o2', order_code: 'DIR-2', order_date: '2026-09-01', status: '発送済', customer_id: null, customer_name: 'いすみの店', delivery_address: '〒299-4501 千葉県いすみ市岬町椎木348-1', channel: 'BASEネットショップ', carrier: null },
    { id: 'o3', order_code: 'DIR-3', order_date: '2026-09-02', status: '発送済', customer_id: 'c3', customer_name: '兵庫の店', delivery_address: null, channel: '直販（注文なし）', carrier: null },
    { id: 'o4', order_code: 'DIR-4', order_date: '2026-09-03', status: '受付', customer_id: 'c1', customer_name: '横浜の店', delivery_address: null, channel: '直販', carrier: null },
    { id: 'o5', order_code: 'DIR-5', order_date: '2026-09-04', status: '発送済', customer_id: 'c5', customer_name: '住所なしさん', delivery_address: null, channel: '直販', carrier: null },
    { id: 'o6', order_code: 'DIR-6', order_date: '2026-09-05', status: '発送済', customer_id: null, customer_name: '杉並の店', delivery_address: '〒166-0001 東京都杉並区阿佐谷北２丁目３－５', channel: 'ポータル', carrier: null },
  ],
  order_items: [
    { order_id: 'o1', weight_kg: 2, species: 'イノシシ' }, { order_id: 'o2', weight_kg: 1.5, species: 'イノシシ' }, { order_id: 'o2', weight_kg: 0.5, species: 'シカ' },
    { order_id: 'o3', weight_kg: 3, species: 'イノシシ' }, { order_id: 'o4', weight_kg: 1, species: 'イノシシ' }, { order_id: 'o5', weight_kg: 1, species: 'イノシシ' }, { order_id: 'o6', weight_kg: 2, species: 'イノシシ' },
  ],
  customers: [
    { id: 'c1', name: '横浜の店', address: '〒240-0021 神奈川県横浜市保土ケ谷区保土ケ谷町2-150-9' },
    { id: 'c3', name: '兵庫の店', address: '兵庫県美方郡新温泉町岸田1271' },
    { id: 'c5', name: '住所なしさん', address: null },
  ],
  geo_cache: [{ q: '神奈川県横浜市保土ケ谷区', lat: 35.46, lng: 139.6, src: 'gsi' }, { q: '千葉県いすみ市', lat: 35.25, lng: 140.38, src: 'gsi' }],
};
const GSI = {
  '千葉県館山市山本': [{ geometry: { coordinates: [139.84, 34.97] }, properties: { title: '千葉県館山市山本' } }],
  '兵庫県美方郡新温泉町': [{ geometry: { coordinates: [134.45, 35.6] }, properties: { title: '兵庫県美方郡新温泉町' } }],
  '東京都杉並区': [],
};

async function open(browser, { failTable } = {}) {
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const calls = [];
  await page.route('**/*', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url());
    const J = (x, st) => rt.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (url.startsWith('file:')) return rt.continue();
    if (/cdnjs|jsdelivr|fonts\./.test(url)) return rt.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    const g = url.match(/msearch\.gsi\.go\.jp\/address-search\/AddressSearch\?q=(.+)$/);
    if (g) { calls.push({ kind: 'gsi', q: g[1] }); return J(GSI[g[1]] || []); }
    const m = url.match(/\/rest\/v1\/(\w+)(\?.*)?$/);
    if (m) {
      const t = m[1];
      if (req.method() !== 'GET') { let body = null; try { body = JSON.parse(req.postData() || 'null'); } catch (e) {} calls.push({ kind: req.method(), table: t, query: m[2] || '', body, prefer: req.headers()['prefer'] || '' }); return J([]); }
      if (failTable === t) return rt.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' });
      return J(DATA[t] || []);
    }
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../mileage-analysis.html'));
  await page.waitForTimeout(800);
  return { page, errors, calls };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = []; const ck = (n, c, g) => results.push([n, c, g]);
  const near = (a, b, tol) => a != null && Math.abs(a - b) <= tol;

  const { page, errors, calls } = await open(browser);

  // ── 住所 → 市区町村 ──
  const ak = await page.evaluate(() => ({
    yokohama: addrKey('〒240-0021 神奈川県横浜市保土ケ谷区保土ケ谷町2-150-9'), gun: addrKey('兵庫県美方郡新温泉町岸田1271'), tokyo23: addrKey('〒166-0001 東京都杉並区阿佐谷北２丁目３－５'),
    isumi: addrKey('〒299-4501 千葉県いすみ市岬町椎木348-1'), ichihara: addrKey('千葉県市原市郡本1-2'), kashiwa: addrKey('〒277-0005 千葉県柏市柏3-6-9 第2後藤ビル 1F'), bad: addrKey('不明'), none: addrKey(null),
  }));
  ck('住所: 政令市は区まで（神奈川県横浜市保土ケ谷区）', ak.yokohama && ak.yokohama.q === '神奈川県横浜市保土ケ谷区' && ak.yokohama.pref === '神奈川県', JSON.stringify(ak.yokohama));
  ck('住所: 郡は町まで（兵庫県美方郡新温泉町）', ak.gun && ak.gun.q === '兵庫県美方郡新温泉町', JSON.stringify(ak.gun));
  ck('住所: 東京23区（東京都杉並区）', ak.tokyo23 && ak.tokyo23.q === '東京都杉並区', JSON.stringify(ak.tokyo23));
  ck('住所: 郵便番号を除いて市まで（千葉県いすみ市）', ak.isumi && ak.isumi.q === '千葉県いすみ市', JSON.stringify(ak.isumi));
  ck('住所: 「市原市郡本」は郡に引きずられず市原市', ak.ichihara && ak.ichihara.q === '千葉県市原市', JSON.stringify(ak.ichihara));
  ck('住所: ビル名つきでも柏市', ak.kashiwa && ak.kashiwa.q === '千葉県柏市', JSON.stringify(ak.kashiwa));
  ck('住所: 読めないものは null', ak.bad === null && ak.none === null, JSON.stringify([ak.bad, ak.none]));

  // ── 距離 ──
  const km = await page.evaluate(() => ({ same: kmBetween({ lat: 35, lng: 139 }, { lat: 35, lng: 139 }), kanamari: kmBetween({ lat: 34.95, lng: 139.86 }, { lat: 34.968, lng: 139.8535 }), nul: kmBetween({ lat: 1, lng: null }, { lat: 1, lng: 1 }) }));
  ck('距離: 同じ点は 0 km', km.same === 0, String(km.same));
  ck('距離: 神余→センター ≒ 2.1 km', near(km.kanamari, 2.1, 0.2), String(km.kanamari));
  ck('距離: 座標が欠けていれば null', km.nul === null, String(km.nul));

  // ── 初期解析（読み込み後に自動実行） ──
  const r1 = await page.evaluate(() => { const r = lastResult; return { inds: r.inds.length, indOk: r.indOk.length, indNo: r.indNo.length, leg1Mean: r.leg1Mean, leg1Kg: r.leg1Kg, leg1Tkm: r.leg1Tkm,
    orders: r.orders.map(o => o.code), ordOk: r.ordOk.map(o => o.code), ordNo: r.ordNo.map(o => [o.code, o.geoState]), leg2Kg: r.leg2Kg, leg2KgMean: r.leg2KgMean, missAreas: r.missAreas.map(a => a.place), missDest: r.missDest.map(d => [d.key || d.addr, d.state]),
    bands: r.bands.filter(b => b.kg > 0).map(b => [b.label, b.kg]), prefs: r.prefs.map(p => [p.pref, p.kg]), months: r.months.map(m => [m.month, m.kg]) }; });
  ck('個体: イノシシ3頭（テスト個体・シカは除外）', r1.inds === 3, String(r1.inds));
  ck('個体: 神余の2頭は距離あり、山本の1頭は座標なし', r1.indOk === 2 && r1.indNo === 1 && r1.missAreas.join() === '館山市 山本', JSON.stringify([r1.indOk, r1.indNo, r1.missAreas]));
  ck('山→センター: 平均 2.1 km、精肉 15kg（在庫2行の合算）、t·km=15/1000×2.1', near(r1.leg1Mean, 2.1, 0.2) && r1.leg1Kg === 15 && near(r1.leg1Tkm, 0.0315, 0.004), JSON.stringify([r1.leg1Mean, r1.leg1Kg, r1.leg1Tkm]));
  ck('出荷: 発送済のみ5件（受付の DIR-4 は除外）', r1.orders.length === 5 && !r1.orders.includes('DIR-4'), r1.orders.join());
  ck('出荷: 座標ありは横浜・いすみの2件、いすみはイノシシ分1.5kgだけ数える', r1.ordOk.join() === 'DIR-1,DIR-2' && r1.leg2Kg === 3.5, JSON.stringify([r1.ordOk, r1.leg2Kg]));
  ck('出荷: 未取得の理由が分かれる（未取得／住所なし／未取得）', JSON.stringify(r1.ordNo) === JSON.stringify([['DIR-3', 'not_fetched'], ['DIR-5', 'no_addr'], ['DIR-6', 'not_fetched']]), JSON.stringify(r1.ordNo));
  ck('kg加重平均: 横浜2kg・いすみ1.5kg の加重', (() => { const a = 2, b = 1.5; return near(r1.leg2KgMean, (a * 59 + b * 56) / (a + b), 8); })(), String(r1.leg2KgMean));
  ck('距離帯: 50〜100km 帯に 3.5kg', r1.bands.length === 1 && /50〜100/.test(r1.bands[0][0]) && r1.bands[0][1] === 3.5, JSON.stringify(r1.bands));
  ck('都道府県別: 神奈川 2kg・千葉 1.5kg', JSON.stringify(r1.prefs) === JSON.stringify([['神奈川県', 2], ['千葉県', 1.5]]), JSON.stringify(r1.prefs));
  ck('月別: 2026-08 と 2026-09', r1.months.map(m => m[0]).join() === '2026-08,2026-09', JSON.stringify(r1.months));

  const ui1 = await page.evaluate(() => ({ st: document.getElementById('statusBar').className, stText: document.getElementById('statusBar').textContent, leg1: document.getElementById('kpiLeg1').textContent, leg2sub: document.getElementById('kpiLeg2Sub').textContent,
    ratio: document.getElementById('kpiRatio').textContent, geo: document.getElementById('geoBox').textContent, charts: document.getElementById('chartsGrid').innerHTML, rows: document.querySelectorAll('#orderBody tr').length, far: document.getElementById('farBox').textContent, geoBtn: document.getElementById('btnGeo').disabled }));
  ck('画面: 未取得があることを警告で出す（隠さない）', /warn/.test(ui1.st) && /1頭/.test(ui1.stText) && /3件の配送先が未取得/.test(ui1.stText), ui1.stText.slice(0, 120));
  ck('画面: KPI 山→センター 2.1 km', /2\.1 km/.test(ui1.leg1), ui1.leg1);
  ck('画面: KPI センター→お客さん は 2件／5件で計算', /2件／5件/.test(ui1.leg2sub), ui1.leg2sub);
  ck('画面: 輸入牛肉との比較「約 1/N」が出る', /約 1\/\d/.test(ui1.ratio), ui1.ratio);
  ck('画面: 未取得の一覧に 山本・新温泉町・杉並・住所なし が並ぶ', /山本/.test(ui1.geo) && /新温泉町/.test(ui1.geo) && /杉並区/.test(ui1.geo) && /住所なし/.test(ui1.geo), ui1.geo.slice(0, 200));
  ck('画面: 地区別・距離帯別・月別・都道府県別・経路別のカードが出る（グラフ部品なしでも簡易バー）', ['捕獲地区別', '距離帯別', '月別', '都道府県別', '経路別'].every(s => ui1.charts.includes(s)) && /fallback-bars/.test(ui1.charts), '');
  ck('画面: 出荷別テーブル5行、遠い出荷に横浜', ui1.rows === 5 && /横浜の店/.test(ui1.far), String(ui1.rows));
  ck('画面: まとめて取得ボタンが押せる', ui1.geoBtn === false, '');

  // ── 他の肉との比較（公的統計のシェア × 代表点の直線距離） ──
  const meat = await page.evaluate(() => ({ rows: meatRef().map(r => ({ meat: r.meat, imp: r.imp, outside: r.outside, local: r.local, market: r.market, self: r.self })),
    beefAus: refKm('豪州（クイーンズランド）'), chibaHokuso: refKm('千葉（北総）'), kagoshima: refKm('鹿児島'), beefDomAll: wavg(MEAT_REF[0].dom), beefImp: wavg(MEAT_REF[0].imp),
    box: document.getElementById('meatBox').textContent, boxHtml: document.getElementById('meatBox').innerHTML, detail: document.getElementById('meatDetail').textContent }));
  const beef = meat.rows[0], pork = meat.rows[1], chicken = meat.rows[2], lamb = meat.rows[3];
  ck('比較: 4種（牛・豚・鶏・羊）ある', meat.rows.map(r => r.meat).join() === '牛肉,豚肉,鶏肉,羊肉（その他）', meat.rows.map(r => r.meat).join());
  ck('比較: 代表点の距離が妥当（豪州QLD 6,500〜7,500 km・千葉北総 90〜130 km・鹿児島 850〜1,000 km）', meat.beefAus > 6500 && meat.beefAus < 7500 && meat.chibaHokuso > 90 && meat.chibaHokuso < 130 && meat.kagoshima > 850 && meat.kagoshima < 1000, JSON.stringify([meat.beefAus, meat.chibaHokuso, meat.kagoshima]));
  ck('比較: 牛肉の輸入は豪州45%・米国38%の加重で 7,000〜9,000 km', beef.imp > 7000 && beef.imp < 9000, String(beef.imp));
  ck('比較: 国産（地域外）は主産地の加重で 牛 600〜1,000 km・豚 500〜900 km', beef.outside > 600 && beef.outside < 1000 && pork.outside > 500 && pork.outside < 900, JSON.stringify([beef.outside, pork.outside]));
  ck('比較: 地域内は千葉県産（牛＝安房 <30 km・豚鶏＝北総 90〜130 km）', beef.local < 30 && pork.local > 90 && pork.local < 130 && chicken.local === pork.local, JSON.stringify([beef.local, pork.local, chicken.local]));
  ck('比較: 市場平均は自給率で加重（牛: 0.39×国産全体 + 0.61×輸入）', Math.abs(beef.market - (0.39 * meat.beefDomAll + 0.61 * meat.beefImp)) < 1e-6 && beef.market > beef.outside && beef.market < beef.imp && chicken.imp > beef.imp, JSON.stringify([beef.market, meat.beefDomAll, meat.beefImp, chicken.imp]));
  ck('比較: 羊は地域内が無い（—）', lamb.local === null && lamb.self === 1, JSON.stringify(lamb));
  ck('画面: 比較表に 輸入／国産（地域外）／国産（地域内）／市場平均 の列と当センターの行', /輸入/.test(meat.box) && /国産（地域外）/.test(meat.box) && /地域内/.test(meat.box) && /市場平均/.test(meat.box) && /当センターのジビエ/.test(meat.box), '');
  ck('画面: 当センターとの倍率が出る', /当センターの [\d,\.]+倍/.test(meat.box), (meat.box.match(/当センターの [\d,\.]+倍/) || [''])[0]);
  ck('画面: 内訳に出どころ（貿易統計・畜産統計）とシェアが出る', /貿易統計/.test(meat.detail) && /畜産統計/.test(meat.detail) && /鹿児島 18%/.test(meat.detail) && /ブラジル（パラナ） 70%/.test(meat.detail), '');

  // ── まとめて取得（地理院→保存） ──
  await page.evaluate(() => geoFetchAll());
  await page.waitForTimeout(800);
  const gsiQ = calls.filter(c => c.kind === 'gsi').map(c => c.q);
  const patch = calls.find(c => c.kind === 'PATCH' && c.table === 'area_master');
  const posts = calls.filter(c => c.kind === 'POST' && c.table === 'geo_cache');
  ck('取得: 地理院に 山本・新温泉町・杉並区 を問い合わせる（取得済みの横浜・いすみは聞かない）', gsiQ.join() === '千葉県館山市山本,兵庫県美方郡新温泉町,東京都杉並区', gsiQ.join());
  ck('取得: 地区マスタ id=2 に座標を PATCH', patch && /id=eq\.2/.test(patch.query) && near(patch.body.lat, 34.97, 0.001) && near(patch.body.lng, 139.84, 0.001), JSON.stringify(patch));
  ck('取得: geo_cache に upsert（見つかった新温泉町・見つからない杉並も保存）', posts.length === 2 && posts.every(p => /merge-duplicates/.test(p.prefer)) && posts.some(p => p.body.q === '兵庫県美方郡新温泉町' && near(p.body.lat, 35.6, 0.001)) && posts.some(p => p.body.q === '東京都杉並区' && p.body.lat === null), JSON.stringify(posts.map(p => p.body)));
  const r2 = await page.evaluate(() => ({ indOk: lastResult.indOk.length, ordOk: lastResult.ordOk.map(o => o.code), st: document.getElementById('statusBar').textContent, geo: document.getElementById('geoBox').textContent }));
  ck('取得後: 山本も距離が出て3頭、兵庫も出て3件', r2.indOk === 3 && r2.ordOk.join() === 'DIR-1,DIR-2,DIR-3', JSON.stringify([r2.indOk, r2.ordOk]));
  ck('取得後: 結果を件数つきで出す（取得2・見つからず1）', /取得 2/.test(r2.st) && /見つからず 1/.test(r2.st) && /東京都杉並区/.test(r2.st), r2.st.slice(0, 160));
  ck('取得後: 杉並区は「見つからず」として一覧に残る', /杉並区/.test(r2.geo) && /見つからず/.test(r2.geo), '');

  // ── 手で貼る ──
  await page.fill('#geoBox input[data-id="東京都杉並区"]', '35.7048, 139.6363');
  await page.click('#geoBox input[data-id="東京都杉並区"] + button');
  await page.waitForTimeout(400);
  const manual = calls.filter(c => c.kind === 'POST' && c.table === 'geo_cache').pop();
  const r3 = await page.evaluate(() => ({ ordOk: lastResult.ordOk.length, st: document.getElementById('statusBar').textContent }));
  ck('手貼り: geo_cache に src=manual で保存', manual && manual.body.q === '東京都杉並区' && manual.body.src === 'manual' && near(manual.body.lat, 35.7048, 0.0001), JSON.stringify(manual && manual.body));
  ck('手貼り: 保存後は杉並も距離が出て4件', r3.ordOk === 4 && /保存しました/.test(r3.st), JSON.stringify(r3));
  await page.fill('#geoBox input[data-kind="dest"]', 'abc').catch(() => {});

  // ── CSV・状態フィルタ ──
  const csv = await page.evaluate(() => ({ o: csvOf('orders').split('\n'), i: csvOf('individuals').split('\n') }));
  ck('CSV: 出荷別はヘッダ＋5行、個体別はヘッダ＋3行', csv.o.length === 6 && /^﻿?出荷日,注文/.test(csv.o[0]) && csv.i.length === 4 && /個体番号/.test(csv.i[0]), JSON.stringify([csv.o.length, csv.i.length]));
  ck('CSV: 住所なしの行に「住所なし」と出る', csv.o.some(l => /DIR-5/.test(l) && /住所なし/.test(l)), csv.o.find(l => /DIR-5/.test(l)));
  await page.selectOption('#fStatus', 'all');
  await page.evaluate(() => runAnalysis());
  const r4 = await page.evaluate(() => lastResult.orders.length);
  ck('状態「すべて」にすると受付の注文も入って6件', r4 === 6, String(r4));

  ck('pageerrorなし', errors.length === 0, errors.join(' / '));
  await page.close();

  // ── 読み込み失敗は画面に出る ──
  const p2 = await open(browser, { failTable: 'individuals' });
  const st2 = await p2.page.evaluate(() => ({ cls: document.getElementById('statusBar').className, text: document.getElementById('statusBar').textContent }));
  ck('読み込み失敗: エラーとして画面に出る', /error/.test(st2.cls) && /読み込めませんでした/.test(st2.text) && /individuals/.test(st2.text), st2.text.slice(0, 100));
  ck('pageerrorなし(失敗時)', p2.errors.length === 0, p2.errors.join(' / '));

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
