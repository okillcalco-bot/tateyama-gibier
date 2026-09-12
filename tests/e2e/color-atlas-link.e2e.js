// カラーアトラス（厚労省・令和7年3月改訂）とダニ資料への導線
//
//   きっかけ（2026-09-12）
//     「カラーアトラスを資料集に入れて」「以前のダニの資料はどこ？」
//     資料集＝マニュアルタブの「手順書・資料集（ダウンロード）」。ダニ（SFTS・疥癬）は
//     manabu.html の病気の章にあるが、直接飛べる id が無かったので #sfts / #kaisen を付けた。
//
//   ここで測ること
//     1. staff-docs/color-atlas-r7.pdf が実在し、PDFヘッダで始まり、52頁ぶんの大きさがある
//     2. index.html マニュアルタブと manabu.html 出典に、その実ファイルへのリンクがある
//     3. manabu.html に #sfts / #kaisen があり、マダニ・ヒゼンダニの本文を含む
//     4. index.html の資料集から manabu.html#sfts へ飛べる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  const pdf = path.join(root, 'staff-docs/color-atlas-r7.pdf');
  const exists = fs.existsSync(pdf);
  T('カラーアトラスPDFが実在する', exists, pdf);
  if (exists) {
    const buf = fs.readFileSync(pdf);
    T('PDFヘッダで始まる', buf.subarray(0, 5).toString('latin1') === '%PDF-', '');
    T('52頁ぶんの大きさ（3MB以上）', buf.length > 3000000, buf.length + 'B');
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

  await page.goto('file://' + path.join(root, 'index.html'));
  await page.waitForTimeout(600);
  const idxLinks = await page.$$eval('#panel-manual a', as => as.map(a => a.getAttribute('href')));
  T('マニュアルタブの資料集にカラーアトラスがある', idxLinks.includes('staff-docs/color-atlas-r7.pdf'), idxLinks.join(','));
  T('マニュアルタブの資料集からダニの項（manabu.html#sfts）へ飛べる', idxLinks.includes('manabu.html#sfts'), '');
  const atlasText = await page.$eval('#panel-manual a[href="staff-docs/color-atlas-r7.pdf"]', a => a.textContent);
  T('リンクに版（令和7年3月改訂）と頁の目安が書いてある', /令和7年3月/.test(atlasText) && /p\.8/.test(atlasText) && /p\.23/.test(atlasText), atlasText);

  await page.goto('file://' + path.join(root, 'manabu.html'));
  await page.waitForTimeout(600);
  const mLinks = await page.$$eval('a', as => as.map(a => a.getAttribute('href')));
  T('manabu.html 出典にカラーアトラスがある', mLinks.includes('staff-docs/color-atlas-r7.pdf'), '');
  const sfts = await page.$eval('#sfts', el => el.textContent.replace(/\s+/g, ' '));
  T('#sfts があり、マダニの本文を含む', /マダニ/.test(sfts) && /SFTS/.test(sfts), sfts.slice(0, 60));
  const kaisen = await page.$eval('#kaisen', el => el.textContent.replace(/\s+/g, ' '));
  T('#kaisen があり、ヒゼンダニの本文を含む', /ヒゼンダニ/.test(kaisen), kaisen.slice(0, 60));

  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
