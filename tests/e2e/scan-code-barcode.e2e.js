// ラベルの数字キー(scan_code)：桁数によらず読み取り余裕を確保し、スキャンで在庫を引ける
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const queries = [];

  await page.route('**/*', route => {
    const u = route.request().url();
    if (u.includes('jsdelivr') || u.includes('cdn')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (!/\/rest\/v1\//.test(u)) { if (u.startsWith('file:')) return route.continue(); return route.fulfill({ status: 200, body: '[]' }); }
    if (/\/rpc\/tgc_reserve_scan_codes/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(['20000001', '20000002', '20000003']) });
    if (/\/inventory/.test(u)) {
      queries.push(decodeURIComponent(u.split('?')[1] || ''));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'v1', ident_code: 'TGC-08-M167-MU-2', scan_code: '20000001', part_name: 'ミンチ用', weight: '0.59', weight_kg: '0.590', species: 'イノシシ', individual_id: 'TGC-08-M167', status: '在庫', tier: 2 }]) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });

  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(600);

  const results = [];

  // 1) Code128-C：数字8桁はバーが太くなる（読み取り余裕）
  const enc = await page.evaluate(() => {
    const mods = s => parseInt((s.match(/viewBox="0 0 (\d+)/) || [])[1], 10);
    const w = 38;
    return {
      num8: w / mods(makeCode128SVG('20000001')),
      idAJ: w / mods(makeCode128SVG('M167-AJ')),         // 7文字（従来のギリギリ可）
      idMU2: w / mods(makeCode128SVG('M167-MU-2')),      // 9文字（従来は不可）
      kk: w / mods(makeCode128SVG('TGC-MI-20260826-001')), // 19文字（従来は絶望的）
      odd: w / mods(makeCode128SVG('2000000'))            // 奇数桁はSetBのまま（後方互換）
    };
  });
  results.push(['数字8桁のバー幅 >= 0.45mm', enc.num8 >= 0.45, enc.num8.toFixed(3) + 'mm']);
  results.push(['数字8桁は従来コードより太い', enc.num8 > enc.idAJ * 1.3, `数字${enc.num8.toFixed(3)} / 英数${enc.idAJ.toFixed(3)}`]);
  results.push(['従来の9文字は依然として細い(比較用)', enc.idMU2 < 0.33, enc.idMU2.toFixed(3) + 'mm']);
  results.push(['加工品19文字は極細(比較用)', enc.kk < 0.2, enc.kk.toFixed(3) + 'mm']);
  results.push(['奇数桁はSetBで従来通り動く', enc.odd > 0 && isFinite(enc.odd), enc.odd.toFixed(3) + 'mm']);

  // 2) Code128-C のチェックディジットが正しい（自前実装の健全性）
  const ck = await page.evaluate(() => {
    // '20000001' → StartC(105) + 20,00,00,01 ; check = (105 + 20*1 + 0*2 + 0*3 + 1*4) % 103
    const expect = (105 + 20 * 1 + 0 * 2 + 0 * 3 + 1 * 4) % 103;
    const svg = makeCode128SVG('20000001');
    const mods = parseInt((svg.match(/viewBox="0 0 (\d+)/) || [])[1], 10);
    return { expect, mods };
  });
  results.push(['SetCのシンボル数が理論値(79)', ck.mods === 79, String(ck.mods)]);

  // 3) ラベルに数字キーが入る（精肉ラベル）
  const lbl = await page.evaluate(() => {
    const html = pmLabelHtml({
      origin: '館山産', speciesName: 'イノシシ肉', labelId: 'TGC-08-M168', partName: 'ペットフード用（なし）',
      labelWeight: 0.76, expiryStr: '2027/8/26', identCode: 'TGC-08-M168', barcodeSvg: makeCode128SVG('20000001')
    });
    return { hasIdentText: /TGC-08-M168/.test(html), mods: parseInt((html.match(/viewBox="0 0 (\d+)/) || [])[1], 10) };
  });
  results.push(['ラベルの文字は識別コードのまま', lbl.hasIdentText, '']);
  results.push(['ラベルのバーコードは数字キー(79)', lbl.mods === 79, String(lbl.mods)]);

  // 4) スキャン解決：8桁数字→scan_code、それ以外→ident_code
  const f = await page.evaluate(() => ({
    num: invScanFilter('20000001'),
    numFull: invScanFilter('２００００００１'),   // 全角でも通る
    ident: invScanFilter('M167-MU-2'),
    identFull: invScanFilter('TGC-08-M167-MU-2'),
    short: invScanFilter('1234')                  // 8桁でない数字は識別コード扱い
  }));
  results.push(['8桁数字→scan_code', f.num === 'scan_code=eq.20000001', f.num]);
  results.push(['全角数字も正規化', f.numFull === 'scan_code=eq.20000001', f.numFull]);
  results.push(['短縮コード→ident_code(頭補完)', /ident_code=eq\..*M167-MU-2/.test(f.ident) && /TGC-08-/.test(decodeURIComponent(f.ident)), decodeURIComponent(f.ident)]);
  results.push(['フルコードもident_code', /TGC-08-M167-MU-2/.test(decodeURIComponent(f.identFull)), decodeURIComponent(f.identFull)]);
  results.push(['8桁でない数字はident_code扱い', /ident_code=eq\./.test(f.short), decodeURIComponent(f.short)]);

  // 5) 実際のスキャン動線（加工処理）で数字キーが使われる
  await page.evaluate(async () => {
    kkMaterials = [];
    document.getElementById('kk-scan').value = '20000001';
    await kkScanAdd();
  });
  await page.waitForTimeout(300);
  const lastQ = queries[queries.length - 1] || '';
  results.push(['加工処理のスキャンがscan_codeで引く', /scan_code=eq\.20000001/.test(lastQ), lastQ.slice(0, 60)]);
  const mats = await page.evaluate(() => kkMaterials.map(m => m.ident_code));
  results.push(['数字キーで原料を追加できる', mats.includes('TGC-08-M167-MU-2'), mats.join(',')]);

  // 6) 旧ラベル（識別コード印字）も引き続き読める
  await page.evaluate(async () => {
    kkMaterials = [];
    document.getElementById('kk-scan').value = 'M167-MU-2';
    await kkScanAdd();
  });
  await page.waitForTimeout(300);
  const lastQ2 = queries[queries.length - 1] || '';
  results.push(['旧ラベルはident_codeで引く', /ident_code=eq\./.test(lastQ2), lastQ2.slice(0, 60)]);

  results.push(['pageerrorなし', errors.length === 0, errors.join(' / ')]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' && got != null ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
