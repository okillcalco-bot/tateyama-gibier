// 加工品ラベルのQR（「この肉の物語」への入口）
//   ・40×60mm の実寸で描いて、はみ出し・重なり・折り返しを実測する
//   ・QRの中身をデコードし直して、印字した番号に戻ることを確かめる
//     （目で見て「QRらしきもの」が出ていても中身が壊れていたら意味がないため）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const CODES = ['10000001', '10000783', '10000926', '19999999', '12345678', '10001234', '10009999', '10000042'];
const CASES = [
  ['原料なし', 'ミンチ肉（粗挽き）', ''],
  ['原料1点', 'ミンチ肉（粗挽き）', '原料 TGC-08-M167'],
  ['原料4点', 'スライス肉（1.5mm）', '原料 TGC-08-M167・TGC-08-T262・TGC-08-M168・TGC-08-T263 他'],
  ['長い品名', 'ペットフード用ミンチ（骨なし）', '原料 TGC-08-M167・TGC-08-T262'],
];

/* QRを読み直す（バージョン4・誤り訂正M）。
   誤り訂正は使わず、配置・マスク・インターリーブ・形式情報が正しいことだけを確かめる。 */
function decodeQR(grid) {
  const N = grid.length;
  if (N !== 33) throw new Error('バージョン4(33モジュール)ではない: ' + N);
  const ver = (N - 17) / 4;

  const RES = Array.from({ length: N }, () => new Array(N).fill(false));
  const mark = (r, c) => { if (r >= 0 && c >= 0 && r < N && c < N) RES[r][c] = true; };
  for (const [r0, c0] of [[0, 0], [0, N - 7], [N - 7, 0]])
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) mark(r0 + r, c0 + c);
  for (let i = 0; i < N; i++) { mark(6, i); mark(i, 6); }
  for (const r of [6, 26]) for (const c of [6, 26]) {
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= N - 9) || (r >= N - 9 && c <= 8)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
  }
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(8, N - 1 - i); mark(N - 1 - i, 8); }

  // 形式情報（左上のコピー）を読む
  let f = 0;
  for (let i = 0; i < 15; i++) {
    let b;
    if (i <= 5) b = grid[i][8];
    else if (i === 6) b = grid[7][8];
    else if (i === 7) b = grid[8][8];
    else if (i === 8) b = grid[8][7];
    else b = grid[8][14 - i];
    f |= b << i;
  }
  const d = (f ^ 0x5412) >> 10;
  const ecLevel = d >> 3, mask = d & 7;
  if (ecLevel !== 0b00) throw new Error('誤り訂正レベルがMではない: ' + ecLevel);

  const MASKS = [
    (i, j) => (i + j) % 2 === 0, (i, j) => i % 2 === 0, (i, j) => j % 3 === 0,
    (i, j) => (i + j) % 3 === 0, (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
    (i, j) => (i * j) % 2 + (i * j) % 3 === 0, (i, j) => ((i * j) % 2 + (i * j) % 3) % 2 === 0,
    (i, j) => ((i + j) % 2 + (i * j) % 3) % 2 === 0
  ];

  const bits = [];
  let up = true;
  for (let col = N - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < N; k++) {
      const row = up ? N - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (RES[row][c]) continue;
        bits.push(grid[row][c] ^ (MASKS[mask](row, c) ? 1 : 0));
      }
    }
    up = !up;
  }
  const words = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(''), 2));

  // v4/M は データ64語（32語×2ブロック）＋EC36語。データはブロック間で交互に並ぶ
  const DATA = 64, BLOCKS = 2, PER = DATA / BLOCKS;
  const dw = [];
  for (let b = 0; b < BLOCKS; b++) for (let i = 0; i < PER; i++) dw.push(words[i * BLOCKS + b]);

  const db = [];
  dw.forEach(w => { for (let i = 7; i >= 0; i--) db.push((w >> i) & 1); });
  const take = (n, at) => parseInt(db.slice(at, at + n).join(''), 2);
  if (take(4, 0) !== 0b0100) throw new Error('バイトモードではない');
  const len = take(8, 4);
  const bytes = [];
  for (let i = 0; i < len; i++) bytes.push(take(8, 12 + i * 8));
  return { text: Buffer.from(bytes).toString('utf8'), mask, ver };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    return r.fulfill({ status: 200, body: '[]' });
  });
  await page.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(700);

  const results = [];

  // ---- 1) 実寸レイアウト ----
  const layout = await page.evaluate(async cases => {
    const out = [];
    for (const [name, prod, raw] of cases) {
      const html = kkLabelHtml({ ident_code: 'TGC-MI-20260826-001', weight: 0.25, scan_code: '10000926' },
        { prodName: prod, speciesName: 'イノシシ肉', origin: '南房総産', expiryStr: '2027/8/26', rawLine: raw });
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-9999px;top:0;border:0;width:40mm;height:60mm;';
      document.body.appendChild(f);
      const doc = f.contentDocument; doc.open(); doc.write(html); doc.close();
      await new Promise(r => setTimeout(r, 150));
      const probe = doc.createElement('div');
      probe.style.cssText = 'width:10mm;position:absolute'; doc.body.appendChild(probe);
      const mm = probe.getBoundingClientRect().width / 10; probe.remove();

      const lb = doc.querySelector('.lb').getBoundingClientRect();
      const last = doc.querySelector('.ad').getBoundingClientRect();
      const pe = doc.querySelector('.p');
      const nameLines = Math.round(pe.getBoundingClientRect().height / parseFloat(getComputedStyle(pe).lineHeight));
      const wrapped = el => el.getClientRects().length > 1;   // 途中で折り返したか
      out.push({
        name,
        bottomMm: (last.bottom - lb.top) / mm,
        widthMm: lb.width / mm,
        // バーコード文字列の下端より、QR行の上端が上に来ていたら重なっている
        overlap: doc.querySelector('.ft').getBoundingClientRect().top < doc.querySelector('.bct').getBoundingClientRect().bottom - 0.5,
        nameLines,
        rawWrapped: [...doc.querySelectorAll('.rw .nb')].some(wrapped),
        capWrapped: [...doc.querySelectorAll('.qc small')].some(wrapped),
        qrMm: doc.querySelector('.qr svg') ? doc.querySelector('.qr svg').getBoundingClientRect().width / mm : 0
      });
      f.remove();
    }
    return out;
  }, CASES);

  for (const r of layout) {
    results.push([`${r.name}: 60mmに収まる`, r.bottomMm <= 57.5, r.bottomMm.toFixed(1) + 'mm']);
    results.push([`${r.name}: 40mm幅に収まる`, Math.abs(r.widthMm - 40) < 0.2, r.widthMm.toFixed(1) + 'mm']);
    results.push([`${r.name}: QRが文字に重ならない`, !r.overlap, '']);
    results.push([`${r.name}: 品名が1行`, r.nameLines === 1, r.nameLines + '行']);
    results.push([`${r.name}: 個体番号が途中で折れない`, !r.rawWrapped, '']);
    results.push([`${r.name}: 案内文が途中で折れない`, !r.capWrapped, '']);
    results.push([`${r.name}: QRが13mm`, Math.abs(r.qrMm - 13) < 0.2, r.qrMm.toFixed(1) + 'mm']);
  }

  // 1モジュールの実寸（小さすぎるとスマホで読めない）
  const modMm = 13 / 41;
  results.push(['1モジュールが0.30mm以上', modMm >= 0.30, (modMm * 1000).toFixed(0) + 'μm']);

  // ---- 2) QRの中身が印字した番号に戻る ----
  const mats = await page.evaluate(codes => codes.map(c => {
    const svg = makeQRSVG(storyUrl(c), 13);
    const T = +svg.match(/viewBox="0 0 (\d+)/)[1], N = T - 8;   // 静穏帯4モジュール×2を除く
    const g = Array.from({ length: N }, () => new Array(N).fill(0));
    const re = /<rect x="(\d+)" y="(\d+)" width="1"/g; let m;
    while ((m = re.exec(svg))) { const x = +m[1] - 4, y = +m[2] - 4; if (x >= 0 && y >= 0 && x < N && y < N) g[y][x] = 1; }
    return g;
  }), CODES);

  let decoded = 0, firstBad = '';
  for (let i = 0; i < CODES.length; i++) {
    try {
      const { text } = decodeQR(mats[i]);
      if (text === 'https://tateyama-gibier.vercel.app/s.html?c=' + CODES[i]) decoded++;
      else if (!firstBad) firstBad = text;
    } catch (e) { if (!firstBad) firstBad = e.message; }
  }
  results.push(['QRを読み直すと元のURLに戻る(8件)', decoded === CODES.length, `${decoded}/8 ${firstBad}`]);

  // 静穏帯が規格どおり4モジュールある（無いと読み取り機が枠を見つけられない）
  const quiet = await page.evaluate(() => {
    const svg = makeQRSVG(storyUrl('10000783'), 13);
    const T = +svg.match(/viewBox="0 0 (\d+)/)[1];
    const xs = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)"/g)].map(m => [+m[1], +m[2]]);
    return { T, minX: Math.min(...xs.map(p => p[0])), minY: Math.min(...xs.map(p => p[1])),
             maxX: Math.max(...xs.map(p => p[0])), maxY: Math.max(...xs.map(p => p[1])) };
  });
  results.push(['静穏帯が4モジュールある', quiet.minX === 4 && quiet.minY === 4
    && quiet.T - 1 - quiet.maxX === 4 && quiet.T - 1 - quiet.maxY === 4,
    JSON.stringify(quiet)]);

  // ---- 3) 精肉ラベルにはQRを付けない（飲食店は注文時に検索できるため） ----
  const pmHasQr = await page.evaluate(() => {
    const h = pmLabelHtml({ ident_code: 'TGC-08-M167-RO', part_name: 'ロース', weight: 2.1,
      species: 'イノシシ', scan_code: '10000783', origin: '南房総産' });
    return /class="qr"/.test(h);
  });
  results.push(['精肉ラベルにQRは付けない', pmHasQr === false, String(pmHasQr)]);

  // ---- 4) scan_codeが無い古いデータでもラベルは壊れない ----
  const noCode = await page.evaluate(() => {
    const h = kkLabelHtml({ ident_code: 'TGC-MI-20250101-001', weight: 0.3 },
      { prodName: 'ミンチ肉', speciesName: 'イノシシ肉', origin: '南房総産', expiryStr: '2026/1/1', rawLine: '' });
    return { qr: /class="qr"/.test(h), maker: /館山ジビエセンター/.test(h) };
  });
  results.push(['scan_code無しではQRを出さない', noCode.qr === false, '']);
  results.push(['scan_code無しでも発行元は残る', noCode.maker === true, '']);

  results.push(['pageerrorなし', errors.length === 0, errors.join(' / ')]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' && got != null ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
