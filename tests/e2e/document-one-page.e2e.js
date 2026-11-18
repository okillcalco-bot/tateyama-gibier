// 書類（納品書・請求書など）: A4 1枚に収める。合計（税込）だけが2ページ目に送られない
//
//   きっかけ（2026-11-18）
//     まるい向け納品書（明細1行）を印刷すると、合計（税込）の行だけが2ページ目に送られた。
//     こちらのPDFでは1枚に収まっていた（下に79mmの余り）が、パソコンによって文字の高さが違い、
//     行が高くなると A4 1枚を超える。余りに頼らず「印刷の前に測って、超える分だけ縮める」ようにした。
//
//   ここで測ること（実際にPDFにしてページ数と文字の位置を測る。宛名・明細は架空）
//     1. 普通の環境・明細1行: 1ページ。縮めない（文字の大きさはそのまま）
//     2. 行が高くなる環境（文字の高さが大きいパソコンを再現）・明細1行: 縮めずに測ると2ページになる条件で、1ページに収まり、合計（税込）が1ページ目にある
//     3. 請求書・振込先あり・明細20行: 1ページ
//     4. 明細60行（縮めても入らない量）: 縮めすぎない（0.6倍以上）。合計の表は途中で分かれない（小計と合計が同じページ）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ISSUER = { issuer_name: '架空商店合同会社', issuer_sub: '架空ジビエ処理所', postal: '000-0000', address: '架空県架空市1-2-3', tel: '000-0000-0000', email: 'test@example.invalid', reg_number: 'T0000000000000' };
const line = (i, name) => ({ name: name || `[11/18納品分] 架空肉 部位${i}`, qty: 1.25 + i / 100, unit: 'kg', price: 3055, tax: 8 });
// 文字の高さが大きいパソコンを再現（行の高さ・字間が広がる）
const TALL = 'th,td{padding:15px 8px!important;line-height:2.3!important}body{line-height:2.3!important}h1{margin-bottom:40px!important}.top{margin-bottom:40px!important}';

(async () => {
  const outDir = process.env.DOC_TEST_OUT || require('os').tmpdir();
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/rest/v1/**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.addInitScript(() => { try { localStorage.setItem('tg_staff_key', 'TESTKEY'); } catch (e) {} });
  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(700);

  const build = (doc) => page.evaluate(d => {
    let captured = '';
    window.open = () => ({ document: { open() {}, write(s) { captured += s; }, close() {} } });
    invRenderPrint(d, d.type === '請求書' ? 'INV-TEST-001' : 'DLV-TEST-001', {});
    return captured;
  }, doc);

  // HTMLを開いてPDFにし、ページ数・合計の位置・縮めた倍率を測る
  let k = 0;
  const render = async (html, extraCss, noFit) => {
    if (extraCss) html = html.replace('</style>', extraCss + '</style>');
    if (noFit) html = html.replace("window.addEventListener('load',fit);", '').replace("window.addEventListener('beforeprint',fit);", '').replace('window.__docFit=fit;', '');
    const f = path.join(outDir, `doc-one-page-${++k}`);
    fs.writeFileSync(f + '.html', html);
    const p = await ctx.newPage();
    p.on('pageerror', e => errors.push(e.message));
    await p.goto('file://' + f + '.html');
    await p.waitForTimeout(300);
    const zoom = await p.evaluate(() => { const s = document.querySelector('.sheet'); return s.style.zoom ? Number(s.style.zoom) : 1; });
    await p.emulateMedia({ media: 'print' });
    if (!noFit) await p.evaluate(() => window.__docFit && window.__docFit());
    const zoomPrint = await p.evaluate(() => { const s = document.querySelector('.sheet'); return s.style.zoom ? Number(s.style.zoom) : 1; });
    await p.pdf({ path: f + '.pdf', format: 'A4', preferCSSPageSize: true, printBackground: true });
    await p.close();
    const m = JSON.parse(execFileSync('python3', ['-c', `
import pymupdf, json, sys
d = pymupdf.open(sys.argv[1])
def find(t):
    for i, pg in enumerate(d):
        if pg.search_for(t): return i + 1
    return 0
mm = 25.4 / 72
bottoms = []
for pg in d:
    ys = [b[3] for b in pg.get_text('blocks') if b[4].strip()]
    bottoms.append((pg.rect.height - max(ys)) * mm if ys else -1)
print(json.dumps({'pages': len(d), 'total': find('合計（税込）'), 'sub': find('小計（税抜）'), 'bottoms': bottoms}))
`, f + '.pdf'], { encoding: 'utf8' }));
    return Object.assign(m, { zoom, zoomPrint });
  };

  const results = [];
  const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);
  const show = m => `pages=${m.pages} 合計=${m.total}ページ目 小計=${m.sub}ページ目 倍率=${m.zoomPrint} 下余白=${m.bottoms.map(b => b.toFixed(1)).join(',')}mm`;

  const one = { type: '納品書', name: '架空商事株式会社', honorific: '様', date: '2026-11-18', due: '2026-11-18', issuer: ISSUER, lines: [line(1, '[11/18納品分] 架空肉 ロース')], bank: '', memo: '' };
  const htmlOne = await build(one);

  // 1. 普通の環境
  const a = await render(htmlOne);
  T('1. 普通の環境・明細1行: 1ページ', a.pages === 1 && a.total === 1, show(a));
  T('1. 収まるときは縮めない（文字の大きさはそのまま）', a.zoom === 1 && a.zoomPrint === 1, show(a));

  // 2. 行が高くなる環境: 縮めないと2ページになる条件であることを確かめてから、直した版を測る
  const b0 = await render(htmlOne, TALL, true);
  T('2. （前提）行が高い環境で縮めないと、合計が2ページ目に送られる', b0.pages >= 2 && b0.total >= 2, show(b0));
  const b = await render(htmlOne, TALL);
  T('2. 行が高い環境でも1ページに収まる', b.pages === 1, show(b));
  T('2. 合計（税込）は1ページ目', b.total === 1 && b.sub === 1, show(b));
  T('2. 縮めすぎない（0.6倍以上）', b.zoomPrint >= 0.6 && b.zoomPrint < 1, show(b));

  // 3. 請求書・振込先あり・明細20行
  const many = { type: '請求書', name: '架空商事株式会社', honorific: '様', date: '2026-11-18', due: '2026-12-31', issuer: ISSUER,
    lines: Array.from({ length: 20 }, (_, i) => line(i + 1)), bank: '架空銀行 架空支店 普通 0000000\n架空商店合同会社', memo: '架空のメモ' };
  const c = await render(await build(many));
  T('3. 請求書・振込先あり・明細20行: 1ページ', c.pages === 1 && c.total === 1, show(c));

  // 4. 明細60行: 縮めすぎず、合計の表は分けない
  const huge = Object.assign({}, many, { lines: Array.from({ length: 60 }, (_, i) => line(i + 1)) });
  const d = await render(await build(huge));
  T('4. 明細60行: 縮めすぎない（0.6倍以上）', d.zoomPrint >= 0.6, show(d));
  T('4. 明細60行: 小計と合計（税込）が同じページ（合計の表が途中で分かれない）', d.total > 0 && d.total === d.sub, show(d));
  T('4. どのページも下端に文字がはみ出さない（下余白 5mm 以上）', d.bottoms.every(x => x >= 5), show(d));

  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
