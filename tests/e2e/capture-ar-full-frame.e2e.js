// 看板つきカメラ: 見えているもの＝保存されるもの＝カメラの全フレーム（顔・個体・看板が必ず入る）。看板は映像の枠の中。
//
//   きっかけ（2026-09-16）
//     9/15 の引き取り写真（M193）が、保存画像で顔の上半分が切れていた。元は顔まで入れて撮っていた。
//     原因は object-fit:cover（画面いっぱいに拡大して端を捨てる）で、横向きのときはプレビューと保存で
//     切り出し範囲まで食い違っていた。さらにサーバー保存は公開からずっと失敗していて（RLSポリシー欠落）、
//     失敗を握り潰していたため端末の切れた1枚しか残らなかった。
//   追加（2026-09-17）
//     全フレームにしたら今度は、画面全体（黒帯込み）を保存し看板を画面基準に置いていたため、看板が
//     映像の外（黒帯）に出た（T335 の受け入れ写真）。保存は「映像の枠だけ」、看板は枠の中に置く。
//
//   ここで測ること
//     1. プレビューの映像は contain（全フレーム表示）で、CSSで回転させない
//     2. 看板の入れ物 #arOverlay は映像の枠に合わせる（縦: 枠そのもの／横: 幅と高さを入れ替え）
//     3. 保存画像は映像の枠だけ（全フレーム・黒帯なし）。看板は枠の中（右上のホワイトボードが写っている）
//     4. 横向き（_arRot=90）では保存画像は縦長（4:3 の映像を回した形）で、黒帯なし
//     5. サーバー保存に失敗したら画面に赤字で出る（黙って消えない）／成功したら「端末とサーバーの両方」と出る
//     6. 閉じると枠合わせを解除する
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/capture-form.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9083);
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let storageFail = false; const uploads = [];
  await page.route('**/storage/v1/object/capture-photos/**', r => {
    uploads.push(decodeURIComponent(r.request().url()));
    if (storageFail) return r.fulfill({ status: 403, contentType: 'application/json', body: '{"message":"new row violates row-level security policy"}' });
    r.fulfill({ status: 200, contentType: 'application/json', body: '{"Key":"ok"}' });
  });
  await page.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto('http://localhost:9083/capture-form.html');
  await page.waitForTimeout(600);

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);
  const near = (a, b, tol) => Math.abs(a - b) <= tol;
  const isBlack = p => p[0] < 20 && p[1] < 20 && p[2] < 20;
  const isWhite = p => p[0] > 200 && p[1] > 200 && p[2] > 200;

  await page.evaluate(() => { _boardRec = { id: 'r1', label_id: 'TGC-08-M193', species: 'イノシシ', capture_date: '2026-09-15', hunter_name: '五十嵐訓文', capture_city: '南房総市', capture_area: '宮下' }; _arMode = 'whiteboard'; arStart(); });
  await page.waitForTimeout(900);
  // 端末保存は共有シート/ダウンロードを開かないよう差し替え（サーバー保存は本物の経路を通す）
  await page.evaluate(() => { arSaveToDevice = async () => 'downloaded'; });

  // 1) プレビューは contain・回転なし
  const css = await page.evaluate(() => { const v = document.getElementById('arVideo'); const s = getComputedStyle(v); return { fit: s.objectFit, tf: s.transform, ready: v.videoWidth > 0, vw: v.videoWidth, vh: v.videoHeight }; });
  T('フェイクカメラの映像が来ている', css.ready, JSON.stringify(css));
  T('プレビューは contain（全フレーム表示）', css.fit === 'contain', css.fit);
  T('プレビュー映像はCSSで回転させない', css.tf === 'none', css.tf);
  T('看板の入れ物 #arOverlay がある', await page.$('#arOverlay #arWhiteboard') !== null, '');

  // 2) 看板の入れ物は映像の枠に合わせる（640×480 → 390×292.5、上下に黒帯 275.75）
  await page.evaluate(() => arOverlayFit());
  const fit1 = await page.evaluate(() => { const ov = document.getElementById('arOverlay'); const r = ov.getBoundingClientRect(); const wb = document.getElementById('arWhiteboard').getBoundingClientRect();
    return { st: { l: ov.style.left, t: ov.style.top, w: ov.style.width, h: ov.style.height }, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, wb: { x: wb.x, y: wb.y, r: wb.right, b: wb.bottom }, lay: arFrameLayout(640, 480, 390, 844) }; });
  T('縦: #arOverlay が映像の枠（390×292.5、上から275.75）に一致', near(fit1.rect.x, 0, 0.6) && near(fit1.rect.y, 275.75, 0.6) && near(fit1.rect.w, 390, 0.6) && near(fit1.rect.h, 292.5, 0.6), JSON.stringify(fit1.rect));
  T('縦: ホワイトボードは枠の中（右上・枠の端から12px）', fit1.wb.y >= 275.75 + 11 && fit1.wb.y <= 275.75 + 13 && fit1.wb.r <= 390 - 11 && fit1.wb.b <= 275.75 + 292.5, JSON.stringify(fit1.wb));

  // 3) 縦: 保存画像は枠だけ（4:3・黒帯なし）。看板は枠の中
  await page.evaluate(() => arCapture());
  await page.waitForTimeout(600);
  const cap1 = await page.evaluate(() => {
    const c = document.getElementById('arCanvas'); const x = c.getContext('2d');
    const px = (X, Y) => Array.from(x.getImageData(Math.round(X), Math.round(Y), 1, 1).data).slice(0, 3);
    return { w: c.width, h: c.height, top: px(c.width / 2, 3), mid: px(c.width / 2, c.height / 2), bottom: px(c.width / 2, c.height - 3), wbCorner: px(c.width - 45, 45), leftBottom: px(20, c.height - 20) };
  });
  T('縦: 保存画像は映像の枠だけ（640×480 の 4:3、黒帯なし）', near(cap1.w / cap1.h, 4 / 3, 0.01), JSON.stringify([cap1.w, cap1.h]));
  T('縦: 上下の端にも映像がある（黒帯を保存しない）', !isBlack(cap1.top) && !isBlack(cap1.bottom) && !isBlack(cap1.mid), JSON.stringify([cap1.top, cap1.mid, cap1.bottom]));
  T('縦: ホワイトボード（白）が保存画像の右上＝枠の中に写っている', isWhite(cap1.wbCorner), JSON.stringify(cap1.wbCorner));
  T('成功したら「端末とサーバーの両方」と出る', /両方/.test(await page.textContent('#arMsg')), await page.textContent('#arMsg'));
  T('サーバーへ送っている', uploads.length === 1, String(uploads.length));

  // 看板モード: 左下の看板（黒半透明）が枠の中に描かれる
  await page.evaluate(() => { _arMode = 'board'; arRenderBoard(_boardRec); document.getElementById('arBoard').style.display = ''; arOverlayFit(); arCapture(); });
  await page.waitForTimeout(600);
  const capB = await page.evaluate(() => {
    const c = document.getElementById('arCanvas'); const x = c.getContext('2d');
    const px = (X, Y) => Array.from(x.getImageData(Math.round(X), Math.round(Y), 1, 1).data).slice(0, 3);
    const k = c.width / 390;
    return { k, inBoard: px(30 * k, c.height - 30 * k), outside: px(c.width - 20, c.height - 20), boardBottom: getComputedStyle(document.getElementById('arBoard')).bottom };
  });
  const isDark = p => p[0] < 110 && p[1] < 110 && p[2] < 110;
  T('看板: 保存画像の左下（枠の中）に看板の黒地がある', isDark(capB.inBoard) && !isDark(capB.outside), JSON.stringify(capB));
  T('看板: プレビューの看板は枠の下端 12px 上（枠がボタン列に重ならないとき）', capB.boardBottom === '12px', capB.boardBottom);
  await page.evaluate(() => { _arMode = 'whiteboard'; });

  // 4) 横（90）: 入れ物は幅と高さを入れ替えて回る。保存画像は縦長（4:3 を回した形）・黒帯なし
  await page.evaluate(() => { _arRot = 90; _arManualUntil = Date.now() + 60000; arApplyRot(); });
  const rot = await page.evaluate(() => ({ ov: getComputedStyle(document.getElementById('arOverlay')).transform, v: getComputedStyle(document.getElementById('arVideo')).transform, cls: document.getElementById('arCam').className, st: { w: document.getElementById('arOverlay').style.width, h: document.getElementById('arOverlay').style.height } }));
  T('横: #arOverlay が回る', rot.ov !== 'none' && /arrot90/.test(rot.cls), JSON.stringify(rot));
  T('横: 入れ物は 幅=枠の高さ 292.5・高さ=枠の幅 390', rot.st.w === '292.5px' && rot.st.h === '390px', JSON.stringify(rot.st));
  T('横: 映像は回さない', rot.v === 'none', rot.v);
  await page.evaluate(() => arCapture());
  await page.waitForTimeout(600);
  const cap2 = await page.evaluate(() => {
    const c = document.getElementById('arCanvas'); const x = c.getContext('2d');
    const px = (X, Y) => Array.from(x.getImageData(Math.round(X), Math.round(Y), 1, 1).data).slice(0, 3);
    return { w: c.width, h: c.height, left: px(3, c.height / 2), mid: px(c.width / 2, c.height / 2), right: px(c.width - 3, c.height / 2), wbCorner: px(c.width - 45, 45) };
  });
  T('横: 保存画像は縦長（3:4）', near(cap2.h / cap2.w, 4 / 3, 0.01), JSON.stringify([cap2.w, cap2.h]));
  T('横: 左右の端にも映像がある（黒帯なし）', !isBlack(cap2.left) && !isBlack(cap2.right) && !isBlack(cap2.mid), JSON.stringify([cap2.left, cap2.mid, cap2.right]));
  T('横: ホワイトボードが右上（枠の中）に正立で写る', isWhite(cap2.wbCorner), JSON.stringify(cap2.wbCorner));

  // 5) サーバー保存の失敗は画面に出る
  storageFail = true;
  await page.evaluate(() => { _arRot = 0; arApplyRot(); arCapture(); });
  await page.waitForTimeout(600);
  const msg = await page.textContent('#arMsg');
  T('サーバー保存に失敗したら画面に出る（黙らない）', /失敗/.test(msg) && /端末には保存済み/.test(msg), msg);

  // 6) 閉じると枠合わせを解除
  await page.evaluate(() => arClose());
  const after = await page.evaluate(() => { const ov = document.getElementById('arOverlay'); return { w: ov.style.width, t: ov.style.top, wb: document.getElementById('arWhiteboard').style.top }; });
  T('閉じると #arOverlay の枠合わせが解除される', after.w === '' && after.t === '' && after.wb === '', JSON.stringify(after));
  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close(); srv.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
