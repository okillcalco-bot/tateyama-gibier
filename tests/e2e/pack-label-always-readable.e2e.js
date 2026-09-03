// バーコードが必ず読める8桁になることの保証。
//   ・事前印刷(pmDoPrint)は8桁キーがある時だけ刷る（無い時に長い識別コードを焼かない）
//   ・8桁が無くても、保存直後にDBが付ける8桁(scan_code)で必ず印刷する
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9101);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  // 在庫POSTはDBトリガ相当で8桁scan_codeを返す。他は空。
  await p.route('**/rest/v1/**', rt => {
    const req = rt.request();
    if (/\/inventory/.test(req.url()) && req.method() === 'POST') {
      return rt.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'inv-1', scan_code: '10009999' }]) });
    }
    rt.fulfill({ contentType: 'application/json', body: '[]' });
  });
  await p.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));
  await p.goto('http://localhost:9101/index.html'); await p.waitForTimeout(500);

  // ── ① pmDoPrint：8桁の有無で先刷りを出し分ける ──
  const doPrint = await p.evaluate(() => {
    const calls = [];
    window.pmPrintLabel = (w, lot, ident, part, lw, scan) => calls.push(scan);  // 差し替え（実印刷しない）
    pmSelectedPart = { part_name: '枝肉（下）', barcode_num: 'EDS', price_standard: 0 };
    pmIndividual = { label_id: 'TGC-08-T312', species: 'イノシシ' };
    // 8桁なし
    pmLastLabelPrinted = false;
    pmDoPrint({ weight_kg: 5, lotCode: 'L', identCode: 'TGC-08-T312-EDS-9', fullPartName: '枝肉（下）', labelWeight: 5, scanCode: null });
    const afterNull = { printed: pmLastLabelPrinted, calls: calls.slice() };
    // 8桁あり
    calls.length = 0; pmLastLabelPrinted = false;
    pmDoPrint({ weight_kg: 5, lotCode: 'L', identCode: 'TGC-08-T312-EDS-9', fullPartName: '枝肉（下）', labelWeight: 5, scanCode: '10003254' });
    const after8 = { printed: pmLastLabelPrinted, calls: calls.slice() };
    return { afterNull, after8 };
  });
  ck('8桁なし: 先刷りしない（denseラベルを出さない）', doPrint.afterNull.printed === false && doPrint.afterNull.calls.length === 0, JSON.stringify(doPrint.afterNull));
  ck('8桁あり: 先刷りする', doPrint.after8.printed === true && doPrint.after8.calls[0] === '10003254', JSON.stringify(doPrint.after8));

  // ── ② 保存経路：プール枯渇(8桁なし)でも、DBの8桁で必ず印刷される ──
  const save = await p.evaluate(async () => {
    const calls = [];
    window.pmPrintLabel = (w, lot, ident, part, lw, scan) => calls.push(scan);
    // UI副作用を無害化
    window.pmRenderParts = () => {}; window.pmShowLastAction = () => {}; window.pmSaveSession = () => {};
    window.pmPersistState = () => {}; window.playFeedbackSound = () => {}; window.toast = () => {};
    window.refocusScaleInput = () => {}; window.pmUpdateHeldBar = () => {};
    pmSelectedPart = { part_name: '枝肉（下）', barcode_num: 'EDS', price_standard: 0 };
    pmIndividual = { label_id: 'TGC-08-T312', species: 'イノシシ', weight_total: 30 };
    pmCurrentOperator = 'テスト'; pmGrade = '並'; pmBoneIn = false; pmRetail = false;
    pmCompletedParts = []; pmUsedIdents = new Set(); pmScanPool = [];
    pmLastLabelPrinted = false;
    // プール空なので plan.scanCode は null になる
    const plan = pmBuildPlan(5.37);
    await pmOnWeightReceived(5.37, plan);
    return { planScan: plan.scanCode, calls };
  });
  ck('プール空なら plan.scanCode は無い', save.planScan == null, String(save.planScan));
  ck('保存後にラベルが1回だけ印刷される', save.calls.length === 1, JSON.stringify(save.calls));
  ck('その番号はDBの読める8桁(10009999)', save.calls[0] === '10009999', JSON.stringify(save.calls));

  ck('JSエラーなし', !errs.some(e => /pmDoPrint|pmOnWeightReceived|pmBuildPlan/.test(e)), errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
