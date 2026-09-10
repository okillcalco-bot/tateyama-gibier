// 出退勤: 退勤直後に「打刻もれ」が誤って作られないか
//
//   きっかけ（2026-09-10）
//     石田将来さんの2026-09-04に、退勤済み(13:00→16:14)の行とは別に、
//     7秒後作成の「出勤16:14・退勤なし」の重複行ができていた。
//     利用者の見立て「一度入力すると打刻もれになるのかも」の通り、
//     退勤ボタンのPATCH成功後にローカルのtodayRecを更新していなかったため、
//     showDone()がgoHome()で状態をリセットするまでの6秒間、
//     退勤済みガード(if (todayRec.clock_out) ...)が古い状態のまま素通りし、
//     同じ人がもう一度「出勤」を押すと二重の出勤行ができてしまっていた。
//
//   ここで測ること
//     1. 出勤→退勤の直後、todayRecがPATCHの内容（clock_out等）で更新される
//     2. その直後（goHomeの6秒待ちの前）に再び出勤を押しても、
//        「退勤済みです」のトーストが出るだけで新しい出勤行はPOSTされない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = ymd(new Date());
const STAFF = [{ id: 's1', name: '石田将来', default_break_min: 60 }];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { await d.dismiss(); });

  const posted = [];
  let attendanceRow = null; // サーバー側の状態（出勤POST後にセットされる）

  await page.route('**/*', r => {
    const u = r.request().url(), m = r.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    const q = decodeURIComponent(u.split('?')[1] || '');

    if (/\/rest\/v1\/staff/.test(u)) return J(STAFF);
    if (/\/rest\/v1\/attendance/.test(u)) {
      if (m === 'POST') {
        const body = JSON.parse(r.request().postData() || '{}');
        posted.push({ m, body });
        attendanceRow = Object.assign({ id: 'a1' }, body);
        return J([attendanceRow]);
      }
      if (m === 'PATCH') {
        const body = JSON.parse(r.request().postData() || '{}');
        posted.push({ m, body });
        if (attendanceRow) Object.assign(attendanceRow, body);
        return J([attendanceRow]);
      }
      // GET: work_date指定なら今日の1件（あれば）を返す
      if (/work_date=eq\./.test(q)) return J(attendanceRow ? [attendanceRow] : []);
      return J(attendanceRow ? [attendanceRow] : []);
    }
    return J([]);
  });

  await page.goto('file://' + path.resolve(__dirname, '../../punch.html'));
  await page.waitForTimeout(700);

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  await page.evaluate(() => select('s1'));
  await page.waitForTimeout(800);

  // 1) 出勤
  posted.length = 0;
  await page.evaluate(() => punchIn());
  await page.waitForTimeout(500);
  T('出勤で1件POSTされる', posted.length === 1 && posted[0].m === 'POST', JSON.stringify(posted));

  // 2) 退勤（goHomeの6秒タイマーはまだ発火していない）
  posted.length = 0;
  await page.evaluate(() => punchOut());
  await page.waitForTimeout(500);
  T('退勤で1件PATCHされる', posted.length === 1 && posted[0].m === 'PATCH', JSON.stringify(posted));

  // 3) PATCH直後、ローカルのtodayRecがclock_outを反映しているか
  const rec = await page.evaluate(() => todayRec);
  T('退勤PATCH後、todayRec.clock_outがすぐ更新される', !!(rec && rec.clock_out), JSON.stringify(rec));

  // 4) goHomeの6秒待ちの間に、同じ人がもう一度「出勤」を押しても弾かれる
  const asked = [];
  await page.exposeFunction('__toastSeen', m => asked.push(m));
  await page.evaluate(() => {
    const orig = showToast;
    window.showToast = function (msg) { window.__toastSeen(msg); return orig(msg); };
  });
  posted.length = 0;
  await page.evaluate(() => punchIn());
  await page.waitForTimeout(300);
  T('退勤済みならもう一度の出勤は弾かれる（重複POSTなし）', posted.length === 0, JSON.stringify(posted));
  T('「退勤まで記録済み」のトーストが出る', asked.some(a => /退勤/.test(a) && /記録/.test(a)), asked.join(' / '));

  T('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
