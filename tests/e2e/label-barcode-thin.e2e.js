// 精肉ラベル: 読めないバーコードを黙って出さない
//
//   事故（2026-08-31 SHIPへの出荷）
//     TGC-08-T268-MU-2 と TGC-08-T278-MU の2件がスキャンできなかった。
//     どちらもDBには8桁の数字キーが入っていたが、ラベルのバーコードは
//     識別コードを印字していた。38mm幅に詰め込むとバーが細くなりすぎる。
//
//   ラベルは保存より先に出る。数字キーの先取り確保(tgc_reserve_scan_codes)が
//   失敗すると識別コードで印字する作りだったため、読めないラベルが黙って出ていた。
//   対策: 8桁の数字キーが無い時は「先刷りしない」。保存直後にDBのトリガが必ず付ける
//   8桁で1枚だけ刷る。＝読めない識別コードのバーコードは一切出さない（より強い保証）。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const IND = { label_id: 'TGC-08-T278', species: 'イノシシ', weight_total: 45, capture_date: '2026-08-27' };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const asked = [];
  page.on('dialog', async d => { asked.push(d.message()); await d.accept(); });

  const db = { rows: [] };
  let seq = 10001013;
  let reserveWorks = false;          // 先取り確保が失敗する状態（事故の再現）
  await page.route('**/*', r => {
    const u = r.request().url(), m = r.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = (b, st) => r.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/rpc\/tgc_reserve_scan_codes/.test(u)) {
      if (!reserveWorks) return r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"unavailable"}' });
      return J([String(seq++), String(seq++)]);
    }
    if (/\/rest\/v1\/inventory/.test(u)) {
      if (m === 'POST') {
        const b = JSON.parse(r.request().postData() || '{}');
        // 本番と同じ: scan_code が無ければ DB 側(trigger)が必ず採番する
        const row = Object.assign({ deleted_at: null }, b);
        if (!row.scan_code) row.scan_code = String(seq++);
        db.rows.push(row);
        return J([row], 201);
      }
      if (m === 'PATCH') return J([]);
      const dec = decodeURIComponent(u);
      const ind = (dec.match(/individual_id=eq\.([^&]+)/) || [])[1];
      return J(ind ? db.rows.filter(x => x.individual_id === ind) : []);
    }
    if (/\/rest\/v1\/individuals/.test(u)) return J([IND]);
    if (/\/rest\/v1\/staff/.test(u)) return J([{ name: '今泉貴雄' }]);
    return J([]);
  });

  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(700);

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  // ── 1) バー幅を実寸で測る（読めた/読めなかったコードそのもの） ──
  const mm = await page.evaluate(() => ({
    key268: labelBarcodeMm('10000913'),
    key278: labelBarcodeMm('10001013'),
    id268: labelBarcodeMm('T268-MU-2'),
    id278: labelBarcodeMm('T278-MU'),
    min: LABEL_BARCODE_MIN_MM
  }));
  T('数字キーは読める太さ', mm.key278 >= mm.min && mm.key268 >= mm.min, `${mm.key278.toFixed(3)}mm / ${mm.key268.toFixed(3)}mm`);
  T('数字キーは実測0.48mm前後', Math.abs(mm.key278 - 0.481) < 0.01, mm.key278.toFixed(3) + 'mm');
  T('T278-MU は細くて読めない', mm.id278 < mm.min, mm.id278.toFixed(3) + 'mm');
  T('T268-MU-2 はもっと細い', mm.id268 < mm.id278, mm.id268.toFixed(3) + 'mm');
  T('読める/読めないの判定が効く',
    await page.evaluate(() => labelBarcodeReadable('10001013') && !labelBarcodeReadable('T278-MU') && !labelBarcodeReadable('T268-MU-2')), '');

  // 印刷は出さず、中身だけ記録する
  await page.evaluate(() => {
    window.__labels = [];
    const orig = window.pmLabelHtml;
    window.pmLabelHtml = d => { window.__labels.push(d); return orig(d); };
    window.pmPrintLabel = (w, lot, ident, part, lw, sc) => {
      window.__labels.push({ ident, scanCode: sc || null,
        barcodeCode: sc || shortIdent(ident),
        thin: !labelBarcodeReadable(sc || shortIdent(ident)) });
    };
  });

  await page.evaluate(async () => {
    pmCurrentOperator = '今泉貴雄';
    await pmSelectIndividual('TGC-08-T278');
    pmSelectedPart = { part_name: 'ミンチ用', barcode_num: 'MU', price_standard: 1000 };
  });
  await page.waitForTimeout(400);

  // ── 2) 数字キーが取れないまま登録：denseラベルを一切出さず、DBの8桁で1枚だけ刷る ──
  //   （旧: 先にdenseで刷って後で刷り直す → 新: 先刷りせず保存後の8桁で刷る＝より強い保証）
  asked.length = 0;
  await page.evaluate(() => { window.__labels = []; });
  await page.evaluate(() => pmRequestRegister(1.44));
  await page.waitForTimeout(900);

  const labels = await page.evaluate(() => window.__labels);
  T('在庫には入る', db.rows.length === 1 && db.rows[0].ident_code === 'TGC-08-T278-MU',
    db.rows.map(r => r.ident_code).join(','));
  T('DB側が数字キーを必ず付ける', !!db.rows[0].scan_code, db.rows[0] && db.rows[0].scan_code);
  T('読めない識別コードのバーコードは一切出さない',
    labels.every(l => l.barcodeCode !== 'T278-MU' && l.thin !== true),
    labels.map(l => `${l.barcodeCode}/${l.thin}`).join(',') || '(0枚)');
  T('印刷は1枚だけ（先刷りしないので刷り直しも無い）', labels.length === 1, `${labels.length}枚`);
  T('その1枚はDBの読める8桁',
    labels.length === 1 && labels[0].barcodeCode === db.rows[0].scan_code && labels[0].thin === false,
    labels[0] && `${labels[0].barcodeCode} thin=${labels[0].thin}`);
  T('読めないラベルを出していないので確認アラートも出さない',
    !asked.some(a => /読み取れません/.test(a)), asked.join(' / ').slice(0, 80));

  // ── 3) 数字キーが取れているときは、余計なことをしない ──
  reserveWorks = true;
  asked.length = 0;
  await page.evaluate(async () => { window.__labels = []; pmScanPool = []; pmScanCodeFor = {}; await pmEnsureScanCodes(1); });
  await page.waitForTimeout(400);
  await page.evaluate(() => pmRequestRegister(2.09));
  await page.waitForTimeout(900);
  const labels2 = await page.evaluate(() => window.__labels);
  T('数字キーが取れていれば1枚だけ', labels2.length === 1, `${labels2.length}枚`);
  T('その1枚は読める太さ', labels2.length === 1 && labels2[0].thin === false,
    labels2[0] && `${labels2[0].barcodeCode} thin=${labels2[0].thin}`);
  T('よけいな確認を出さない', !asked.some(a => /細くて読み取れません/.test(a)), asked.join(' / ').slice(0, 60));

  // ── 4) それでも読めないラベルが出るときは、紙にも印を残す ──
  const html = await page.evaluate(() => pmLabelHtml({
    origin: '館山産', speciesName: 'イノシシ肉', labelId: 'TGC-08-T278', partName: 'ミンチ用',
    labelWeight: 1.44, expiryStr: '2027/8/28', identCode: 'TGC-08-T278-MU',
    barcodeSvg: makeCode128SVG('T278-MU'), barcodeThin: true
  }));
  T('ラベル自体に「刷り直して」と出る', /刷り直してください/.test(html), '');
  const htmlOk = await page.evaluate(() => pmLabelHtml({
    origin: '館山産', speciesName: 'イノシシ肉', labelId: 'TGC-08-T278', partName: 'ミンチ用',
    labelWeight: 1.44, expiryStr: '2027/8/28', identCode: 'TGC-08-T278-MU',
    barcodeSvg: makeCode128SVG('10001013'), barcodeThin: false
  }));
  T('読めるラベルには出さない', !/刷り直してください/.test(htmlOk), '');

  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
