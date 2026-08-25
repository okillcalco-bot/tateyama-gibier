// 加工ラベルのバーコード密度：短めの識別コードは読取しきい値(約0.33mm/バー)以上になること
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
      const mods = parseInt((s.match(/viewBox="0 0 (\d+)/) || [])[1], 10);
      return { crisp: /crispEdges/.test(s), w38: /width:38mm/.test(s), mods, xdim: svgW / mods };
    };
    return { aj: mk('M167-AJ'), ro: mk('M167-RO') };
  });

  const results = [];
  results.push(['crispEdges付与', out.aj.crisp, out.aj.crisp]);
  results.push(['幅38mm', out.aj.w38, out.aj.w38]);
  results.push(['M167-AJ バー幅>=0.33mm', out.aj.xdim >= 0.33, out.aj.xdim.toFixed(3)]);
  results.push(['M167-RO バー幅>=0.33mm', out.ro.xdim >= 0.33, out.ro.xdim.toFixed(3)]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
