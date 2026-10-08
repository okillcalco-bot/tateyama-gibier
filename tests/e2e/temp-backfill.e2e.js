// 庫内温度の過去分入力（管理者）
//
//   きっかけ（2026-10-08）
//     「温度記録表も統一したいので、管理者が過去分を簡単に入力できるようにして」。
//     温度入力を必須にした 9/16 より前は、温度空欄の記録か、記録自体が無い日が並んでいた。
//
//   ここで測ること
//     1. 管理者だけに表示。スタッフには出ない
//     2. 月の各日が並び、記録済み／未記録（温度空欄の記録あり）／作業日を見分けられる
//     3. 「未記録の作業日に入れる」は作業日だけ埋め、記録済みの日・作業の無い日は触らない
//     4. 保存: 温度空欄の記録があれば PATCH（温度＋後日記入の印）、無ければ POST（日本時間の時刻・後日記入の印）
//     5. 入力が足りない日があれば保存しない（どの日か画面に出す）。失敗は件数と日付を出す
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

async function open(browser, role, state) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Tokyo' });
  await ctx.addInitScript(r => { try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', r); } catch (e) {} }, role);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => {
    const u = r.request().url(), m = r.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = (b, s) => r.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/rest\/v1\/cleaning_logs/.test(u)) {
      if (m === 'GET') return J(state.logs);
      const body = JSON.parse(r.request().postData() || '{}');
      state.writes.push({ m, q: decodeURIComponent(u.split('?')[1] || ''), body });
      if (state.failOn && body.cleaned_at && body.cleaned_at.startsWith(state.failOn)) return J({ message: 'boom' }, 500);
      return J([Object.assign({ id: 'new' }, body)]);
    }
    if (/\/rest\/v1\/attendance/.test(u)) return J(state.atts);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html') + '?tab=cleaning');
  await page.waitForTimeout(700);
  return { page, ctx, errors };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);
  const mk = () => ({
    logs: [
      { id: 'L1', room: '冷蔵・冷凍庫', staff_name: '吉田友美', cleaned_at: '2026-09-01T08:00:00+00:00', temperature: '冷蔵-1 / 冷凍-20', note: null },
      { id: 'L2', room: '冷蔵・冷凍庫', staff_name: '川島幸子', cleaned_at: '2026-09-02T08:00:00+00:00', temperature: null, note: '扉パッキン確認' },
      { id: 'L3', room: '解体室', staff_name: '川島幸子', cleaned_at: '2026-09-03T08:00:00+00:00', temperature: null, note: null },
    ],
    atts: [{ work_date: '2026-09-01', clock_in: '08:00' }, { work_date: '2026-09-02', clock_in: '08:00' }, { work_date: '2026-09-04', clock_in: '08:00' }],
    writes: [],
  });

  // スタッフには出ない
  {
    const { page, ctx } = await open(browser, 'staff', mk());
    const vis = await page.evaluate(() => { tempBackfillInit(); return getComputedStyle(document.getElementById('temp-backfill')).display; });
    T('スタッフには表示しない', vis === 'none', vis);
    await ctx.close();
  }

  const st = mk();
  const { page, ctx, errors } = await open(browser, 'admin', st);
  await page.evaluate(() => { tempBackfillInit(); document.getElementById('tb-month').value = '2026-09'; return tempBackfillLoad(); });
  await page.waitForTimeout(300);
  const vis = await page.evaluate(() => getComputedStyle(document.getElementById('temp-backfill')).display);
  T('管理者には表示する', vis !== 'none', vis);
  const rows = await page.$$eval('#tb-rows tr', trs => trs.map(t => t.textContent.replace(/\s+/g, ' ').trim()));
  T('9月は30行', rows.length === 30, String(rows.length));
  T('9/1 は記録済み（日本時間 17:00・確認者）', /9\/1\(火\).*冷蔵-1 \/ 冷凍-20（17:00 吉田友美）.*記録済み/.test(rows[0]), rows[0]);
  T('9/2 は未記録（温度空欄の記録あり）', /未記録（温度空欄の記録あり）/.test(rows[1]), rows[1]);
  T('9/3 は清掃記録があるので作業日', /^9\/3\(木\)\s*○\s*未記録/.test(rows[2]), rows[2]);
  T('9/5 は作業日でない', /^9\/5\(土\)\s*未記録/.test(rows[4]), rows[4]);
  const sum = await page.$eval('#tb-summary', e => e.textContent);
  T('集計: 記録済み1日・未記録29日（作業日3日）', /記録済み 1日/.test(sum) && /未記録 29日（うち作業日 3日）/.test(sum), sum);

  // 一括で入れる
  await page.fill('#tb-r', '2'); await page.fill('#tb-f', '－20'); await page.fill('#tb-time', '17:30');
  await page.selectOption('#tb-staff', '沖浩志');
  await page.evaluate(() => tempBackfillFill());
  const filled = await page.$$eval('#tb-rows tr.tb-row', trs => trs.map(t => { const r = t.querySelector('.tb-r'); return r ? r.value : null; }));
  T('作業日の未記録（9/2・9/3・9/4）だけ埋まる', filled[1] === '2' && filled[2] === '2' && filled[3] === '2' && filled[4] === '' && filled[0] === null, JSON.stringify(filled.slice(0, 6)));

  // 足りない入力があれば保存しない
  await page.evaluate(() => { const tr = document.querySelectorAll('#tb-rows tr.tb-row')[9]; tr.querySelector('.tb-r').value = '3'; });
  await page.evaluate(() => tempBackfillSave());
  await page.waitForTimeout(200);
  const toastTxt = await page.evaluate(() => ([...document.querySelectorAll('.toast')].pop() || {}).textContent || '');
  T('入力が足りない日（9/10）があれば保存しない', st.writes.length === 0 && /09-10/.test(toastTxt), toastTxt);
  await page.evaluate(() => { const tr = document.querySelectorAll('#tb-rows tr.tb-row')[9]; tr.querySelector('.tb-r').value = ''; });

  await page.evaluate(() => tempBackfillSave());
  await page.waitForTimeout(500);
  const patch = st.writes.find(w => w.m === 'PATCH');
  const posts = st.writes.filter(w => w.m === 'POST');
  T('温度空欄の記録（9/2）は PATCH で温度を入れ、元の備考に後日記入の印を足す', !!patch && /id=eq\.L2/.test(patch.q) && patch.body.temperature === '冷蔵2 / 冷凍-20' && /^扉パッキン確認 \/ 後日記入（管理者 \d+\/\d+）$/.test(patch.body.note), JSON.stringify(patch));
  T('記録の無い作業日（9/3・9/4）は POST', posts.length === 2 && posts.every(p => p.body.room === '冷蔵・冷凍庫' && p.body.staff_name === '沖浩志' && p.body.temperature === '冷蔵2 / 冷凍-20' && /^後日記入/.test(p.body.note)), JSON.stringify(posts.map(p => p.body)));
  T('POST の時刻は日本時間（2026-09-03T17:30:00+09:00）', posts.some(p => p.body.cleaned_at === '2026-09-03T17:30:00+09:00'), posts.map(p => p.body.cleaned_at).join(','));
  T('記録済みの日（9/1）は書き換えない', !st.writes.some(w => /L1/.test(w.q)), '');
  await ctx.close();

  // 失敗は画面に出す
  {
    const s2 = mk(); s2.failOn = '2026-09-04';
    const o = await open(browser, 'admin', s2);
    await o.page.evaluate(() => { tempBackfillInit(); document.getElementById('tb-month').value = '2026-09'; return tempBackfillLoad(); });
    await o.page.waitForTimeout(300);
    await o.page.fill('#tb-r', '2'); await o.page.fill('#tb-f', '-20'); await o.page.selectOption('#tb-staff', '沖浩志');
    await o.page.evaluate(() => tempBackfillFill());
    await o.page.evaluate(() => tempBackfillSave());
    await o.page.waitForTimeout(500);
    const t = await o.page.evaluate(() => ([...document.querySelectorAll('.toast')].pop() || {}).textContent || '');
    T('保存失敗は件数と日付を画面に出す', /2日分を保存、1日分が失敗/.test(t) && /09-04/.test(t), t);
    await o.ctx.close();
  }

  T('pageerrorなし', errors.length === 0, errors.join(' / '));
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
