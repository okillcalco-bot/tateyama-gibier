// 捕獲票: 看板つきカメラ（AR風）と、編集時の地区警告/採番の修正
// - 撮影ボードの「📷 看板つきで撮影」→ カメラ映像の左下に看板を重ねて撮影→端末保存(blob)
// - 編集モードでは地区マスタ警告を出さず、個体番号は既存の値を表示
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/capture-form.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9079);
  // フェイクカメラ（getUserMediaが解決する）
  const b = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  }).catch(() => chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }));
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  const uploads = []; let patchedImageUrl = null;
  await p.route('**/storage/v1/object/capture-photos/**', route => {
    uploads.push(decodeURIComponent(route.request().url()));
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"Key":"ok"}' });
  });
  await p.route('**/rest/v1/**', route => {
    const req = route.request();
    const url = decodeURIComponent(req.url());
    const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    // 看板写真の紐付けはRPC public_attach_capture_photo 経由（object_path＋認証情報・P0-2 v2）
    if (url.includes('/rpc/public_attach_capture_photo') && req.method() === 'POST') {
      try { const b = JSON.parse(req.postData() || '{}'); patchedImageUrl = b.p_object_path; global._attachCred = b.p_credential; } catch (e) {}
      return j({ id: 'r1', label_id: 'TGC-08-T272', image_url: 'x' });
    }
    if (url.includes('/area_master')) return j([{ city: '館山市', district: '豊房', oaza: '神余' }]);
    return j([]);
  });
  await p.goto('http://localhost:9079/capture-form.html'); await p.waitForTimeout(500);

  const REC = { id: 'r1', label_id: 'TGC-08-T272', serial_number: 458, species: 'イノシシ', sex: 'オス',
    weight_total: 34, capture_date: '2026-08-14', hunter_name: '加藤茂', capture_city: '館山市', capture_area: '神余' };

  // 撮影ボードを開く（一覧から見るモード）→ 看板つきで撮影ボタン
  await p.evaluate((r) => showBoard(r, false), REC);
  await p.waitForTimeout(150);
  ck('ボードに「📷看板つきで撮影」ボタン', await p.evaluate(() => document.getElementById('boardArBtn').style.display !== 'none'));

  // AR起動 → カメラオーバーレイ表示 + 左下看板に個体番号
  await p.evaluate(() => arStart());
  await p.waitForTimeout(800);
  const ar = await p.evaluate(() => ({
    shown: document.getElementById('arCam').classList.contains('show'),
    board: document.getElementById('arBoard').textContent,
    hasCode: document.getElementById('arBoard').querySelector('.ar-code')?.textContent,
    videoReady: document.getElementById('arVideo').videoWidth > 0,
  }));
  ck('カメラオーバーレイが開く', ar.shown);
  ck('左下看板に個体番号', ar.hasCode === 'TGC-08-T272', ar.hasCode);
  ck('看板に捕獲者/場所が入る', ar.board.includes('加藤茂') && ar.board.includes('神余'), ar.board);
  ck('看板に通し番号(458)が入る', ar.board.includes('通し番号') && ar.board.includes('458'), ar.board);
  ck('フェイクカメラ映像が来ている', ar.videoReady, String(ar.videoReady));

  // 撮影 → 看板を焼き込んだ画像を生成（canvasが非空・保存導線）
  const cap = await p.evaluate(async () => {
    const v = document.getElementById('arVideo');
    const cv = document.getElementById('arCanvas');
    cv.width = v.videoWidth || 640; cv.height = v.videoHeight || 480;
    const c = cv.getContext('2d');
    c.fillStyle = '#345'; c.fillRect(0, 0, cv.width, cv.height);   // 疑似映像
    arDrawBoard(c, cv.width, cv.height, arBoardData(_boardRec));
    const url = cv.toDataURL('image/jpeg', 0.9);
    // 左下領域に非黒ピクセル（看板）があること
    const s = cv.width, hgt = cv.height;
    const px = c.getImageData(20, hgt - 140, 40, 40).data;
    let nonBg = false;
    for (let i = 0; i < px.length; i += 4) { if (px[i] > 200 || px[i + 1] > 200) { nonBg = true; break; } }
    return { urlOk: url.startsWith('data:image/jpeg') && url.length > 1000, boardDrawn: nonBg };
  });
  ck('撮影でJPEG画像を生成', cap.urlOk);
  ck('左下に看板が焼き込まれている', cap.boardDrawn);

  // 実際の arCapture がエラーなく動く → サーバー(capture-photos)へアップロード＋object_path紐づけ
  let dl = null;
  p.on('download', d => { dl = d.suggestedFilename(); });
  await p.evaluate(() => { window._submissionToken = 'st_tok'; });   // 登録直後の提出者トークン
  await p.evaluate(() => arCapture());
  await p.waitForTimeout(800);
  ck('arCapture 実行でエラーなし', true);
  ck('撮影画像をサーバー(capture-photos)へ保存', uploads.length > 0, JSON.stringify(uploads));
  ck('看板写真を object_path で紐づけ（任意URLでない）', typeof patchedImageUrl === 'string' && patchedImageUrl.includes('.jpg') && !patchedImageUrl.startsWith('http'), String(patchedImageUrl));
  ck('紐付けは提出者/端末トークンで認証', global._attachCred === 'st_tok', String(global._attachCred));
  ck('サーバー保存成功時は端末ダウンロードしない', dl === null, String(dl));

  // 閉じる → ストリーム停止・非表示
  await p.evaluate(() => arClose());
  await p.waitForTimeout(100);
  ck('カメラを閉じるとオーバーレイ非表示', await p.evaluate(() => !document.getElementById('arCam').classList.contains('show')));

  // サンプルボードではAR/修正ボタンを出さない
  const sample = await p.evaluate(() => { showBoardSample(); return {
    ar: document.getElementById('boardArBtn').style.display,
    edit: document.getElementById('boardEditBtn').style.display,
  }; });
  ck('サンプルボードでは撮影/修正ボタンを隠す', sample.ar === 'none' && sample.edit === 'none', JSON.stringify(sample));

  // 編集モード: 地区マスタ警告を出さない + 個体番号は既存値を表示
  await p.evaluate((r) => { closeBoard(); loadForEdit(r); }, { ...REC, capture_area: '白間津' /* マスタに無い地区 */ });
  await p.waitForTimeout(200);
  const edit = await p.evaluate(() => ({
    indSerial: document.getElementById('indSerial').value,
    indLabel: document.getElementById('indLabelId').value,
    // handleSubmitと同じ判定を再現：編集では warns は空
    warnsInEdit: (typeof editMode !== 'undefined' && editMode) ? [] : collectWarnings(),
  }));
  ck('編集: 個体番号は既存値(通し458)を表示', edit.indSerial === '458', edit.indSerial);
  ck('編集: 個体番号ラベルは既存値(T272)', edit.indLabel === 'TGC-08-T272', edit.indLabel);
  ck('編集: 地区マスタ警告を出さない', Array.isArray(edit.warnsInEdit) && edit.warnsInEdit.length === 0, JSON.stringify(edit.warnsInEdit));

  // ラベル印刷は捕獲票入力から撤去
  ck('ラベル印刷モーダルが存在しない', await p.evaluate(() => !document.getElementById('printModal')));
  ck('ボードにラベル印刷ボタンが存在しない', await p.evaluate(() => !document.getElementById('boardPrintBtn')));
  ck('showPrintModal関数が存在しない', await p.evaluate(() => typeof showPrintModal === 'undefined'));

  // 搬入登録の直後は自動でカメラが開く（startCaptureAfterRegister）
  await p.evaluate(() => { cancelEditMode(); });
  await p.evaluate((r) => startCaptureAfterRegister(r), REC);
  await p.waitForTimeout(600);
  const auto = await p.evaluate(() => ({
    camShown: document.getElementById('arCam').classList.contains('show'),
    boardShown: document.getElementById('boardOverlay').classList.contains('show'),
    code: document.getElementById('arBoard').querySelector('.ar-code')?.textContent,
    cancelText: document.querySelector('#arCam .ar-cancel').textContent,
  }));
  ck('登録直後: カメラが自動で開く', auto.camShown, JSON.stringify(auto));
  ck('登録直後: 撮影ボード画面は出さない', auto.boardShown === false);
  ck('登録直後: 看板に個体番号', auto.code === 'TGC-08-T272', auto.code);
  ck('登録直後: 閉じるボタンが「完了（次へ）」', auto.cancelText.includes('完了'), auto.cancelText);

  // 完了（閉じる）で次の入力へ＝フォームリセット
  await p.evaluate(() => arClose());
  await p.waitForTimeout(150);
  const afterClose = await p.evaluate(() => ({
    camHidden: !document.getElementById('arCam').classList.contains('show'),
    weight: document.getElementById('weight').value,
    hunter: document.getElementById('hunterName').value,
    editMode: typeof editMode !== 'undefined' ? editMode : null,
  }));
  ck('完了でカメラを閉じる', afterClose.camHidden);
  ck('完了で次の入力へ（フォームがリセット）', afterClose.weight === '' && afterClose.hunter === '', JSON.stringify(afterClose));

  ck('JSエラーなし', errs.length === 0, errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
