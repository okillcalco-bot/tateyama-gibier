// 手順書（スライス・真空パック）が現場からダウンロードできるか
//
//   きっかけ（2026-08-31）
//     スライス作業・真空パック機のマニュアル（PPTX）を追補2頁つきでPDF化し、
//     staff-docs/ に置いた。導線は2つ:
//       ・manual-app.html「🔪 作業手順マニュアル（ダウンロード）」
//       ・index.html マニュアルタブ「📥 手順書のダウンロード」
//     リンクだけあってファイルが無い（またはその逆）と現場で404になるので、
//     「リンクがある」「リンク先の実ファイルがリポジトリにある」を両方測る。
//
//   ここで測ること
//     1. 実ファイル staff-docs/manual-slice-vacuum.{pdf,pptx} が存在し、空でない
//     2. PDFはPDFヘッダ、PPTXはZIPヘッダで始まる（拡張子だけの偽物でない）
//     3. manual-app.html に両ファイルへのリンクが実際に描画される
//     4. index.html マニュアルタブに両ファイルへのリンクが実際に描画される
//     5. 各ページの staff-docs/ リンクは全て実ファイルに解決する（就業規則等も含む）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const results = [];
  const t = (name, ok, got) => results.push([name, ok, got]);

  // 1-2. 実ファイルの存在と中身
  const pdfPath = path.join(root, 'staff-docs/manual-slice-vacuum.pdf');
  const pptxPath = path.join(root, 'staff-docs/manual-slice-vacuum.pptx');
  const pdfOk = fs.existsSync(pdfPath) && fs.statSync(pdfPath).size > 100000;
  const pptxOk = fs.existsSync(pptxPath) && fs.statSync(pptxPath).size > 100000;
  t('PDF実ファイルが存在し空でない', pdfOk, pdfOk ? fs.statSync(pdfPath).size + 'B' : '無し');
  t('PPTX実ファイルが存在し空でない', pptxOk, pptxOk ? fs.statSync(pptxPath).size + 'B' : '無し');
  if (pdfOk) {
    const head = fs.readFileSync(pdfPath).subarray(0, 5).toString('latin1');
    t('PDFはPDFヘッダで始まる', head === '%PDF-', head);
  }
  if (pptxOk) {
    const head = fs.readFileSync(pptxPath).subarray(0, 2).toString('latin1');
    t('PPTXはZIPヘッダで始まる', head === 'PK', head);
  }

  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith('file:')) return r.continue();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};window.QRCode=function(){};' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  // ページ内の staff-docs/ 系リンクを集めて実ファイル照合する
  const checkPage = async (file, label) => {
    await page.goto('file://' + path.join(root, file));
    await page.waitForTimeout(800);
    const links = await page.$$eval('a[href*="manual-slice-vacuum"]',
      as => as.map(a => a.getAttribute('href')));
    t(label + ': PDFリンクが描画される', links.includes('staff-docs/manual-slice-vacuum.pdf'), links.join(','));
    t(label + ': PPTXリンクが描画される', links.includes('staff-docs/manual-slice-vacuum.pptx'), links.join(','));
    const staffDocLinks = await page.$$eval('a[href^="staff-docs/"]',
      as => as.map(a => a.getAttribute('href')));
    const missing = staffDocLinks.filter(h => !fs.existsSync(path.join(root, h)));
    t(label + ': staff-docs/ の全リンクが実ファイルに解決する（' + staffDocLinks.length + '本）',
      staffDocLinks.length > 0 && missing.length === 0, missing.join(',') || 'ok');
  };

  await checkPage('manual-app.html', 'マニュアルアプリ');
  await checkPage('index.html', '基幹アプリ');

  // index.html はタブの中なので、マニュアルタブのパネル内にあることも確認
  const inPanel = await page.$('#panel-manual a[href="staff-docs/manual-slice-vacuum.pdf"]');
  t('基幹アプリ: リンクはマニュアルタブのパネル内にある', !!inPanel);

  t('ページエラーが無い', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
