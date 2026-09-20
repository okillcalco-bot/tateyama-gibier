// マニュアルタブ「⑫ 解体室の清掃手順（場所別・頻度つき）」（2026-09-20 一次版）
//
//   きっかけ 「清掃マニュアルに更新しといて」（沖・一次回答、近日中に見直し予定）
//   天井 → 棚 → 流し・台 → 壁 → 床 → 下水 → 仕上げ → 補充 の場所別に、作業と頻度
//   （毎日／使用時／時間があれば／詰まった時）を並べたもの。画面参照と A4 印刷の両方で使う。
//
//   ここで測ること
//     1. マニュアルタブのカード一覧に載り、開くと 24 の場所・66 の作業が頻度の印つきで出る
//     2. 頻度の内訳（毎日52／詰まった時7／使用時4／時間があれば3）が原文どおり
//     3. 補足（※ 脚立・踏み台、20号のビニール袋 など）が消えていない
//     4. 版（一次版 2026-09-20）と「清掃記録に記録」の注意が出る
//     5. 印刷（A4縦）で 1つの場所のかたまりが1ページに収まる高さで、横にはみ出さない
//     6. 「全手順をまとめて印刷」に含まれる（12枚目）
//     7. 清掃記録ダイアログ: 解体室のときだけ手順へのボタンが出る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await ctx.addInitScript(() => { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', rt => {
    const u = rt.request().url();
    if (u.startsWith('file:')) return rt.continue();
    if (/cdnjs|jsdelivr|fonts\./.test(u)) return rt.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    return rt.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html') + '?tab=manual');
  await page.waitForTimeout(900);
  const results = []; const ck = (n, c, g) => results.push([n, c, g]);

  const card = await page.evaluate(() => { const c = [...document.querySelectorAll('#manual-index > div')].find(d => /解体室の清掃手順/.test(d.textContent)); return c ? c.textContent.replace(/\s+/g, ' ') : null; });
  ck('マニュアルタブのカード一覧に「⑫ 解体室の清掃手順（場所別・頻度つき）」', card && /⑫/.test(card) && /解体担当スタッフ/.test(card), card || 'なし');

  await page.evaluate(() => manualOpen('clean_kaitai'));
  await page.waitForTimeout(300);
  const v = await page.evaluate(() => {
    const sh = document.querySelector('#manualView .mv-sheet');
    const freq = {}; sh.querySelectorAll('.mv-task .mv-freq').forEach(f => { freq[f.textContent] = (freq[f.textContent] || 0) + 1; });
    return { shown: getComputedStyle(document.getElementById('manualView')).display, h1: sh.querySelector('h1').textContent, foot: sh.querySelector('.mv-foot').textContent,
      groups: [...sh.querySelectorAll('.mv-grp-h')].map(h => h.textContent.replace(/^\d+/, '')), tasks: sh.querySelectorAll('.mv-task').length, freq,
      legend: sh.querySelector('.mv-legend').textContent, meta: sh.querySelector('.mv-meta').textContent, caution: (sh.querySelector('.mv-caution') || {}).textContent,
      text: sh.textContent.replace(/\s+/g, ' ') };
  });
  ck('開くと画面ビューが出て、見出しは「解体室の清掃手順」（番号は脚注に）', v.shown === 'block' && /^🧹 解体室の清掃手順/.test(v.h1) && /⑫/.test(v.foot), v.h1);
  ck('場所は 24（天井 → … → 補充）', v.groups.length === 24 && v.groups[0] === '天井・手が届かない高さの壁' && v.groups[23] === '補充' && v.groups.includes('シャッター側の下水'), v.groups.length + ': ' + v.groups.slice(0, 3).join('/'));
  ck('作業は 66 行、すべてに頻度の印', v.tasks === 66 && Object.values(v.freq).reduce((a, b) => a + b, 0) === 66, JSON.stringify([v.tasks, v.freq]));
  ck('頻度の内訳: 毎日52／詰まった時7／使用時4／時間があれば3', v.freq['毎日'] === 52 && v.freq['詰まった時'] === 7 && v.freq['使用時'] === 4 && v.freq['時間があれば'] === 3, JSON.stringify(v.freq));
  ck('補足が残っている（脚立・踏み台／20号のビニール袋／直撃させない／解体台をひっくり返す）', ['脚立', '20号のビニール袋', '直撃させない', 'ひっくり返して洗うのは時間があるとき', '塩素系漂白剤'].every(s => v.text.includes(s)), '');
  ck('印の意味の凡例と、版（一次版 2026-09-20）', /毎日/.test(v.legend) && /詰まった時/.test(v.legend) && /一次版 2026-09-20/.test(v.meta), v.meta);
  ck('注意: 清掃記録(HACCP)タブの解体室で記録する', /清掃記録\(HACCP\)/.test(v.caution || '') && /解体室/.test(v.caution || ''), v.caution);

  // 印刷（A4縦）: 1つの場所のかたまりは1ページ（本文 約265mm）に収まり、横にはみ出さない
  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(200);
  const pr = await page.evaluate(() => {
    const mm = px => px / 96 * 25.4;
    const sh = document.querySelector('#manualView .mv-sheet'); const sw = sh.getBoundingClientRect();
    const grps = [...sh.querySelectorAll('.mv-grp')].map(g => { const r = g.getBoundingClientRect(); return { h: mm(r.height), over: r.right > sw.right + 0.5 || r.left < sw.left - 0.5 }; });
    const tasks = [...sh.querySelectorAll('.mv-task')].map(t => t.getBoundingClientRect()).filter(r => r.right > sw.right + 0.5).length;
    const avoid = [...sh.querySelectorAll('.mv-grp')].every(g => /avoid/.test(getComputedStyle(g).breakInside + getComputedStyle(g).pageBreakInside));
    return { maxGroupMm: Math.max(...grps.map(g => g.h)), overflow: grps.filter(g => g.over).length + tasks, avoid, totalMm: mm(sh.getBoundingClientRect().height) };
  });
  await page.emulateMedia({ media: 'screen' });
  ck('印刷: いちばん長い場所（シャッター側の下水）でも 1ページの本文高さ 265mm 未満', pr.maxGroupMm > 0 && pr.maxGroupMm < 265, pr.maxGroupMm.toFixed(0) + 'mm');
  ck('印刷: 場所のかたまりはページをまたがない指定（break-inside: avoid）', pr.avoid, '');
  ck('印刷: 横にはみ出す行がない', pr.overflow === 0, String(pr.overflow));
  ck('印刷: 全体は A4 3枚以内（約 800mm 未満）', pr.totalMm < 800, pr.totalMm.toFixed(0) + 'mm');

  // 全手順をまとめて印刷 に含まれる
  await page.evaluate(() => manualOpen('all'));
  const all = await page.evaluate(() => ({ n: document.querySelectorAll('#manualView .mv-sheet').length, last: document.querySelector('#manualView .mv-sheet:last-child h1').textContent }));
  ck('「全手順をまとめて印刷」の最後の1枚が解体室の清掃手順（⑥が2つあるので全13枚）', all.n === 13 && /解体室の清掃手順/.test(all.last), JSON.stringify(all));
  await page.evaluate(() => manualClose());

  // 清掃記録ダイアログ: 解体室のときだけ手順へのボタン
  await page.evaluate(() => cleaningOpen('解体室'));
  const l1 = await page.evaluate(() => getComputedStyle(document.getElementById('clean-manual-link')).display);
  await page.evaluate(() => cleaningOpen('精肉室'));
  const l2 = await page.evaluate(() => getComputedStyle(document.getElementById('clean-manual-link')).display);
  ck('清掃記録ダイアログ: 解体室では「手順を見る」ボタンが出て、精肉室では出ない', l1 === 'block' && l2 === 'none', l1 + '/' + l2);
  await page.evaluate(() => { cleaningOpen('解体室'); document.querySelector('#clean-manual-link button').click(); });
  const opened = await page.evaluate(() => getComputedStyle(document.getElementById('manualView')).display === 'block' && /解体室の清掃手順/.test(document.querySelector('#manualView h1').textContent));
  ck('ボタンを押すと手順が開く', opened, '');

  ck('pageerrorなし', errors.length === 0, errors.join(' / '));
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
