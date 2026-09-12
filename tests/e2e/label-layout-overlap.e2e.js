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
  // scanCode を渡すと、実際の出荷ラベルと同じく「この肉の物語」QRも一緒に描画する
  // （2026-09-08: QRを載せたまま元のバーコード高さ12mmに戻せるかを確かめるため追加）
  const measure = async (identCode, partName, scanCode) => await page.evaluate(async ({ identCode, partName, scanCode }) => {
    const html = pmLabelHtml({
      origin: '館山産', speciesName: 'イノシシ肉', labelId: 'TGC-08-M168',
      partName, labelWeight: 0.76, expiryStr: '2027/8/26', identCode,
      barcodeSvg: makeCode128SVG(scanCode || shortIdent(identCode)),
      scanCode: scanCode || null,
      qrSvg: scanCode ? makeQRSVG(storyUrl(scanCode), 9.5) : null
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
  }, { identCode, partName, scanCode });

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
    // 6) 読み取りに効くバー幅は維持（2026-09-12: 左右余白2.5mmのため35mm幅。静穏帯込みで8桁=0.35mm/バー）
    results.push([`${label}: バーコード幅35mmを維持`, Math.abs(mm(m.svg.w) - 35) < 1.5, `${mm(m.svg.w).toFixed(1)}mm`]);
    // 7) バーコード高さは12mmを維持する（2026-09-03にQRの場所を作るため12→9.5mmに縮めたが、
    //    2026-09-08に現物のスキャン失敗（ノクチラボ向け出荷）で発覚。実測すると12mmに戻しても
    //    QR込みで60mmに収まる＝縮める必要が無かったため、元の高さに戻した）
    results.push([`${label}: バーコード高さ12mm`, mm(m.svg.h) >= 11.5, `${mm(m.svg.h).toFixed(1)}mm`]);
  };

  // 写真と同じ条件（長い部位名・ペットフード用）と、長い識別コードの両方
  check('ペットフード用', await measure('TGC-08-M168', 'ペットフード用（なし）'));
  check('長い識別コード', await measure('TGC-08-M167-AJ-2', 'ロース'));
  // 「この肉の物語」QRを載せた実際の出荷ラベルと同じ組み合わせ（長い品名＋QR）でも
  // バーコードを12mmに戻したまま60mmに収まることを確かめる
  check('QR付き・長い品名', await measure('TGC-08-M168', '骨付き モモ [上] [小売]', '10000926'));

  // 品名は語の途中で折り返さない（実際に使う品名で1行に収まること）
  const NAMES = ['ロース', 'モモ', 'ウデ', 'ミンチ用', 'ペットフード用（なし）', 'ペットフード用（あり）',
    '骨付き ロース [上]', '骨付き モモ [上] [小売]', 'スライス肉（1.5mm）', 'ミンチ肉（粗挽き）'];
  const wraps = await page.evaluate(async (names) => {
    const out = [];
    for (const n of names) {
      const html = pmLabelHtml({
        origin: '館山産', speciesName: 'イノシシ肉', labelId: 'TGC-08-M168', partName: n,
        labelWeight: 0.76, expiryStr: '2027/8/26', identCode: 'TGC-08-M168', barcodeSvg: makeCode128SVG('10000926')
      });
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-9999px;top:0;border:0;width:40mm;height:60mm;';
      document.body.appendChild(f);
      const d = f.contentDocument; d.open(); d.write(html); d.close();
      await new Promise(r => setTimeout(r, 80));
      const el = d.querySelector('.p');
      const cs = d.defaultView.getComputedStyle(el);
      const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.25;
      out.push({ n, lines: Math.round(el.getBoundingClientRect().height / lh), pt: parseFloat(cs.fontSize) });
      f.remove();
    }
    return out;
  }, NAMES);
  const wrapped = wraps.filter(w => w.lines > 1).map(w => w.n);
  results.push(['品名が全て1行に収まる', wrapped.length === 0, wrapped.length ? '折返し: ' + wrapped.join(' / ') : `${wraps.length}件OK`]);
  const tooSmall = wraps.filter(w => w.pt < 9).map(w => w.n);
  results.push(['縮めすぎていない(9px以上)', tooSmall.length === 0, tooSmall.join(' / ')]);

  results.push(['pageerrorなし', errors.length === 0, errors.join(' / ')]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
