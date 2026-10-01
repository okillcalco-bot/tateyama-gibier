// 搬入・処理管理台帳: PDFは必ず1ページ3頭、Excelでも出せる（2026-10 市役所から依頼）
//
//   きっかけ
//     7月分（130頭）の台帳PDFが 88ページ になり、ページが途中で途切れていた。
//     本来は 3頭×44枚。実測すると 1枚 256mm に対して A4 の印字範囲は 265mm で、余裕が 9mm しかない。
//     環境（Windows の游ゴシック・Edge 等）で住所などが折り返すと1枚が2ページに割れ、ちょうど2倍の88ページになる。
//     また市役所から「Excelでもらえれば修正も印刷範囲の設定もできる」と依頼があった。
//
//   ここで測ること
//     1. 文字が大きくなって1枚がはみ出す環境を再現すると、直す前の作りでは 2倍のページ数になる
//     2. fitSheets（読み込み時に自動実行）で縮めると、どの環境でも「頭数÷3」ページちょうどに戻る
//     3. Excel: 「台帳」シートに全頭が3頭ずつ並び、ブロックごとに改ページ（A4縦・横1ページ）、印刷範囲つき
//     4. Excel: 「一覧」シートは1頭1行（見出し＋頭数）で、体重は数値
//     5. Excel は openpyxl（Excel 互換の読み込み）で開ける
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path'); const fs = require('fs'); const os = require('os'); const http = require('http');
const { execFileSync } = require('child_process');

const N = 7;  // 3+3+1 → 3ブロック
const ROWS = Array.from({ length: N }, (_, i) => ({
  label_id: `TGC-08-T${String(500 + i)}`, serial_number: 900 + i, species: 'イノシシ',
  capture_date: '2026-07-0' + (1 + (i % 9)), capture_time: '08:05', capture_city: i % 2 ? '南房総市' : '館山市',
  capture_area: i === 1 ? '和田町黒岩字ながいながい小字名のある場所' : '神余', hunter_name: '鈴木輝男', capture_method: i % 2 ? '箱罠' : 'くくり罠',
  finishing_method: 'ナイフ', bleed_time: '08:20', sex: i % 2 ? 'メス' : 'オス', weight_total: 30 + i + 0.5,
  receive_time: '09:10', process_time: '09:40', recorder: '沖', radiation_test_date: '2026-07-10', radiation_result_date: '2026-07-10', radiation_result: '検出下限値以下',
}));
const pdfPages = buf => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;

