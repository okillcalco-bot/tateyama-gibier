// 出退勤: 昨日の退勤の押し忘れを、翌朝いちばんに気づけるか
//
//   きっかけ（2026年8月の月末チェック）
//     打ち忘れ10件はすべて退勤だった。出勤の抜けは0件。
//     8/2(日)は4人まとまって抜けていて、月末まで誰も気づいていなかった。
//     退勤が空だとその日の勤務時間が0時間になり、給与に反映されない。
//
//   ここで測ること
//     1. 名前を選んだら「昨日の退勤が入っていません」と名指しで出る
//     2. その場から直せるボタンがある
//     3. 出勤を押すときにも一度止めて知らせる（画面のお知らせは見落とされる）
//     4. 昨日がそろっていれば邪魔をしない
//     5. 出勤の抜けと退勤の抜けを取り違えない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = ymd(new Date());
const YEST = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return ymd(d); })();
const OLD = (() => { const d = new Date(); d.setDate(d.getDate() - 5); return ymd(d); })();

const STAFF = [{ id: 's1', name: '吉田友美', default_break_min: 60 }];

async function boot(rows) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const posted = [];
  await page.route('**/*', r => {
    const u = r.request().url(), m = r.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    const q = decodeURIComponent(u.split('?')[1] || '');
    if (/\/rest\/v1\/staff/.test(u)) return J(STAFF);
    if (/\/rest\/v1\/attendance/.test(u)) {
      if (m === 'POST' || m === 'PATCH') { posted.push({ m, q, body: JSON.parse(r.request().postData() || '{}') }); return J([{ id: 'a9' }]); }
      const d = (q.match(/work_date=eq\.([0-9-]+)/) || [])[1];
      if (d) return J(rows.filter(x => x.work_date === d));
      return J(rows);
    }
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../punch.html'));
  await page.waitForTimeout(700);
  return { browser, page, errors, posted };
}

(async () => {
  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  // ── ケース1: 昨日の退勤が抜けている ──
  {
    const { browser, page, errors, posted } = await boot([
      { id: 'a1', staff_id: 's1', staff_name: '吉田友美', work_date: YEST, clock_in: '08:27', clock_out: null, break_minutes: 0 }
    ]);
    const asked = [];
    let answer = false;   // まずは「キャンセル」＝そのまま出勤
    await page.exposeFunction('__rec', m => asked.push(m));
    page.on('dialog', async d => { asked.push(d.message()); answer ? await d.accept() : await d.dismiss(); });

    await page.evaluate(() => select('s1'));
    await page.waitForTimeout(800);

    const shown = await page.evaluate(() => {
      const el = document.getElementById('fix-alert');
      return { visible: el.style.display !== 'none', html: el.innerHTML, text: el.textContent.replace(/\s+/g, ' ') };
    });
    T('昨日の抜けを知らせる', shown.visible, shown.visible);
    T('「昨日」と日付を名指しする',
      /昨日/.test(shown.text) && shown.text.includes(YEST.slice(5).replace('-', '/')), shown.text.slice(0, 60));
    T('退勤が抜けていると分かる', /退勤/.test(shown.text) && !/出勤が入っていません/.test(shown.text), '');
    T('給与に響くことを伝える', /給与に反映されません/.test(shown.text), '');
    T('出勤時刻も見せる（思い出しやすく）', /08:27/.test(shown.text), '');
    T('その場で直せるボタンがある',
      /onclick="fixOpen\('/.test(shown.html) && shown.html.includes(YEST), '');

    // 出勤を押すと、一度止めて知らせる
    asked.length = 0; posted.length = 0;
    await page.evaluate(() => punchIn());
    await page.waitForTimeout(600);
    T('出勤のときにも止めて知らせる', asked.some(a => /昨日/.test(a) && /退勤が入っていません/.test(a)),
      asked.join(' / ').slice(0, 90));
    T('キャンセルならそのまま今日の出勤を通す',
      posted.some(p => p.m === 'POST' && p.body.work_date === TODAY && p.body.clock_in),
      JSON.stringify(posted.map(p => [p.m, p.body.work_date])));

    T('pageerrorなし(1)', errors.length === 0, errors.join(' / '));
    await browser.close();
  }

  // ── ケース2: OKを押したら昨日を直す画面へ。今日の出勤はまだ入れない ──
  {
    const { browser, page, errors, posted } = await boot([
      { id: 'a1', staff_id: 's1', staff_name: '吉田友美', work_date: YEST, clock_in: '08:27', clock_out: null, break_minutes: 0 }
    ]);
    page.on('dialog', async d => { await d.accept(); });
    await page.evaluate(() => select('s1'));
    await page.waitForTimeout(800);
    posted.length = 0;
    await page.evaluate(() => punchIn());
    await page.waitForTimeout(600);
    T('OKなら今日の出勤はまだ入れない',
      !posted.some(p => p.m === 'POST' && p.body.work_date === TODAY), JSON.stringify(posted.map(p => p.body.work_date)));
    const opened = await page.evaluate(() => ({
      box: document.getElementById('fix-box').style.display,
      out: document.getElementById('fix-out') ? document.getElementById('fix-out').value : null,
      inv: document.getElementById('fix-in') ? document.getElementById('fix-in').value : null
    }));
    T('昨日を直す画面が開く', opened.box !== 'none', opened.box);
    T('昨日の出勤が入った状態で開く', opened.inv === '08:27', opened.inv);
    T('退勤は空のまま（本人に入れてもらう）', opened.out === '', JSON.stringify(opened.out));
    T('pageerrorなし(2)', errors.length === 0, errors.join(' / '));
    await browser.close();
  }

  // ── ケース3: 昨日がそろっていれば邪魔をしない ──
  {
    const { browser, page, errors, posted } = await boot([
      { id: 'a1', staff_id: 's1', staff_name: '吉田友美', work_date: YEST, clock_in: '08:27', clock_out: '17:30', break_minutes: 60 }
    ]);
    const asked = [];
    page.on('dialog', async d => { asked.push(d.message()); await d.dismiss(); });
    await page.evaluate(() => select('s1'));
    await page.waitForTimeout(800);
    T('昨日がそろっていれば何も出さない',
      (await page.evaluate(() => document.getElementById('fix-alert').style.display)) === 'none', '');
    posted.length = 0;
    await page.evaluate(() => punchIn());
    await page.waitForTimeout(600);
    T('出勤も止めない', asked.length === 0 && posted.some(p => p.body.work_date === TODAY),
      `dialog${asked.length} / ${JSON.stringify(posted.map(p => p.body.work_date))}`);
    T('pageerrorなし(3)', errors.length === 0, errors.join(' / '));
    await browser.close();
  }

  // ── ケース4: 昨日は無いが、もっと前に抜けがある → 従来どおりのまとめ表示 ──
  {
    const { browser, page, errors } = await boot([
      { id: 'a2', staff_id: 's1', staff_name: '吉田友美', work_date: OLD, clock_in: '08:30', clock_out: null, break_minutes: 0 }
    ]);
    page.on('dialog', async d => { await d.dismiss(); });
    await page.evaluate(() => select('s1'));
    await page.waitForTimeout(800);
    const t = await page.evaluate(() => document.getElementById('fix-alert').textContent.replace(/\s+/g, ' '));
    T('昨日でなければ従来のまとめで知らせる', /打刻が抜けている日が 1日/.test(t), t.slice(0, 60));
    T('この場合は「昨日」と言わない', !/昨日/.test(t), t.slice(0, 40));
    T('pageerrorなし(4)', errors.length === 0, errors.join(' / '));
    await browser.close();
  }

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
