// 給与: 日雇い（作業ごと）の明細（2026-10-09）
//
//   きっかけ: 9月のやわたんまち（9/18仕込み・9/19出店）の手伝い4名の明細を出したい。
//     スタッフ台帳に無く、勤怠の打刻も無い。時間帯で時給が違う（19日18:30〜22:00は1,200円）。
//
//   ここで測ること
//     1. 「9/19 05:00-18:30 2000 内容」を作業1件として読み、金額＝時間×時給（13.5h×2,000＝27,000）
//     2. 時間帯で時給が違う人（佐藤泰夫）: 5h×2,000＋13.5h×2,000＋3.5h×1,200＝41,200
//     3. 実費（高速料金）・交通費（通勤費欄）も支給額に入る。読めない行は反映しない（理由を出す）
//     4. 台帳に無い日雇いは保険料を計算しない（エラーにもしない）。台帳の人は従来どおり
//     5. 明細: 作業ごとの内訳表（日付・時間・時給・金額）と合計、時給×時間の「基本給」行は出さない
//     6. 実寸: A4（186mm幅）で1枚に収まり、見出し（止めさし搬入手当など）が折り返さない
//     7. 保存: allowances に作業が入って送られる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const STAFF = [{ id: 's1', name: '今泉貴雄', hourly_wage: 1200, social_insurance: '加入', employment_insurance: '加入', std_monthly_remuneration: 200000, care_insurance: '対象', pension_insurance: '対象', is_active: true }];
const LINES = [{ id: 'L1', month: '2026-09', staff_id: 's1', staff_name: '今泉貴雄', hourly_wage: 1200, work_hours: 112, work_days: 19, stopkill_count: 7 }];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ timezoneId: 'Asia/Tokyo' });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('tg_staff_key', 'testkey'); } catch (e) {}
    window.__opened = []; window.open = () => { const w = { document: { write: h => w.html = (w.html || '') + h, close() {} } }; window.__opened.push(w); return w; };
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const saved = [];
  page.on('dialog', d => d.accept('佐藤泰夫'));
  await page.route('**/rest/v1/rpc/admin_payroll_list', rt => rt.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ lines: LINES, staff: STAFF, rates: { health_pct: 9.73, care_pct: 1.62, child_support_pct: 0.23, pension_pct: 18.3, employment_pct: 0.5 }, attendance: [], trips: [], trip_rates: [], bonuses: [] }) }));
  await page.route('**/rest/v1/rpc/staff_key_ok', rt => rt.fulfill({ status: 200, contentType: 'application/json', body: 'true' }));
  await page.route('**/rest/v1/rpc/admin_payroll_upsert', rt => { saved.push(JSON.parse(rt.request().postData()).p); rt.fulfill({ status: 200, contentType: 'application/json', body: '"id1"' }); });
  await page.route('**/rest/v1/attendance**', rt => rt.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto('file://' + path.resolve(__dirname, '../../payroll.html'));
  await page.fill('#month', '2026-09');
  await page.evaluate(() => load()); await page.waitForTimeout(300);

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  T('「＋ 日雇い（作業ごと）」ボタンがある', await page.$('button:has-text("日雇い（作業ごと）")') !== null, '');
  const one = await page.evaluate(() => parseWorkText('9/19 05:00-18:30 2000 やわたんまち出店（八幡神社）', '2026-09').items[0]);
  T('作業1行を読む: 9/19 05:00〜18:30 13.5h×2,000＝27,000・内容', one.date === '2026-09-19' && one.hours === 13.5 && one.amount === 27000 && one.label === 'やわたんまち出店（八幡神社）', JSON.stringify(one));
  const br = await page.evaluate(() => parseWorkText('9/26 9:00-13:00 2000 休憩30 ニイチク', '2026-09').items[0]);
  T('休憩を引く（9:00〜13:00 休憩30 → 3.5h×2,000＝7,000）・1桁の時刻も読む', br.hours === 3.5 && br.amount === 7000 && br.start === '09:00' && br.label === 'ニイチク', JSON.stringify(br));
  const night = await page.evaluate(() => parseWorkText('9/18 22:00-01:00 1200', '2026-09').items[0]);
  T('日付をまたぐ作業（22:00〜翌1:00＝3h）', night.hours === 3 && night.amount === 3600, JSON.stringify(night));

  // 佐藤泰夫を追加（名前はprompt）→ 作業を入れて反映
  await page.evaluate(() => addDayWorker());
  await page.waitForTimeout(100);
  T('名前で行を作り、作業の入力画面が開く', await page.$eval('#workModal', e => e.style.display) === 'flex' && /佐藤泰夫/.test(await page.$eval('#wmTitle', e => e.textContent)), '');
  await page.fill('#wmText', 'これは読めない行');
  await page.evaluate(() => workApply());
  T('読めない行があれば反映しない（理由を画面に出す）', /読めない行があります/.test(await page.$eval('#msg', e => e.textContent)) && await page.evaluate(() => !lines.find(l => l.staff_name === '佐藤泰夫').allowances.length), await page.$eval('#msg', e => e.textContent));
  await page.fill('#wmText', ['9/18 18:00-23:00 2000 やわたんまち仕込み（アワコネ）', '9/19 05:00-18:30 2000 やわたんまち出店・片付け（八幡神社）', '9/19 18:30-22:00 1200 やわたんまち出店・片付け（八幡神社）', '実費 3310 高速料金'].join('\n'));
  await page.fill('#wmComm', '2000'); await page.fill('#wmCommMemo', '自家用車 200km（千葉市・調布市〜館山市）');
  await page.evaluate(() => workPreview());
  T('入力中に合計が出る（41,200＋高速3,310＋交通費2,000＝46,510）', /46,510/.test(await page.$eval('#wmPrev', e => e.textContent)), await page.$eval('#wmPrev', e => e.textContent));
  await page.evaluate(() => workApply());
  const g = await page.evaluate(() => { const l = lines.find(x => x.staff_name === '佐藤泰夫'); return { c: calc(l), days: l.work_days, hrs: l.work_hours }; });
  T('作業給 41,200（5h×2,000＋13.5h×2,000＋3.5h×1,200）・支給 46,510・2日 22h', g.c.base === 0 && g.c.pay === 46510 && g.days === 2 && g.hrs === 22, JSON.stringify(g));

  await page.evaluate(() => insuranceAll());
  const m = await page.$eval('#msg', e => e.textContent);
  const ins = await page.evaluate(() => ({ d: lines.find(x => x.staff_name === '佐藤泰夫'), i: lines.find(x => x.staff_name === '今泉貴雄') }));
  T('保険料: 台帳に無い日雇いは計算せず、エラーにもしない／台帳の人は従来どおり', !/佐藤泰夫/.test(m) && ins.d.health_insurance == null && ins.i.health_insurance === 9960, m);

  // 明細
  await page.evaluate(() => payslipSection);
  const html = await page.evaluate(() => { const l = lines.find(x => x.staff_name === '佐藤泰夫'); payslipDocOpen('t', payslipSection(l, '2026-09', [])); return window.__opened.pop().html; });
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  T('明細: 作業ごとの内訳（日付・時間・時給・金額）と合計 41,200', /2026-09-19 18:30〜22:00 3.5h ¥1,200 ¥4,200/.test(text) && /合計 22h ¥41,200/.test(text), text.slice(0, 600));
  T('明細: 作業給・高速料金・交通費（内訳つき）・支給額 46,510', /作業給 ¥41,200/.test(text) && /高速料金 ¥3,310/.test(text) && /交通費 ¥2,000 自家用車 200km/.test(text) && /支給額（総額） ¥46,510/.test(text), '');
  T('明細: 時給×時間の「基本給」行・空の勤怠明細は出さない', !/基本給/.test(text) && !/打刻記録なし/.test(text), '');
  {
    const q = await ctx.newPage();
    await q.setViewportSize({ width: 703, height: 1000 });
    await q.setContent(html); await q.emulateMedia({ media: 'print' });
    const r = await q.evaluate(() => ({ h: document.querySelector('.slip').getBoundingClientRect().height,
      wrapped: [...document.querySelectorAll('.slip > table th')].filter(th => th.getClientRects()[0].height > 40).map(th => th.textContent) }));
    T('実寸: A4縦1枚に収まり（< 1031px）、見出しが折り返さない', r.h < 1031 && r.wrapped.length === 0, JSON.stringify(r));
    // 既存の人の明細も見出しが折り返さない（「止めさし搬入手当」が2行になっていた）
    const h2 = await page.evaluate(() => { payslipDocOpen('t', payslipSection(lines.find(x => x.staff_name === '今泉貴雄'), '2026-09', [])); return window.__opened.pop().html; });
    await q.setContent(h2);
    const r2 = await q.evaluate(() => [...document.querySelectorAll('.slip > table th')].map(th => [th.textContent, th.getClientRects().length && Math.round(th.getBoundingClientRect().height)]));
    const one = r2.find(x => x[0] === '止めさし搬入手当');
    const base = r2.find(x => x[0] === '時給');
    T('実寸: 時給の人の明細で「止めさし搬入手当」が1行（時給の行と同じ高さ）', one && base && one[1] === base[1], JSON.stringify(r2));
    await q.close();
  }

  await page.evaluate(() => saveAll()); await page.waitForTimeout(300);
  const p = saved.find(x => x.staff_name === '佐藤泰夫') || {};
  T('保存: 作業3件と実費が allowances で送られ、交通費は commute_fixed', Array.isArray(p.allowances) && p.allowances.filter(a => a.kind === 'work').length === 3 && p.allowances.some(a => a.kind === 'expense' && a.amount === 3310) && String(p.commute_fixed) === '2000' && p.staff_id === '', JSON.stringify(p).slice(0, 300));
  // 再読込で入力欄に戻る
  const back = await page.evaluate(() => workToText(lines.find(x => x.staff_name === '佐藤泰夫')));
  T('保存した作業を入力欄の形に戻せる', back.split('\n').length === 4 && back.startsWith('9/18 18:00-23:00 2000 やわたんまち仕込み') && back.endsWith('実費 3310 高速料金'), back);
  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
