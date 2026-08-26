// 精肉ラベル(40mm×60mm)：バーコードが上下の文字（消費期限・保存温度・住所）に重ならないこと
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

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
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(500);

  // 実寸(40mm×60mm)のiframeにラベルを描画し、各要素の位置を実測する
  const measure = async (identCode, partName) => await page.evaluate(async ({ identCode, partName }) => {
    const html = pmLabelHtml({
      origin: '館山産', speciesName: 'イノシシ肉', labelId: 'TGC-08-M168',
      partName, labelWeight: 0.76, expiryStr: '2027/8/26', identCode,
      barcodeSvg: makeCode128SVG(shortIdent(identCode))
    });
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;left:-9999px;top:0;border:0;width:40mm;height:60mm;';
    document.body.appendChild(f);
    const d = f.contentDocument; d.open(); d.write(html); d.close();
    await new Promise(r => setTimeout(r, 120));
    const q = s => d.querySelector(s);
    const box = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height, w: r.width }; };
    const mmPx = (() => { const p = d.createElement('div'); p.style.cssText = 'width:10mm;position:absolute'; d.body.appendChild(p); const w = p.getBoundingClientRect().width / 10; p.remove(); return w; })();
    const out = {
      mmPx,
      bodyH: d.body.getBoundingClientRect().height,
      scrollH: d.body.scrollHeight,
      ex: box(q('.ex')), tmp: box(q('.tmp')), bc: box(q('.bc')), svg: box(q('.bc svg')),
      bct: box(q('.bct')), mk: box(q('.mk')), ad: box(q('.ad'))
    };
    f.remove();
    return out;
  }, { identCode, partName });

  const results = [];
  const check = (label, m) => {
    const mm = v => v / m.mmPx;
    // 1) バーコードSVGが上の文字（保存温度）と重ならない
    results.push([`${label}: バーコードが保存温度に重ならない`, m.svg.top >= m.tmp.bottom - 0.5,
      `svg.top=${mm(m.svg.top).toFixed(1)}mm / tmp.bottom=${mm(m.tmp.bottom).toFixed(1)}mm`]);
    // 2) バーコードSVGが下の文字（コード表記）と重ならない
    results.push([`${label}: バーコードがコード表記に重ならない`, m.svg.bottom <= m.bct.top + 0.5,
      `svg.bottom=${mm(m.svg.bottom).toFixed(1)}mm / bct.top=${mm(m.bct.top).toFixed(1)}mm`]);
    // 2b) 実機のフォント差に耐える余白（1mm以上）を最終行の下に確保しておく
    results.push([`${label}: 用紙に1mm以上の余裕`, (m.bodyH - m.ad.bottom) >= m.mmPx,
      `余裕=${mm(m.bodyH - m.ad.bottom).toFixed(1)}mm`]);
    // 3) SVGは自分の枠(.bc)からはみ出さない（今回の不具合の直接原因）
    results.push([`${label}: SVGが枠からはみ出さない`, m.svg.top >= m.bc.top - 0.5 && m.svg.bottom <= m.bc.bottom + 0.5,
      `bc=${mm(m.bc.h).toFixed(1)}mm / svg=${mm(m.svg.h).toFixed(1)}mm`]);
    // 4) 住所まで含めて60mmに収まる
    results.push([`${label}: 全体が60mmに収まる`, m.scrollH <= m.bodyH + 1 && m.ad.bottom <= m.bodyH + 1,
      `内容=${mm(m.scrollH).toFixed(1)}mm / 用紙=${mm(m.bodyH).toFixed(1)}mm`]);
    // 5) 消費期限が読める高さで残っている
    results.push([`${label}: 消費期限の行が潰れていない`, m.ex.h >= 1.5 * m.mmPx, `${mm(m.ex.h).toFixed(1)}mm`]);
    // 6) 読み取りに効くバー幅は維持（38mm幅）
    results.push([`${label}: バーコード幅38mmを維持`, Math.abs(mm(m.svg.w) - 38) < 1.5, `${mm(m.svg.w).toFixed(1)}mm`]);
    // 7) バーコード高さは12mm確保（読み取りの狙いやすさ）
    results.push([`${label}: バーコード高さ12mm`, mm(m.svg.h) >= 11.5, `${mm(m.svg.h).toFixed(1)}mm`]);
  };

  // 写真と同じ条件（長い部位名・ペットフード用）と、長い識別コードの両方
  check('ペットフード用', await measure('TGC-08-M168', 'ペットフード用（なし）'));
  check('長い識別コード', await measure('TGC-08-M167-AJ-2', 'ロース'));

  results.push(['pageerrorなし', errors.length === 0, errors.join(' / ')]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
