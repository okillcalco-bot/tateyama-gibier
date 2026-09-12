// 精肉モード: 「全部位完了」ボタンは、横持ち・縦持ち・一覧の長さ・スクロールに関係なく常に見えて押せる
//
//   きっかけ（2026-09-10 → 2026-09-12）
//     9/10: 登録済み一覧のスクロールでボタンが流れる → 見出し行に固定して直した。
//     9/12: それでも「押しづらいときがある」。現場の動画（縦持ちのタブレット・Windowsのタスクバー）を
//     実寸で再現して測ると、縦持ち（1カラム）では .pm-body 全体がスクロールするため、見出し行に
//     固定しても登録済みセクションごと画面の外（下端 869〜975px）へ流れていた。
//     対策: ボタンを精肉モード全体の最下段バー（.pm-footer, flex-shrink:0）へ移し、緑・56px以上にした。
//
//   ここで測ること（実寸で描画して位置を測る）
//     1. 横持ち(1180×620)・縦持ち(768×1024, 820×1180)・小さい画面(960×540) のどれでも、
//        20件登録済みの状態でボタンがビューポート内に丸ごと入っている
//     2. ボタンの中心で elementFromPoint がボタン自身（＝何にも覆われず押せる）
//     3. 高さ 48px 以上（指で押せる大きさ）
//     4. 一覧（.pm-completed-scroll）と本体（.pm-body）を最後までスクロールしてもボタンの位置が動かない
//     5. 「全部位完了」ボタンは1つだけ（旧位置に残っていない）。件数・合計kgが下段バーに出る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');

(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9076);

  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = [];
  const ck = (name, cond, got) => results.push([name, cond, got]);
  const PARTS = ['モモ', 'ロース', 'バラ', 'ヒレ', 'カタ', '肩ロース', 'スネ', 'ネック', 'ミンチ用', '味肉用'];

  for (const [w, h, label] of [[1180, 620, '横持ち'], [768, 1024, '縦持ち'], [820, 1180, '縦持ち大'], [960, 540, '小画面']]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true });
    await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/rest/v1/**', route => route.fulfill({ contentType: 'application/json', body: '[]' }));
    await page.goto('http://localhost:9076/index.html');
    await page.waitForTimeout(500);
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

    const measure = () => page.evaluate(() => {
      const bs = [...document.querySelectorAll('button')].filter(b => /全部位完了/.test(b.textContent));
      const b = bs[0]; const rc = b.getBoundingClientRect();
      const hit = document.elementFromPoint(rc.left + rc.width / 2, rc.top + rc.height / 2);
      return { n: bs.length, top: rc.top, bottom: rc.bottom, left: rc.left, right: rc.right, h: rc.height, w: rc.width,
        inView: rc.top >= 0 && rc.bottom <= innerHeight && rc.left >= 0 && rc.right <= innerWidth,
        hitOk: !!hit && (hit === b || b.contains(hit)), hitTag: hit ? hit.tagName + '#' + hit.id : 'null' };
    });
    const before = await measure();
    const pfx = `${label} ${w}×${h}: `;
    ck(pfx + '20件登録済みでもボタンがビューポート内に丸ごと入っている', before.inView, `top=${before.top.toFixed(0)} bottom=${before.bottom.toFixed(0)} / 高さ${h}`);
    ck(pfx + 'ボタンの中心を押すとボタンに当たる（覆われていない）', before.hitOk, before.hitTag);
    ck(pfx + '高さ48px以上', before.h >= 48, `${before.w.toFixed(0)}×${before.h.toFixed(0)}`);
    ck(pfx + 'ボタンは1つだけ', before.n === 1, String(before.n));

    await page.evaluate(() => {
      const s = document.querySelector('.pm-completed-scroll'); if (s) s.scrollTop = s.scrollHeight;
      const b = document.querySelector('.pm-body'); if (b) b.scrollTop = b.scrollHeight;
      const r = document.querySelector('.pm-right'); if (r) r.scrollTop = r.scrollHeight;
    });
    await page.waitForTimeout(150);
    const after = await measure();
    ck(pfx + '一覧・本体を最後までスクロールしてもボタンの位置は動かない', Math.abs(after.top - before.top) < 1 && after.inView, `before top=${before.top.toFixed(0)} after top=${after.top.toFixed(0)}`);
    ck(pfx + 'ページエラーなし', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  // 件数・合計が下段バーに出る
  {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 620 } });
    await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
    const page = await ctx.newPage();
    await page.route('**/rest/v1/**', route => route.fulfill({ contentType: 'application/json', body: '[]' }));
    await page.goto('http://localhost:9076/index.html');
    await page.waitForTimeout(500);
    const txt = await page.evaluate(() => {
      pmIndividual = { label_id: 'TGC-08-T900', species: 'イノシシ', weight_total: 40 };
      pmCompletedParts = [{ part_name: 'モモ', weight_kg: 5, lot_code: 'L1', ident_code: 'X-1', grade: '並' }, { part_name: 'ロース', weight_kg: 3, lot_code: 'L2', ident_code: 'X-2', grade: '並' }];
      pmRenderCompleted();
      return document.getElementById('pmFooter').textContent.replace(/\s+/g, ' ');
    });
    ck('下段バーに件数・合計kg・歩留まりが出る', /2件/.test(txt) && /8\.00 kg/.test(txt) && /20\.0%/.test(txt), txt);
    const txt0 = await page.evaluate(() => { pmCompletedParts = []; pmRenderCompleted(); return document.getElementById('pmFooter').textContent.replace(/\s+/g, ' '); });
    ck('0件のときは 0件 と出る', /0件/.test(txt0), txt0);
    await ctx.close();
  }

  await browser.close(); srv.close();
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 160) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
