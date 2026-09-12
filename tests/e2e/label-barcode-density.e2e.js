// ラベルのバーコード（Code128）の実寸：バー幅と静穏帯（クワイエットゾーン）を測る
//
//   きっかけ（2026-09-11 長谷川ジビエ精肉店への出荷）
//     8桁の数字キーを印字した新しいラベルまで含めて、バーコードが1枚も読めなかった。
//     DB上のscan_codeもバー幅（0.48mm）も正常。実際に描画を測ると、バーをSVGの端まで描いて
//     38mm幅に引き伸ばしていたため、40mm幅のラベルでバー両側の白がラベル余白1mmしか無かった。
//     Code128はバー両側に10モジュール以上の静穏帯が必要（ISO/IEC 15417）で、これが無いと
//     スキャナが開始・終了パターンを見つけられず読めない。
//     以前の「0.339mmは読めない」という実測も静穏帯無しでの結果だったので、バー幅ではなく
//     静穏帯を疑うべきだった。
//
//   ここで測ること
//     1. 8桁キー: 79モジュール + 静穏帯10×2 = 99モジュール、バーは x=10 から始まる
//     2. 8桁キーのバー幅は0.36mm以上（38mm ÷ 99 = 0.384mm。ハンディスキャナの下限0.19〜0.25mmより十分太い）
//     3. 静穏帯は片側3.5mm以上（10モジュール × 0.384mm = 3.84mm）
//     4. 識別コードを印字する旧方式（'M167-AJ'）は静穏帯込みだと0.29mmになり「読めない」判定になる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    return r.fulfill({ status: 200, body: '[]' });
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(500);

  const out = await page.evaluate(() => {
    const svgW = LABEL_BARCODE_WIDTH_MM; // .bc svg 幅(mm)。2026-09-12: 38→35（左右余白2.5mm）
    const mk = t => {
      const s = makeCode128SVG(t);
      const total = parseInt((s.match(/viewBox="0 0 (\d+)/) || [])[1], 10);
      const xs = [...s.matchAll(/<rect x="(\d+)" y="0" width="(\d+)"/g)].map(m => [+m[1], +m[2]]);
      const first = xs.length ? xs[0][0] : -1;
      const last = xs.length ? xs[xs.length - 1][0] + xs[xs.length - 1][1] : -1;
      const xdim = svgW / total;
      return { crisp: /crispEdges/.test(s), w38: /width:38mm/.test(s), total, first, quietRight: total - last,
        xdim, quietMm: first * xdim, readable: labelBarcodeReadable(t) };
    };
    return { key: mk('10003308'), aj: mk('M167-AJ'), min: LABEL_BARCODE_MIN_MM };
  });

  const results = [];
  results.push(['crispEdges付与', out.key.crisp, out.key.crisp]);
  results.push(['8桁キー: 79モジュール+静穏帯20=99', out.key.total === 99, String(out.key.total)]);
  results.push(['8桁キー: バーはx=10から（左に10モジュールの白）', out.key.first === 10, String(out.key.first)]);
  results.push(['8桁キー: 右にも10モジュールの白', out.key.quietRight === 10, String(out.key.quietRight)]);
  results.push(['8桁キー: バー幅>=0.35mm', out.key.xdim >= 0.35, out.key.xdim.toFixed(3)]);
  results.push(['8桁キー: 静穏帯>=3.3mm', out.key.quietMm >= 3.3, out.key.quietMm.toFixed(2) + 'mm']);

  // 2026-09-12: 現物で左端の文字と最下行が見切れていた（プリンタの印字位置ずれ）。
  // 実際に描画して、文字がラベル左端から2.5mm以上・下端から3mm以上離れていることを測る。
  await page.setContent(await page.evaluate(() => pmLabelHtml({
    origin: '館山産', speciesName: 'イノシシ肉', labelId: 'TGC-08-T302', partName: 'ロース',
    labelWeight: 2.53, expiryStr: '2027/9/9', identCode: 'TGC-08-T302-RO',
    barcodeSvg: makeCode128SVG('10003514'), barcodeThin: false, scanCode: '10003514',
    qrSvg: makeQRSVG('https://tateyama-gibier.vercel.app/s.html?c=10003514', 9.5)
  })));
  await page.waitForTimeout(200);
  const geo = await page.evaluate(() => {
    const mm = 96 / 25.4;
    const l = el => el ? el.getBoundingClientRect().left / mm : -1;
    const b = el => el ? el.getBoundingClientRect().bottom / mm : -1;
    const svg = document.querySelector('.bc svg');
    return { textLeft: l(document.querySelector('.o')), bcLeft: l(svg), bcWidth: svg ? svg.getBoundingClientRect().width / mm : -1,
      lastBottom: b(document.querySelector('.ad')), labelH: 60 };
  });
  results.push(['文字はラベル左端から2.5mm以上離れる', geo.textLeft >= 2.4, geo.textLeft.toFixed(2) + 'mm']);
  results.push(['バーコードSVGも左端から2.5mm以上', geo.bcLeft >= 2.4, geo.bcLeft.toFixed(2) + 'mm']);
  results.push(['バーコードSVG幅は35mm', Math.abs(geo.bcWidth - 35) < 0.3, geo.bcWidth.toFixed(2) + 'mm']);
  results.push(['最下行（住所）はラベル下端から3mm以上残す', geo.lastBottom > 0 && geo.lastBottom <= 57, geo.lastBottom.toFixed(2) + 'mm']);
  results.push(['8桁キー: 読める判定', out.key.readable === true, '']);
  results.push(['識別コード印字(M167-AJ)は静穏帯込みで細い(<0.33mm)', out.aj.xdim < out.min, out.aj.xdim.toFixed(3)]);
  results.push(['識別コード印字(M167-AJ)は読めない判定', out.aj.readable === false, '']);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
