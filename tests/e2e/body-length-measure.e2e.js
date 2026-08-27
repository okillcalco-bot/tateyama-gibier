// 体長を写真から測る（メジャーが写っていれば4回タップで出せる）
//   目盛りを自動で読むと黙って外れた値が入るので、人が4点タップして比率で出す方式。
//   ここでは「タップした座標から正しいcmが出るか」を実際にクリックして測る。
//   欄は任意。時間がなければ触らなくても保存できることも確かめる。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
const zlib = require('zlib');

// テスト用の無地PNGを作る（画像の寸法がcanvasの寸法になるので、実寸のあるものが要る）
function makePNG(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1);
    raw[o] = 0;                                   // フィルタなし
    for (let x = 0; x < w; x++) { raw[o + 1 + x * 3] = 90; raw[o + 2 + x * 3] = 90; raw[o + 3 + x * 3] = 90; }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
let CRC_T = null;
function crc32(buf) {
  if (!CRC_T) {
    CRC_T = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); CRC_T[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext({ viewport: { width: 900, height: 900 } }).then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.goto('file://' + path.resolve(__dirname, '../../capture-form.html'));
  await page.waitForTimeout(800);

  const results = [];

  // 1) 体長の欄そのものがある（今まで欄が無かったので0件だった）
  results.push(['体長の入力欄がある', await page.$('#bodyLength') !== null, '']);
  results.push(['「写真で測る」ボタンがある',
    /写真で測る/.test(await page.$eval('#bodyLength', el => el.closest('.form-row').innerText)), '']);

  // 2) 空のままでも保存できる（任意の欄）
  results.push(['未入力なら体長はnull',
    await page.evaluate(() => parseFloat(document.getElementById('bodyLength').value) || null) === null, '']);

  // 3) 写真を読ませて4点タップする
  await page.click('button[onclick="blMeasureOpen()"]');
  await page.waitForTimeout(200);
  results.push(['測定画面が開く', await page.$eval('#blModal', el => el.classList.contains('show')), '']);

  await page.setInputFiles('#blFile', { name: 'boar.png', mimeType: 'image/png', buffer: makePNG(400, 300) });
  await page.waitForTimeout(400);
  results.push(['写真を読むと作業画面に切り替わる',
    await page.$eval('#blWork', el => el.style.display !== 'none')
    && await page.$eval('#blPick', el => el.style.display === 'none'), '']);
  results.push(['最初は①メジャーの基準点を促す', /① メジャーの基準点/.test(await page.$eval('#blStep', el => el.textContent)), '']);

  const box = await page.$eval('#blCanvas', el => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const tap = async (fx, fy) => {
    await page.mouse.click(box.x + box.w * fx, box.y + box.h * fy);
    await page.waitForTimeout(80);
  };
  // メジャーを幅の50%ぶん、個体を幅の80%ぶんに取る → 50cm基準なら 80cm になるはず
  await tap(0.10, 0.80); await tap(0.60, 0.80);
  results.push(['2点目まで打つと③鼻先を促す', /③ 鼻先/.test(await page.$eval('#blStep', el => el.textContent)), '']);
  await tap(0.10, 0.30); await tap(0.90, 0.30);

  const shown = await page.$eval('#blResult', el => el.textContent);
  const cm = parseFloat((shown.match(/([\d.]+) cm/) || [])[1]);
  results.push(['4点から体長が出る（50cm基準・比1.6 → 80cm）', Math.abs(cm - 80) < 0.6, shown]);
  results.push(['測れたと分かる', /測れました/.test(await page.$eval('#blStep', el => el.textContent)), '']);

  // 4) 実寸を変えるとその場で計算し直す
  await page.fill('#blKnownCm', '100');
  await page.waitForTimeout(150);
  const cm2 = parseFloat((await page.$eval('#blResult', el => el.textContent)).match(/([\d.]+) cm/)[1]);
  results.push(['実寸を変えると計算し直す（100cm基準 → 160cm）', Math.abs(cm2 - 160) < 1.2, String(cm2)]);
  await page.fill('#blKnownCm', '50');
  await page.waitForTimeout(150);

  // 5) 打ち間違いを戻せる
  await page.click('button[onclick="blUndo()"]');
  await page.waitForTimeout(150);
  results.push(['1つ戻すと未完成に戻る',
    (await page.$eval('#blResult', el => el.textContent)) === ''
    && await page.$eval('#blUse', el => el.disabled), '']);
  await tap(0.90, 0.30);
  await page.waitForTimeout(150);
  results.push(['打ち直せる', /cm/.test(await page.$eval('#blResult', el => el.textContent)), '']);

  await page.click('button[onclick="blReset()"]');
  await page.waitForTimeout(150);
  results.push(['最初からやり直せる',
    await page.evaluate(() => blPts.length) === 0
    && /① メジャーの基準点/.test(await page.$eval('#blStep', el => el.textContent)), '']);

  // 6) 5点目は受け付けない（余分なタップで壊れない）
  await tap(0.10, 0.80); await tap(0.60, 0.80); await tap(0.10, 0.30); await tap(0.90, 0.30);
  await tap(0.50, 0.50);
  results.push(['5点目は受け付けない', await page.evaluate(() => blPts.length) === 4,
    String(await page.evaluate(() => blPts.length))]);

  // 7) 値を欄に入れて閉じる
  await page.click('#blUse');
  await page.waitForTimeout(250);
  const v = await page.$eval('#bodyLength', el => el.value);
  results.push(['「この値を使う」で欄に入る', Math.abs(parseFloat(v) - 80) < 0.6, v]);
  results.push(['使ったら測定画面は閉じる', !await page.$eval('#blModal', el => el.classList.contains('show')), '']);

  // 8) 4点揃うまでは使えない（中途半端な値を入れさせない）
  await page.evaluate(() => { blMeasureOpen(); });
  await page.waitForTimeout(150);
  results.push(['開き直すと写真選択に戻る', await page.$eval('#blPick', el => el.style.display !== 'none'), '']);
  results.push(['計算できないときはnull', await page.evaluate(() => { blPts = []; return blComputeCm(); }) === null, '']);
  results.push(['実寸が0以下ならnull', await page.evaluate(() => {
    blPts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, { x: 20, y: 0 }];
    document.getElementById('blKnownCm').value = '0';
    return blComputeCm();
  }) === null, '']);
  results.push(['メジャーの2点が同じ位置ならnull', await page.evaluate(() => {
    blPts = [{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 0, y: 0 }, { x: 20, y: 0 }];
    document.getElementById('blKnownCm').value = '50';
    return blComputeCm();
  }) === null, '']);

  results.push(['pageerrorなし', errors.length === 0, errors.join(' / ')]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' && got != null ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
