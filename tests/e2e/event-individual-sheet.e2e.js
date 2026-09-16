// 出店: 個体シート（A4横・1個体1枚）と、その設定（今日の商品・ひとこと・写真）、距離の設定
//
//   きっかけ（2026-09-16）
//     やわたんまち（9/19・20）で「いま食べているのがどんな一頭か」を1枚で見せたい。商品や写真は
//     後から設定できるように。QRはその一頭＋この出店へ（会場までのフードマイレージが出る）。
//
//   ここで測ること
//     1. 出店を開くと、一頭ごとに「今日の商品」「ひとこと」「写真」の設定カードが並ぶ
//     2. 距離の設定に センター・会場・（この出店の個体の）地区 が並び、座標を貼って保存すると PATCH/UPSERT される
//     3. 座標が揃うと、カードに 山→センター / センター→会場 の距離が出る（DBの tgc_km と同じ大円距離）
//     4. 保存すると sale_event_sheets に出店×個体で UPSERT される（同じ組は上書き）
//     5. 印刷HTMLは A4横に1個体1枚。QRは ?i=個体&e=出店。商品・ひとこと・距離・感想の呼びかけが入る。
//        実寸で描いて、枠からはみ出さない・QRと文字が重ならないことを測る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const EV = { id: 'ev1', event_date: '2026-09-19', end_date: '2026-09-20', venue_id: 'v1', venue_name: 'やわたんまち', title: 'やわたんまち', status: '準備中', deleted_at: null };
const VENUES = [{ id: 'v1', name: 'やわたんまち', lat: null, lng: null, sort_order: 100, deleted_at: null }];
const ITEMS = [
  { id: 'i1', event_id: 'ev1', kind: 'inventory', inventory_id: 'p1', ident_code: 'TGC-08-T276-MO', individual_label: 'TGC-08-T276', species: 'イノシシ', part_name: 'モモ', weight_kg: 2.1, qty_taken: 1, qty_sold: 0, unit_price: 2600, amount: 0 },
  { id: 'i2', event_id: 'ev1', kind: 'inventory', inventory_id: 'p2', ident_code: 'TGC-08-M170-KR', individual_label: 'TGC-08-M170', species: 'イノシシ', part_name: '肩ロース', weight_kg: 1.3, qty_taken: 1, qty_sold: 0, unit_price: 3100, amount: 0 },
];
const INDS = [
  { label_id: 'TGC-08-T276', species: 'イノシシ', sex: 'メス', weight_total: 26.3, capture_date: '2026-09-03', capture_city: '館山市', capture_area: '神余', capture_method: 'くくり罠', radiation_test_date: '2026-09-05', radiation_result: '検出下限値以下', processing_done_at: '2026-09-04T02:00:00+00:00', capture_lat: null, capture_lng: null, image_url: null },
  { label_id: 'TGC-08-M170', species: 'イノシシ', sex: 'オス', weight_total: 35, capture_date: '2026-09-08', capture_city: '南房総市', capture_area: '上滝田', capture_method: '箱罠', radiation_test_date: '2026-09-10', radiation_result: '検出下限値以下', processing_done_at: '2026-09-09T02:00:00+00:00', capture_lat: 35.05, capture_lng: 139.9, image_url: null },
];
const AREAS = [{ id: 'a1', city: '館山市', district: '神戸', oaza: '神余', lat: null, lng: null }, { id: 'a2', city: '南房総市', district: '三芳', oaza: '上滝田', lat: null, lng: null }];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { await d.accept(); });
  const db = { center: { name: '館山ジビエセンター', lat: null, lng: null, note: '仮の値。要確認' }, sheets: [], venues: VENUES.map(v => Object.assign({}, v)), areas: AREAS.map(a => Object.assign({}, a)) };
  const writes = [];
  await page.route('**/*', r => {
    const u = decodeURIComponent(r.request().url()), m = r.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    let body = null; try { body = JSON.parse(r.request().postData() || 'null'); } catch (e) {}
    if (!/\/rest\/v1\//.test(u)) return r.fulfill({ status: 200, body: '[]' });
    if (/\/event_venues/.test(u)) {
      if (m === 'PATCH') { writes.push({ t: 'event_venues', u, body }); const id = (u.match(/id=eq\.([^&]+)/) || [])[1]; Object.assign(db.venues.find(v => v.id === id), body); return J([]); }
      return J(db.venues);
    }
    if (/\/sale_events/.test(u)) return J([EV]);
    if (/\/sale_event_items/.test(u)) return J(ITEMS);
    if (/\/sale_event_sheets/.test(u)) {
      if (m === 'POST') { writes.push({ t: 'sale_event_sheets', u, body, prefer: r.request().headers()['prefer'] }); const row = Object.assign({ id: 's' + (db.sheets.length + 1) }, body); const k = db.sheets.findIndex(s => s.label_id === body.label_id); if (k >= 0) db.sheets[k] = Object.assign(db.sheets[k], body); else db.sheets.push(row); return J([row]); }
      return J(db.sheets);
    }
    if (/\/individuals/.test(u)) return J(INDS);
    if (/\/app_settings/.test(u)) {
      if (m === 'PATCH') { writes.push({ t: 'app_settings', u, body }); db.center = body.value; return J([]); }
      if (m === 'POST') { writes.push({ t: 'app_settings', u, body }); db.center = body.value; return J([body]); }
      if (/select=key/.test(u)) return J([{ key: 'center_location' }]);
      return J([{ value: db.center }]);
    }
    if (/\/area_master/.test(u)) {
      if (m === 'PATCH') { writes.push({ t: 'area_master', u, body }); const id = (u.match(/id=eq\.([^&]+)/) || [])[1]; Object.assign(db.areas.find(a => a.id === id), body); return J([]); }
      return J(db.areas);
    }
    if (/\/staff/.test(u)) return J([]);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(600);

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  await page.evaluate(() => { document.querySelector('[data-tab="event"]').click(); });
  await page.waitForTimeout(400);
  await page.evaluate(async () => { evVenues = await sb('GET', 'event_venues', null, '?deleted_at=is.null&select=*'); await evOpen('ev1'); });
  await page.waitForTimeout(600);

  // 1) 設定カード
  const cards = await page.$$('.ev-sheet-card');
  T('一頭ごとに設定カードが並ぶ（2頭）', cards.length === 2, String(cards.length));
  T('カードに商品・ひとこと・写真の入力がある', await page.$('.ev-sheet-card .ev-sheet-product') !== null && await page.$('.ev-sheet-card .ev-sheet-story') !== null && await page.$('.ev-sheet-card .ev-sheet-photo') !== null, '');
  const c1 = await page.textContent('.ev-sheet-card[data-label="TGC-08-T276"]');
  T('座標が無いうちは「距離: 未設定」', /距離: 未設定/.test(c1), c1.slice(0, 160));

  // 2) 距離の設定に センター・会場・地区 が並ぶ
  const geoRows = await page.$$eval('.ev-geo-row', els => els.map(e => e.dataset.kind + ':' + e.textContent.trim().slice(0, 30)));
  T('距離の設定に センター・会場・地区(神余・上滝田) が並ぶ', geoRows.length === 4 && /center/.test(geoRows[0]) && /venue/.test(geoRows[1]) && geoRows.some(g => /神余/.test(g)) && geoRows.some(g => /上滝田/.test(g)), JSON.stringify(geoRows));

  // 座標を貼って保存（Googleマップの DMS 形式）
  const paste = async (kind, val) => {
    await page.evaluate(([k, v]) => { const row = document.querySelector(`.ev-geo-row[data-kind="${k}"]`); row.querySelector('.ev-geo-paste').value = v; row.querySelector('button').click(); }, [kind, val]);
    await page.waitForTimeout(300);
  };
  await paste('center', '34°58\'04.8"N 139°51\'12.6"E');   // 34.968, 139.8535
  await paste('venue', '34°59\'49.2"N 139°52\'12.0"E');    // 34.997, 139.87
  await page.evaluate(() => { const row = [...document.querySelectorAll('.ev-geo-row[data-kind="area"]')].find(r => /神余/.test(r.textContent)); row.querySelector('.ev-geo-paste').value = '34.95, 139.86'; row.querySelector('button').click(); });
  await page.waitForTimeout(300);
  const wCenter = writes.find(w => w.t === 'app_settings');
  const wVenue = writes.find(w => w.t === 'event_venues');
  const wArea = writes.find(w => w.t === 'area_master');
  T('センターの座標は app_settings.center_location に保存', wCenter && Math.abs(wCenter.body.value.lat - 34.968) < 0.001 && Math.abs(wCenter.body.value.lng - 139.8535) < 0.001, wCenter && JSON.stringify(wCenter.body.value));
  T('会場の座標は event_venues に PATCH', wVenue && /id=eq\.v1/.test(wVenue.u) && Math.abs(wVenue.body.lat - 34.997) < 0.001, wVenue && JSON.stringify(wVenue.body));
  T('地区の座標は area_master に PATCH（10進でも貼れる）', wArea && /id=eq\.a1/.test(wArea.u) && wArea.body.lat === 34.95 && wArea.body.lng === 139.86, wArea && JSON.stringify(wArea.body));

  // 3) 距離が出る
  const c1b = await page.textContent('.ev-sheet-card[data-label="TGC-08-T276"]');
  T('神余の一頭: 山→センター 2.1 km、センター→会場 3.6 km、合計 5.7 km', /距離 5\.7 km/.test(c1b) && /山→センター 2\.1 km/.test(c1b) && /センター→会場 3\.6 km/.test(c1b), c1b.match(/🚚[^\n]*/) && c1b.match(/🚚[^\n]*/)[0]);
  const c2b = await page.textContent('.ev-sheet-card[data-label="TGC-08-M170"]');
  T('個体に緯度経度があればそちらを使う（上滝田は地区未設定でも出る）', /距離 \d/.test(c2b) && !/未設定/.test(c2b), c2b.match(/🚚[^\n]*/) && c2b.match(/🚚[^\n]*/)[0]);

  // 4) 商品・ひとことを保存 → UPSERT
  await page.fill('.ev-sheet-card[data-label="TGC-08-T276"] .ev-sheet-product', '串焼き＝モモ');
  await page.fill('.ev-sheet-card[data-label="TGC-08-T276"] .ev-sheet-story', '神余の栗林で獲れた、脂ののった一頭');
  await page.click('.ev-sheet-card[data-label="TGC-08-T276"] .ev-sheet-save');
  await page.waitForTimeout(300);
  const wSheet = writes.find(w => w.t === 'sale_event_sheets');
  T('保存で sale_event_sheets に出店×個体で UPSERT', wSheet && /on_conflict=event_id,label_id/.test(wSheet.u) && /merge-duplicates/.test(wSheet.prefer || '') && wSheet.body.event_id === 'ev1' && wSheet.body.label_id === 'TGC-08-T276', wSheet && JSON.stringify(wSheet.body));
  T('商品とひとことが送られる', wSheet && wSheet.body.product_note === '串焼き＝モモ' && /栗林/.test(wSheet.body.story_text), '');

  // 5) 印刷HTML（QR・内容）と実寸
  const qrTexts = await page.evaluate(() => { const seen = []; const orig = makeQRSVG; window.makeQRSVG = (t, s) => { seen.push(t); return orig(t, s); }; const html = evIndSheetHtml(evCardRows(), 'やわたんまち', '9月19日', 'ev1'); window.makeQRSVG = orig; window.__sheetHtml = html; return seen; });
  T('QRは ?i=個体&e=出店 へ飛ぶ', qrTexts.length === 2 && qrTexts.every(t => /s\.html\?i=TGC-08-/.test(t) && /&e=ev1$/.test(t)), JSON.stringify(qrTexts));
  const html = await page.evaluate(() => window.__sheetHtml);
  T('1個体1枚（.pg が2つ）', (html.match(/class="pg"/g) || []).length === 2, '');
  T('商品・ひとこと・距離・感想の呼びかけが入る', /串焼き＝モモ/.test(html) && /栗林/.test(html) && /5\.7 km/.test(html) && /最後の一行/.test(html), '');
  T('ひとこと未設定の個体は自動の文で埋まる', /上滝田の山で箱罠にかかった35kgのオスのイノシシです/.test(html), '');

  // 実寸で描いて、はみ出しと重なりを測る（A4横 297×210mm、余白10mm → 紙面 277×190mm）
  const css = await page.evaluate(() => evIndSheetCss());
  const p2 = await ctx.newPage();
  await p2.setContent(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${css}</style></head><body>${html}</body></html>`);
  await p2.waitForTimeout(200);
  const geo = await p2.evaluate(() => {
    const mm = 96 / 25.4;
    return [...document.querySelectorAll('.pg')].map(pg => {
      const r = pg.getBoundingClientRect();
      const qr = pg.querySelector('.ft .qr').getBoundingClientRect();
      const qx = pg.querySelector('.ft .qx').getBoundingClientRect();
      const ph = pg.querySelector('.ph').getBoundingClientRect();
      const inr = pg.querySelector('.in').getBoundingClientRect();
      const over = [...pg.querySelectorAll('*')].some(el => { const b = el.getBoundingClientRect(); return b.bottom > r.bottom + 0.5 || b.right > r.right + 0.5; });
      return { hmm: r.height / mm, wmm: r.width / mm, qrmm: qr.width / mm, qrOverlap: qr.right > qx.left + 0.5, phOverlap: ph.right > inr.left + 0.5, over };
    });
  });
  T('紙面は 277×190mm に収まる', geo.every(g => g.hmm <= 190.5 && g.wmm <= 277.5), JSON.stringify(geo.map(g => [Math.round(g.wmm), Math.round(g.hmm)])));
  T('中身が枠からはみ出さない', geo.every(g => !g.over), JSON.stringify(geo));
  T('QRは42mm・文字と重ならない', geo.every(g => g.qrmm >= 41 && !g.qrOverlap && !g.phOverlap), JSON.stringify(geo));
  await p2.close();

  T('ページエラーなし', errors.length === 0, errors.join(' / '));
  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