(async () => {
  const root = path.resolve(__dirname, '../..');
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9078);
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/rest/v1/**', rt => rt.fulfill({ contentType: 'application/json',
    body: JSON.stringify(/individuals\?radiation_test_date/.test(decodeURIComponent(rt.request().url())) ? ROWS : []) }));
  await page.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  await page.goto('http://localhost:9078/index.html');
  await page.waitForTimeout(600);
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

  // ── PDF（印刷用HTML） ──
  const html = await page.evaluate(async () => {
    let out = ''; window.open = () => ({ document: { open() {}, write(h) { out += h; }, close() {} } });
    document.getElementById('rad-copy-month').value = '2026-07';
    await radGenerateReport(); return out;
  });
  T('印刷用HTMLに fitSheets（1ページに収める処理）が入っている', /function fitSheets/.test(html) && /fitSheets\(\);/.test(html), '');
  const expected = Math.ceil(N / 3);
  const pp = await (await browser.newContext()).newPage();
  // 文字が大きくなる環境を再現（Windows の游ゴシック等で折り返しが増えた状態）
  const bigFont = '<style>.t th,.t td{font-size:12.5pt !important;line-height:1.55 !important}</style>';
  const noAuto = html.replace('window.onload=function(){fitSheets();', 'window.onload=function(){');
  await pp.setContent(noAuto.replace('</head>', bigFont + '</head>')); await pp.waitForTimeout(300);
  const before = pdfPages(await pp.pdf({ preferCSSPageSize: true }));
  T(`文字が大きい環境では直す前の作りだとページが割れる（${expected}枚のはずが ${before}ページ）`, before > expected, before);
  await pp.evaluate(() => fitSheets());
  const after = pdfPages(await pp.pdf({ preferCSSPageSize: true }));
  T(`fitSheetsで「頭数÷3」=${expected}ページちょうどに戻る`, after === expected, after);
  const maxMm = await pp.$$eval('.sheet', els => Math.max(...els.map(e => e.getBoundingClientRect().height)) * 25.4 / 96);
  T('どの1枚もA4の印字範囲（265mm）以内', maxMm <= 265, maxMm.toFixed(1));
  // 普段の環境（文字そのまま）では縮めない
  await pp.setContent(html.replace(/window\.print\(\);/, '')); await pp.waitForTimeout(500);
  const zooms = await pp.$$eval('.sheet', els => els.map(e => e.style.zoom || ''));
  // 1枚目は長い住所（折り返し）を入れてあるので限界近い。2・3枚目（普通の内容）は縮めない
  T('はみ出さない普段の内容の枚は縮めない', zooms[1] === '' && zooms[2] === '', zooms.join(','));
  T('限界に近い枚だけ必要な分だけ縮める（1枚目）', zooms[0] === '' || (+zooms[0] > 0.9 && +zooms[0] < 1), zooms[0]);
  T('普段の環境でも頭数÷3ページ', pdfPages(await pp.pdf({ preferCSSPageSize: true })) === expected, '');

  // ── Excel ──
  // このテスト環境のヘッドレスChromiumは日本語のファイル名を「download」に置き換えるため、アプリが付けた名前（a.download）を見る
  await page.evaluate(() => { window.__dlName = null; const orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) window.__dlName = this.download; return orig.call(this); }; });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => radLedgerExcel())]);
  const dlName = await page.evaluate(() => window.__dlName);
  const file = path.join(os.tmpdir(), 'ledger-test-' + Date.now() + '.xlsx');
  await dl.saveAs(file);
  T('ファイル名が台帳のPDFと同じ名前＋.xlsx', /^イノシシ搬入・処理管理台帳7月分（TGC-08-T500~TGC-08-T506）\.xlsx$/.test(dlName || ''), dlName);
  const py = `
import openpyxl, json, sys
wb = openpyxl.load_workbook(sys.argv[1])
ws = wb['台帳']; li = wb['一覧']
vals = [c.value for row in ws.iter_rows() for c in row if c.value is not None]
print(json.dumps({
  'sheets': wb.sheetnames,
  'ids': [v for v in vals if isinstance(v, str) and v.startswith('TGC-08-T')],
  'breaks': [b.id for b in ws.row_breaks.brk],
  'paper': ws.page_setup.paperSize, 'orient': ws.page_setup.orientation, 'fitW': ws.page_setup.fitToWidth, 'fitH': ws.page_setup.fitToHeight, 'fitToPage': ws.sheet_properties.pageSetUpPr.fitToPage,
  'print_area': str(ws.print_area), 'list_rows': li.max_row, 'list_head': [c.value for c in li[1]][:3],
  'weight': li['K2'].value, 'titles': sum(1 for v in vals if v == 'イノシシの搬入・処理管理台帳'),
  'sex_t501': [c.value for row in ws.iter_rows() for c in row if c.value is not None and str(c.value) in ('オス','メス')][:3],
}, ensure_ascii=False))`;
  let info = null;
  try { info = JSON.parse(execFileSync('python3', ['-c', py, file], { encoding: 'utf8' })); } catch (e) { T('openpyxlで開ける', false, e.message.slice(0, 200)); }
  if (info) {
    T('openpyxlで開ける（シート「台帳」「一覧」）', JSON.stringify(info.sheets) === JSON.stringify(['台帳', '一覧']), JSON.stringify(info.sheets));
    T('台帳シートに全頭の個体番号', ROWS.every(r => info.ids.includes(r.label_id)) && info.ids.length === N, info.ids.join(','));
    T('3頭ごとに1ブロック（表題がブロック数ぶん）', info.titles === expected, info.titles);
    T('ブロックごとに改ページ（ブロック数−1か所）', info.breaks.length === expected - 1, JSON.stringify(info.breaks));
    T('A4縦・横幅1ページに合わせる', info.paper == 9 && info.orient === 'portrait' && info.fitW == 1 && info.fitH == 0 && info.fitToPage === true, JSON.stringify(info));
    T('印刷範囲が設定されている', /A\$1:\$D\$\d+/.test(info.print_area), info.print_area);
    T('一覧シートは見出し＋1頭1行', info.list_rows === N + 1 && info.list_head[1] === '個体管理番号', JSON.stringify(info.list_head) + ' rows=' + info.list_rows);
    T('一覧の体重は数値（並べ替え・計算できる）', typeof info.weight === 'number' && info.weight === 30.5, info.weight);
  }
  try { fs.unlinkSync(file); } catch (e) {}

  T('ページエラーなし', errors.length === 0, errors.join(' / '));
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close(); srv.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
