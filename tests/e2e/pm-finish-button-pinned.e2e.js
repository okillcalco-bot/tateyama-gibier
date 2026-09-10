// 精肉モード: 「全部位完了」ボタンが登録済み一覧のスクロールに巻き込まれない
//
//   きっかけ（2026-09-10）
//     現場のタブレットで撮った動画で、登録済み部位が増えると「全部位完了」ボタンが
//     画面の下端に押し出されてほぼ隠れ、押しづらい状態になっていた。
//     .pm-completed-section が「件数＋ボタンの見出し行」と「チップ一覧」をまとめて
//     ひとつのスクロール領域にしていたため、チップが増えるほど見出し行（＝ボタン）
//     ごと上にスクロールして見えなくなっていたのが原因。
//     見出し行を固定し、チップ一覧だけを内側でスクロールさせるよう直した。
//
//   ここで測ること（実寸で描画して位置を測る）
//     1. 登録済み部位が多い（20件）状態でも、ボタンの座標が
//        .pm-completed-section の表示領域内に収まっている（画面外・クリップされていない）
//     2. チップ一覧を一番下までスクロールしても、ボタンの画面上の位置（bounding rect）が動かない
//        （＝ボタンは見出し行として固定され、一覧だけが独立してスクロールしている）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');

(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9076);

  // 現場のタブレット（横向き・縦の高さが限られる）を想定した小さめのビューポート
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 620 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/rest/v1/**', route => route.fulfill({ contentType: 'application/json', body: '[]' }));

  await page.goto('http://localhost:9076/index.html');
  await page.waitForTimeout(500);

  const results = [];
  const ck = (name, cond, got) => results.push([name, cond, got]);

  // 部位を20件登録済みにして一覧を長くする（現場で溜まっていく状況を再現）
  const PARTS = ['モモ', 'ロース', 'バラ', 'ヒレ', 'カタ', '肩ロース', 'スネ', 'ネック', 'ミンチ用', '味肉用'];
  await page.evaluate((PARTS) => {
    pmIndividual = { label_id: 'TGC-08-T900', species: 'イノシシ', weight_total: 40 };
    pmRetail = false; pmSelectedPart = null;
    pmCompletedParts = Array.from({ length: 20 }, (_, i) => ({
      part_name: PARTS[i % PARTS.length], weight_kg: Math.round((0.3 + i * 0.05) * 100) / 100,
      lot_code: 'L' + i, ident_code: 'TGC-08-T900-' + i, grade: '並', bone_in: false,
    }));
    document.getElementById('pmOverlay').classList.add('active');
    document.getElementById('pmSetup').style.display = 'none';
    document.getElementById('pmMain').style.display = 'flex';
    pmRenderCompleted();
  }, PARTS);
  await page.waitForTimeout(200);

  const sectionBox = await page.$eval('.pm-completed-section', el => el.getBoundingClientRect());
  const btnBoxBefore = await page.$eval('button[onclick="pmFinishIndividual()"]', el => el.getBoundingClientRect());

  ck('登録済みチップが20件描画される',
    (await page.$$eval('.pm-completed-chip', els => els.length)) === 20);

  ck('ボタンが .pm-completed-section の表示領域内に収まっている（画面外にはみ出していない）',
    btnBoxBefore.top >= sectionBox.top - 1 && btnBoxBefore.bottom <= sectionBox.bottom + 1,
    `section top=${sectionBox.top.toFixed(1)} bottom=${sectionBox.bottom.toFixed(1)} / button top=${btnBoxBefore.top.toFixed(1)} bottom=${btnBoxBefore.bottom.toFixed(1)}`);

  ck('ボタンがビューポート内に収まっている（タスクバー等で隠れていない）',
    btnBoxBefore.bottom <= 620 && btnBoxBefore.top >= 0,
    `button bottom=${btnBoxBefore.bottom.toFixed(1)} viewport height=620`);

  // 一覧だけを最後までスクロールする
  await page.$eval('.pm-completed-scroll', el => { el.scrollTop = el.scrollHeight; });
  await page.waitForTimeout(150);

  const btnBoxAfter = await page.$eval('button[onclick="pmFinishIndividual()"]', el => el.getBoundingClientRect());
  ck('一覧を一番下までスクロールしてもボタンの画面上の位置は動かない（見出し行として固定）',
    Math.abs(btnBoxAfter.top - btnBoxBefore.top) < 1 && Math.abs(btnBoxAfter.bottom - btnBoxBefore.bottom) < 1,
    `before top=${btnBoxBefore.top.toFixed(1)} / after top=${btnBoxAfter.top.toFixed(1)}`);

  const scrollTop = await page.$eval('.pm-completed-scroll', el => el.scrollTop);
  ck('チップ一覧側は実際にスクロールしている（スクロール自体は機能している）', scrollTop > 0, String(scrollTop));

  ck('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close(); srv.close();
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 160) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
