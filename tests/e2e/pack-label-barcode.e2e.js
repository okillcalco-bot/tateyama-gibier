// 精肉パックラベル：バーコードは読める8桁数字キーを使い、その番号を手打ち用に大きく表示する。
//   読めない識別コードを黙って焼かない（細い時は警告）。実寸で桁数→バー幅を測って判定。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9100);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.route('**/rest/v1/**', rt => rt.fulfill({ contentType: 'application/json', body: '[]' }));
  await p.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));
  await p.goto('http://localhost:9100/index.html'); await p.waitForTimeout(500);

  const R = await p.evaluate(() => {
    const mk = (scanCode) => pmLabelHtml({
      origin: '館山産', speciesName: 'イノシシ肉', labelId: 'TGC-08-T312', partName: '枝肉（下）',
      labelWeight: 5.83, expiryStr: '2027/9/3', identCode: 'TGC-08-T312-EDS-3',
      barcodeSvg: makeCode128SVG(scanCode || 'T312-EDS-3'), barcodeThin: !scanCode, scanCode: scanCode || null
    });
    const width = (code) => { const m = /viewBox="0 0 (\d+)/.exec(makeCode128SVG(code)); return m ? 38 / parseInt(m[1], 10) : 0; };
    return {
      withScan: mk('10003258'),
      noScan: mk(null),
      mm8: width('10003258'),
      mmIdent: width('TGC-08-T312-EDS-3'),
      readable8: labelBarcodeReadable('10003258'),
      readableIdent: labelBarcodeReadable('TGC-08-T312-EDS-3'),
    };
  });

  // 8桁は読める・長い識別コードは読めない（実測）
  ck('8桁キーは読める(>=0.40mm)', R.readable8 === true && R.mm8 >= 0.40, R.mm8.toFixed(3));
  ck('長い識別コードは読めない', R.readableIdent === false && R.mmIdent < 0.40, R.mmIdent.toFixed(3));

  // scanCodeがあれば、手打ち用に8桁を大きく表示し、識別コードは小さく併記
  ck('scanあり: 8桁を大きく表示(.bct)', /class="bct">10003258</.test(R.withScan), R.withScan.slice(0, 40));
  ck('scanあり: 識別コードを小さく併記(.id2)', /class="id2">TGC-08-T312-EDS-3</.test(R.withScan), '');
  ck('scanあり: 細い警告は出さない', !/細く読めません/.test(R.withScan), '');

  // scanCodeが無い（プール枯渇でフォールバック）時は識別コード表示＋警告
  ck('scanなし: 識別コードを表示', /class="bct">TGC-08-T312-EDS-3</.test(R.noScan), '');
  ck('scanなし: 8桁併記は出さない', !/class="id2"/.test(R.noScan), '');
  ck('scanなし: 細い警告を出す', /細く読めません/.test(R.noScan), '');

  ck('JSエラーなし', !errs.some(e => /pmLabelHtml|makeCode128SVG/.test(e)), errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
