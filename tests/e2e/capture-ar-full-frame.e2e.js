// 看板つきカメラ: 見えているもの＝保存されるもの＝カメラの全フレーム（顔・個体・看板が必ず入る）
//
//   きっかけ（2026-09-16）
//     9/15 の引き取り写真（M193）が、保存画像で顔の上半分が切れていた。元は顔まで入れて撮っていた。
//     原因は object-fit:cover（画面いっぱいに拡大して端を捨てる）で、横向きのときはプレビューと保存で
//     切り出し範囲まで食い違っていた。さらにサーバー保存は公開からずっと失敗していて（RLSポリシー欠落）、
//     失敗を握り潰していたため端末の切れた1枚しか残らなかった。
//
//   ここで測ること
//     1. プレビューの映像は contain（全フレーム表示）で、CSSで回転させない
//     2. 保存画像は全フレームを含む（切り出し無し）: 上下または左右に黒い余白、中央に映像
//     3. 横向き（_arRot=90）では看板の入れ物 #arOverlay だけが回り、保存画像は横長で全フレームを含む
//     4. サーバー保存に失敗したら画面に赤字で出る（黙って消えない）
//     5. 成功したら「端末とサーバーの両方」と出る
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

  // 2) 縦: 保存画像は全フレーム（640×480 のフェイク映像 → 幅いっぱい・上下に黒帯）
  await page.evaluate(() => arCapture());
  await page.waitForTimeout(600);
  const cap1 = await page.evaluate(() => {
    const c = document.getElementById('arCanvas'); const x = c.getContext('2d');
    const px = (X, Y) => Array.from(x.getImageData(Math.round(X), Math.round(Y), 1, 1).data).slice(0, 3);
    const lay = arFrameLayout(640, 480, 390, 844);
    return { w: c.width, h: c.height, lay, top: px(c.width / 2, 4), mid: px(c.width / 2, c.height / 2), bottom: px(c.width / 2, c.height - 4) };
  });
  T('縦: 保存画像は縦長', cap1.h > cap1.w, JSON.stringify([cap1.w, cap1.h]));
  T('縦: 全フレームが幅いっぱいに収まる（切り出し無し）', Math.abs(cap1.lay.w - 390) < 0.5 && Math.abs(cap1.lay.h - 292.5) < 0.5, JSON.stringify(cap1.lay));
  const isBlack = p => p[0] < 20 && p[1] < 20 && p[2] < 20;
  T('縦: 上下は黒い余白（映像を捨てていない証拠）', isBlack(cap1.top) && isBlack(cap1.bottom), JSON.stringify([cap1.top, cap1.bottom]));
  T('縦: 中央には映像がある', !isBlack(cap1.mid), JSON.stringify(cap1.mid));
  T('成功したら「端末とサーバーの両方」と出る', /両方/.test(await page.textContent('#arMsg')), await page.textContent('#arMsg'));
  T('サーバーへ送っている', uploads.length === 1, String(uploads.length));

  // 3) 横（90）: 看板の入れ物だけ回る。保存画像は横長で全フレーム
  await page.evaluate(() => { _arRot = 90; _arManualUntil = Date.now() + 60000; arApplyRot(); });
  const rot = await page.evaluate(() => ({ ov: getComputedStyle(document.getElementById('arOverlay')).transform, v: getComputedStyle(document.getElementById('arVideo')).transform, cls: document.getElementById('arCam').className }));
  T('横: #arOverlay が回る', rot.ov !== 'none' && /arrot90/.test(rot.cls), JSON.stringify(rot));
  T('横: 映像は回さない', rot.v === 'none', rot.v);
  await page.evaluate(() => arCapture());
  await page.waitForTimeout(600);
  const cap2 = await page.evaluate(() => {
    const c = document.getElementById('arCanvas'); const x = c.getContext('2d');
    const px = (X, Y) => Array.from(x.getImageData(Math.round(X), Math.round(Y), 1, 1).data).slice(0, 3);
    return { w: c.width, h: c.height, left: px(4, c.height / 2), mid: px(c.width / 2, c.height / 2), right: px(c.width - 4, c.height / 2) };
  });
  T('横: 保存画像は横長', cap2.w > cap2.h, JSON.stringify([cap2.w, cap2.h]));
  T('横: 左右に黒い余白・中央に映像（回しても全フレーム）', isBlack(cap2.left) && isBlack(cap2.right) && !isBlack(cap2.mid), JSON.stringify([cap2.left, cap2.mid, cap2.right]));

  // 4) サーバー保存の失敗は画面に出る
  storageFail = true;
  await page.evaluate(() => { _arRot = 0; arApplyRot(); arCapture(); });
  await page.waitForTimeout(600);
  const msg = await page.textContent('#arMsg');
  T('サーバー保存に失敗したら画面に出る（黙らない）', /失敗/.test(msg) && /端末には保存済み/.test(msg), msg);

  await page.evaluate(() => arClose());
  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close(); srv.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
