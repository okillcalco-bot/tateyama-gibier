// 捕獲票: 引き取り撮影（10km外57大字）の判定通知＋ARホワイトボード自動合成
// - isPickupArea: 南房総市の57大字だけを対象（館山市の同名大字は対象外）
// - 該当地区を選ぶと「写真撮影してください」通知
// - 引き取り/該当地区の撮影ではホワイトボード（日付/捕獲者/捕獲場所/社名/引き取り社）を右上に合成
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/capture-form.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9082);
  const b = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  }).catch(() => chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] }));
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, permissions: ['camera'] });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  const AREA = [
    { city: '南房総市', district: '丸山町', oaza: '宮下', address_label: '南房総市宮下' },
    { city: '南房総市', district: '丸山町', oaza: '大井', address_label: '南房総市大井' },
    { city: '南房総市', district: '和田町', oaza: '黒岩', address_label: '南房総市和田町黒岩' },
    { city: '南房総市', district: '三芳村', oaza: '明石', address_label: '南房総市明石' },
    { city: '館山市', district: '豊房', oaza: '神余', address_label: '館山市神余' },
    { city: '館山市', district: '館山', oaza: '大井', address_label: '館山市大井' },
  ];
  await p.route('**/rest/v1/**', route => {
    const url = decodeURIComponent(route.request().url());
    const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    if (url.includes('/area_master')) return j(AREA);
    return j([]);
  });
  await p.goto('http://localhost:9082/capture-form.html'); await p.waitForTimeout(500);

  // 1) isPickupArea の判定
  const jud = await p.evaluate(() => ({
    miyashita: isPickupArea('南房総市', '宮下'),        // 丸山地区(対象)
    kuroiwa: isPickupArea('南房総市', '和田町黒岩'),     // 和田地区(対象)
    ooiMinami: isPickupArea('南房総市', '大井'),         // 丸山地区大井(対象)
    ooiTate: isPickupArea('館山市', '大井'),             // 館山市大井(対象外)
    kamari: isPickupArea('館山市', '神余'),              // 対象外
    akashi: isPickupArea('南房総市', '明石'),            // 10km内(対象外)
    withPref: isPickupArea('南房総市', '南房総市宮下'),  // 南房総市付きでも吸収
    tomiura: isPickupArea('南房総市', '富浦町南無谷'),   // 富浦地区(対象・旧町名つき)
  }));
  ck('判定: 南房総市宮下=対象', jud.miyashita === true);
  ck('判定: 南房総市和田町黒岩=対象', jud.kuroiwa === true);
  ck('判定: 南房総市大井=対象', jud.ooiMinami === true);
  ck('判定: 館山市大井=対象外（同名だが市が違う）', jud.ooiTate === false);
  ck('判定: 館山市神余=対象外', jud.kamari === false);
  ck('判定: 南房総市明石=対象外（10km内）', jud.akashi === false);
  ck('判定: 富浦町南無谷=対象（旧町名つき）', jud.tomiura === true);
  ck('判定: 「南房総市」接頭も吸収して対象', jud.withPref === true);

  // 2) 距離判定（センターから10km超で対象扱い）
  const dist = await p.evaluate(() => ({
    near: distanceKm(CENTER.lat, CENTER.lng, CENTER.lat + 0.01, CENTER.lng),   // 約1km
    far: distanceKm(CENTER.lat, CENTER.lng, CENTER.lat + 0.2, CENTER.lng),     // 約22km
  }));
  ck('距離: 近距離は10km未満', dist.near < 10, String(dist.near));
  ck('距離: 遠距離は10km超', dist.far > 10, String(dist.far));

  // 3) 該当大字を選ぶと「写真撮影してください」通知が出る
  const notice = await p.evaluate(() => {
    state.capture_city = '南房総市';
    updateAreaDropdown('南房総市');
    renderOazaButtons('南房総市', '丸山町');
    const btn = [...document.querySelectorAll('#oazaBtns .toggle-btn')].find(x => x.textContent === '宮下');
    btn.click();
    const n = document.getElementById('pickupNotice');
    return { shown: n.classList.contains('show'), text: n.textContent };
  });
  ck('通知: 該当地区で表示', notice.shown, JSON.stringify(notice));
  ck('通知: 「写真撮影してください」を含む', notice.text.includes('写真撮影してください'), notice.text);

  // 非該当地区（館山市神余）では通知を隠す
  const noNotice = await p.evaluate(() => {
    state.capture_city = '館山市';
    updateAreaDropdown('館山市');
    document.getElementById('captureArea').value = '神余';
    updatePickupNotice();
    return document.getElementById('pickupNotice').classList.contains('show');
  });
  ck('通知: 非該当地区では非表示', noNotice === false);

  // 4) 捕獲場所ラベル: 地区（旧町村）は入れず市＋大字。白浜町/和田町は大字に旧町名を含む
  const labels = await p.evaluate(() => ({
    tate: placeLabel({ capture_city: '館山市', capture_area: '出野尾' }),
    minami: placeLabel({ capture_city: '南房総市', capture_area: '宮下' }),
    shirahama: placeLabel({ capture_city: '南房総市', capture_area: '白浜町白浜' }),
    wada: placeLabel({ capture_city: '南房総市', capture_area: '和田町黒岩' }),
    tomiura: placeLabel({ capture_city: '南房総市', capture_area: '富浦町南無谷' }),
    chikura: placeLabel({ capture_city: '南房総市', capture_area: '千倉町白間津' }),
  }));
  ck('場所: 館山市は市＋大字のみ（館山市 出野尾）', labels.tate === '館山市 出野尾', labels.tate);
  ck('場所: 南房総市も地区名は入れず市＋大字（南房総市 宮下）', labels.minami === '南房総市 宮下', labels.minami);
  ck('場所: 白浜町は大字に旧町名（南房総市 白浜町白浜）', labels.shirahama === '南房総市 白浜町白浜', labels.shirahama);
  ck('場所: 和田町は大字に旧町名（南房総市 和田町黒岩）', labels.wada === '南房総市 和田町黒岩', labels.wada);
  ck('場所: 富浦町も旧町名（南房総市 富浦町南無谷）', labels.tomiura === '南房総市 富浦町南無谷', labels.tomiura);
  ck('場所: 千倉町も旧町名（南房総市 千倉町白間津）', labels.chikura === '南房総市 千倉町白間津', labels.chikura);

  // 5) 引き取り撮影＝ホワイトボードのみ（右上）／看板は出さない
  const wb = await p.evaluate(() => {
    document.getElementById('captureDate').value = '2026-08-14';
    document.getElementById('hunterName').value = '池田和博';
    document.getElementById('intakeStaff').value = '沖浩志';
    state.capture_city = '南房総市';
    document.getElementById('captureArea').value = '宮下';
    state.intake_method = '引取';
    startPickupCapture();
    const el = document.getElementById('arWhiteboard');
    return {
      wbShown: el.classList.contains('show'), text: el.textContent,
      boardHidden: document.getElementById('arBoard').style.display === 'none',
      mode: _arMode,
    };
  });
  await p.waitForTimeout(500);
  ck('引取: ホワイトボードを表示', wb.wbShown, JSON.stringify(wb));
  ck('引取: 看板（左下）は出さない', wb.boardHidden, JSON.stringify(wb));
  ck('引取: 社名 合同会社アルコ', wb.text.includes('合同会社アルコ'), wb.text);
  ck('引取: 引き取り者は入力者（沖浩志）', wb.text.includes('引き取り者') && wb.text.includes('沖浩志'), wb.text);
  ck('引取: 捕獲者名', wb.text.includes('池田和博'), wb.text);
  ck('引取: 捕獲場所（宮下）', wb.text.includes('宮下'), wb.text);

  // 撮影でホワイトボードが焼き込まれる（右上に白い枠）
  const drawn = await p.evaluate(() => {
    const cv = document.getElementById('arCanvas');
    cv.width = 640; cv.height = 480;
    const c = cv.getContext('2d');
    c.fillStyle = '#223'; c.fillRect(0, 0, cv.width, cv.height);   // 疑似映像（暗色）
    arDrawWhiteboard(c, cv.width, cv.height, arWhiteboardData(_boardRec));
    const px = c.getImageData(cv.width - 200, 55, 180, 120).data;
    let white = false;
    for (let i = 0; i < px.length; i += 4) { if (px[i] > 240 && px[i + 1] > 240 && px[i + 2] > 240) { white = true; break; } }
    return white;
  });
  ck('引取: 右上にホワイトボードが焼き込まれる', drawn);
  await p.evaluate(() => arClose());
  await p.waitForTimeout(100);

  // 6) 受け入れ後の看板撮影＝看板のみ（左下）／ホワイトボードは出さない
  const REC_ACCEPT = {
    id: 'r2', label_id: 'TGC-08-T274', serial_number: 460, species: 'イノシシ', sex: 'オス',
    weight_total: 22.5, capture_date: '2026-08-14', hunter_name: '沖浩志',
    capture_city: '館山市', capture_area: '出野尾', intake_method: '引取', intake_staff: '沖浩志'
  };
  await p.evaluate((r) => startCaptureAfterRegister(r), REC_ACCEPT);
  await p.waitForTimeout(600);
  const board = await p.evaluate(() => ({
    boardShown: document.getElementById('arBoard').style.display !== 'none',
    wbHidden: !document.getElementById('arWhiteboard').classList.contains('show'),
    boardText: document.getElementById('arBoard').textContent,
    mode: _arMode,
  }));
  ck('受入: 看板（左下）を表示', board.boardShown, JSON.stringify(board));
  ck('受入: ホワイトボードは出さない', board.wbHidden, JSON.stringify(board));
  ck('受入: 看板の捕獲場所は「館山市 出野尾」（地区省略）', board.boardText.includes('館山市 出野尾') && !board.boardText.includes('豊房'), board.boardText);
  ck('受入: 看板に引き取り者は出さない', !board.boardText.includes('引き取り者'), board.boardText);
  await p.evaluate(() => arClose());
  await p.waitForTimeout(100);

  ck('JSエラーなし', errs.length === 0, errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
