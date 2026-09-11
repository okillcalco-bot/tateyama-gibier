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
    const svgW = 38; // .bc svg 幅(mm)
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
  results.push(['幅38mm', out.key.w38, out.key.w38]);
  results.push(['8桁キー: 79モジュール+静穏帯20=99', out.key.total === 99, String(out.key.total)]);
  results.push(['8桁キー: バーはx=10から（左に10モジュールの白）', out.key.first === 10, String(out.key.first)]);
  results.push(['8桁キー: 右にも10モジュールの白', out.key.quietRight === 10, String(out.key.quietRight)]);
  results.push(['8桁キー: バー幅>=0.36mm', out.key.xdim >= 0.36, out.key.xdim.toFixed(3)]);
  results.push(['8桁キー: 静穏帯>=3.5mm', out.key.quietMm >= 3.5, out.key.quietMm.toFixed(2) + 'mm']);
  results.push(['8桁キー: 読める判定', out.key.readable === true, '']);
  results.push(['識別コード印字(M167-AJ)は静穏帯込みで細い(<0.33mm)', out.aj.xdim < out.min, out.aj.xdim.toFixed(3)]);
  results.push(['識別コード印字(M167-AJ)は読めない判定', out.aj.readable === false, '']);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
