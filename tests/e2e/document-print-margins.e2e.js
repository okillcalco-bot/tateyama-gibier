// 書類（納品書・請求書など）の印刷: 上下左右に余白があり、右端・上端が切れない
//
//   きっかけ（2026-09-14）
//     いっぺ向け納品書の現物で、タイトルが用紙の上端に張り付き、右の発行者欄が切れていた。
//     原因: .sheet の幅 180mm が @page 16mm の印字幅 178mm を超えていた／印刷ダイアログで
//     余白を「なし」にすると @page の余白が消える。余白を用紙側(@page)と紙面側(.sheet padding)の
//     両方で取るようにした。
//
//   ここで測ること（実際にPDFにして文字の位置をmmで測る）
//     1. 既定（CSSの@page余白）で印刷: 文字の上下左右の余白がすべて 12mm 以上
//     2. 印刷ダイアログで余白「なし」にしても: 余白が 5mm 以上（紙面側の padding が効く）
//     3. どちらも文字が用紙からはみ出さない（右端 ≤ 205mm）・1ページに収まる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

(async () => {
  // 出力先（PDF/HTML）。TMPDIR を書き換えると Chromium のプロファイル置き場も変わって起動に失敗するため、専用の変数で受ける
  const outDir = process.env.DOC_TEST_OUT || require('os').tmpdir();
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/rest/v1/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.addInitScript(() => { try { localStorage.setItem('tg_staff_key', 'TESTKEY'); } catch (e) {} });
  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(700);

  // 印刷ウィンドウを差し替えてHTMLを捕まえる（いっぺ向け納品書と同じ内容）
  const html = await page.evaluate(() => {
    let captured = '';
    window.open = () => ({ document: { open() {}, write(s) { captured += s; }, close() {} } });
    invRenderPrint({
      type: '納品書', name: '株式会社紀伊国屋（いっぺ）', honorific: '様', date: '2026-09-14', due: '',
      issuer: { issuer_name: '合同会社アルコ', issuer_sub: '館山ジビエセンター運営事業者', postal: '294-0025', address: '千葉県館山市八戸37', tel: '070-1410-8808', email: 'oki@llcalco.com', reg_number: 'T7040003010341' },
      lines: [
        { name: '[9/14納品分] イノシシ ミンチ用', qty: 6.72, unit: 'kg', price: 1389, tax: 8 },
        { name: '[9/14納品分] イノシシ バラ', qty: 5.29, unit: 'kg', price: 2593, tax: 8 },
      ], bank: '', memo: ''
    }, 'DLV-202609-001', {});
    return captured;
  });

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);
  T('印刷用HTMLが生成される', /納 品 書/.test(html) && /株式会社紀伊国屋/.test(html), String(html.length));

  const htmlPath = path.join(outDir, 'doc-margin-test.html');
  fs.writeFileSync(htmlPath, html);
  const p2 = await ctx.newPage();
  await p2.goto('file://' + htmlPath);
  await p2.waitForTimeout(300);
  const pdfCss = path.join(outDir, 'doc-margin-css.pdf');
  const pdfNone = path.join(outDir, 'doc-margin-none.pdf');
  await p2.pdf({ path: pdfCss, format: 'A4', preferCSSPageSize: true, printBackground: true });
  await p2.pdf({ path: pdfNone, format: 'A4', margin: { top: '0', right: '0', bottom: '0', left: '0' }, printBackground: true });

  // PDFの文字位置をmmで測る（pymupdf）
  const measure = f => JSON.parse(execFileSync('python3', ['-c', `
import pymupdf, json, sys
d = pymupdf.open(sys.argv[1]); p = d[0]
W, H = p.rect.width, p.rect.height
xs0, ys0, xs1, ys1 = [], [], [], []
for b in p.get_text('blocks'):
    if not b[4].strip(): continue
    xs0.append(b[0]); ys0.append(b[1]); xs1.append(b[2]); ys1.append(b[3])
mm = 25.4 / 72
print(json.dumps({'pages': len(d), 'left': min(xs0)*mm, 'top': min(ys0)*mm, 'right': (W-max(xs1))*mm, 'bottom': (H-max(ys1))*mm, 'maxx': max(xs1)*mm, 'w': W*mm}))
`, f], { encoding: 'utf8' }));
  const a = measure(pdfCss), b = measure(pdfNone);
  const fmt = m => `左${m.left.toFixed(1)} 上${m.top.toFixed(1)} 右${m.right.toFixed(1)} 下${m.bottom.toFixed(1)}mm`;
  T('既定の印刷: 上下左右の余白が12mm以上', a.left >= 12 && a.top >= 12 && a.right >= 12 && a.bottom >= 12, fmt(a));
  T('既定の印刷: 1ページに収まり右端がはみ出さない', a.pages === 1 && a.maxx <= 205, `pages=${a.pages} 右端=${a.maxx.toFixed(1)}mm`);
  T('余白「なし」で印刷しても: 上下左右 5mm 以上（紙面側の余白）', b.left >= 5 && b.top >= 5 && b.right >= 5 && b.bottom >= 5, fmt(b));
  T('余白「なし」で印刷しても: 1ページ・右端がはみ出さない', b.pages === 1 && b.maxx <= 205, `pages=${b.pages} 右端=${b.maxx.toFixed(1)}mm`);
  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
