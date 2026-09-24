// 精肉モード: 登録済みの部位一覧が、件数が多いときでも見える（スクロールできる）
//
//   きっかけ（2026-09-24）「精肉モードで、その個体の精肉済みの部位がスクロール無くて見えない
//   （全部位完了に被ってる）から、スクロール付けて見えるようにして」
//
//   実測して分かったこと（1180×620・横持ちタブレット相当）
//     ① .pm-body が CSS Grid で grid-template-rows を指定していなかったため、行の高さが
//        「中身に合わせて自動」になり、.pm-right の高さ計算が不安定だった。
//     ② 上の計量パネル（.pm-weight-section、約378px）だけで .pm-right の高さをほぼ使い切り、
//        「登録済み」セクション（flex:1; min-height:0）が 0px まで潰れていた。
//        0pxということは、スクロールしても中身自体が無いのと同じで、絶対に見えない。
//   対策: .pm-body に grid-template-rows:minmax(0,1fr) を指定して行の高さを固定し、
//   .pm-completed-section に min-height を持たせて潰れきらないようにした
//   （収まらない分は親 .pm-right 自体のスクロールと、内側の .pm-completed-scroll の
//   両方でカバーする）。
//
//   ここで測ること（実寸で描画して位置を測る）
//     1. 部位を15件登録した状態で、.pm-completed-scroll の実際の高さが0pxではない
//        （＝スクロールしても中身がある）
//     2. .pm-right をスクロールすると「登録済み」の見出しとチップが画面内に現れる
//     3. スクロール後、最初のチップ（モモ）がビューポート内に見えている
//     4. 縦持ち（768×1024）でも同様に見出しとチップが現れる
//     5. ページエラーなし
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');

(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9083);

  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = []; const ck = (name, cond, got) => results.push([name, cond, got]);
  const PARTS = ['モモ', 'ロース', 'バラ', 'ヒレ', 'カタ', '肩ロース', 'スネ', 'ネック', 'ミンチ用', '味肉用'];

  for (const [w, h, label] of [[1180, 620, '横持ち'], [768, 1024, '縦持ち']]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true });
    await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/rest/v1/**', route => route.fulfill({ contentType: 'application/json', body: '[]' }));
    await page.goto('http://localhost:9083/index.html');
    await page.waitForTimeout(500);
    await page.evaluate((PARTS) => {
      pmIndividual = { label_id: 'TGC-08-T900', species: 'イノシシ', weight_total: 40 };
      pmRetail = false; pmSelectedPart = null;
      pmCompletedParts = Array.from({ length: 15 }, (_, i) => ({
        part_name: PARTS[i % PARTS.length], weight_kg: Math.round((0.3 + i * 0.05) * 100) / 100,
        lot_code: 'L' + i, ident_code: 'TGC-08-T900-' + i, grade: '並', bone_in: false,
      }));
      document.getElementById('pmOverlay').classList.add('active');
      document.getElementById('pmSetup').style.display = 'none';
      document.getElementById('pmMain').style.display = 'flex';
      pmRenderCompleted();
    }, PARTS);
    await page.waitForTimeout(200);

    const scrollBoxH = await page.evaluate(() => document.querySelector('.pm-completed-scroll').getBoundingClientRect().height);
    ck(`${label}: 登録済み一覧の内側スクロール枠が0pxではない（中身が潰れていない）`, scrollBoxH > 20, scrollBoxH.toFixed(1) + 'px');

    await page.evaluate(() => { document.querySelector('.pm-right').scrollTop = 99999; });
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => {
      const header = [...document.querySelectorAll('.pm-completed-header')][0];
      const chip = document.querySelector('.pm-completed-chip');
      const hr = header.getBoundingClientRect(); const cr = chip.getBoundingClientRect();
      const inView = r => r.top >= 0 && r.top < innerHeight && r.bottom > 0;
      return { headerIn: inView(hr), chipIn: inView(cr), chipText: chip.textContent.replace(/\s+/g, ' ').trim() };
    });
    ck(`${label}: .pm-right をスクロールすると「登録済み」見出しが画面内に現れる`, after.headerIn, JSON.stringify(after));
    ck(`${label}: スクロール後、最初のチップ（モモ）が画面内に見える`, after.chipIn && /モモ/.test(after.chipText), after.chipText);
    ck(`${label}: ページエラーなし`, errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  await browser.close(); srv.close();
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
