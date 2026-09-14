// 看板つきカメラ: 端末を横に構えると看板・保存画像の向きが自動で横になる
//
//   きっかけ（2026-09-14）
//     引き取りの現場で横向きに構えても看板が縦のままだった（iPhoneは回転ロック等で画面が回らない）。
//     「📐」の手動切替はあったが気づかれない。deviceorientation の gamma（左右の傾き）で自動判定する。
//
//   ここで測ること
//     1. カメラを開くと deviceorientation を購読し、gamma=+80（横）で _arRot=90・映像が回る
//     2. gamma=-80 で 270、gamma=0（縦）で 0 に戻る。中間（40）では変えない（ヒステリシス）
//     3. 手動で「📐」を押した直後は自動で上書きしない
//     4. 閉じると縦に戻り、購読も外れる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/capture-form.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9082);
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/rest/v1/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto('http://localhost:9082/capture-form.html');
  await page.waitForTimeout(600);

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);
  const fire = (beta, gamma) => page.evaluate(([b, g]) => { window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta: b, gamma: g })); }, [beta, gamma]);
  const state = () => page.evaluate(() => ({ rot: _arRot, cls: document.getElementById('arCam').className, btn: document.getElementById('arRotBtn').textContent, sub: !!_arOrientHandler }));

  await page.evaluate(() => { _boardRec = { id: 'r1', label_id: 'TGC-08-T272', serial_number: 458, species: 'イノシシ', capture_date: '2026-09-14', hunter_name: '加藤茂', capture_city: '館山市', capture_area: '神余' }; _arMode = 'board'; arStart(); });
  await page.waitForTimeout(400);
  T('カメラを開くと傾きを購読する', (await state()).sub, JSON.stringify(await state()));
  T('開いた直後は縦', (await state()).rot === 0, '');

  await fire(0, 80); await page.waitForTimeout(50);
  let s = await state();
  T('横に構える（gamma=+80）→ 横①（90）・映像が回る', s.rot === 90 && /arrot90/.test(s.cls) && /横①/.test(s.btn), JSON.stringify(s));
  await fire(0, 40); await page.waitForTimeout(50);
  T('中間（gamma=40）では変えない', (await state()).rot === 90, '');
  await fire(0, -80); await page.waitForTimeout(50);
  s = await state();
  T('逆に構える（gamma=-80）→ 横②（270）', s.rot === 270 && /arrot270/.test(s.cls), JSON.stringify(s));
  await fire(85, 0); await page.waitForTimeout(50);
  s = await state();
  T('縦に戻す（gamma=0）→ 縦（0）', s.rot === 0 && !/arrot/.test(s.cls) && /縦/.test(s.btn), JSON.stringify(s));

  await page.evaluate(() => arToggleRot());
  await fire(85, 0); await page.waitForTimeout(50);
  T('手動で「📐」を押した直後は自動で上書きしない', (await state()).rot === 90, String((await state()).rot));

  // 保存画像は横向き（canvasが横長）になる
  await page.evaluate(() => { const v = document.getElementById('arVideo'); Object.defineProperty(v, 'videoWidth', { value: 640 }); Object.defineProperty(v, 'videoHeight', { value: 480 }); window.__saved = null; arSaveToDevice = async () => 'downloaded'; arUploadPhoto = async () => null; });
  await page.evaluate(() => arCapture());
  await page.waitForTimeout(300);
  const cv = await page.evaluate(() => { const c = document.getElementById('arCanvas'); return { w: c.width, h: c.height }; });
  T('横のときは保存画像が横長になる', cv.w > cv.h, JSON.stringify(cv));

  await page.evaluate(() => arClose());
  s = await state();
  T('閉じると縦に戻り、購読も外れる', s.rot === 0 && !s.sub, JSON.stringify(s));

  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close(); srv.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
