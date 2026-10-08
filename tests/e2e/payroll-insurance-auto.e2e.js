// 給与: 保険料の自動計算と「1日の実働を15分単位で切捨て」（2026-10-08）
//
//   きっかけ: 「保険料も自動計算するようにして」「時給の人は15分刻みで計算している」。
//     それまで社会保険料・雇用保険料は毎月手入力（8月分は空欄のまま）。
//
//   ここで測ること（7月の手計算メモと同じ金額になること）
//     1. 今泉（標準報酬200千・介護対象）: 健保9,960＋介護1,620＝11,580（7月メモの11,580と一致）・厚年18,300
//     2. 大和田（170千・介護対象外・厚年対象外）: 健保8,466・介護なし・厚年0（7月メモと一致）
//     3. 雇用保険＝総支給×0.5%、50銭以下切捨て（吉田 総支給171,900 → 859）
//     4. 社保未加入の人は健保・厚年を空欄、雇保未加入は雇保も空欄
//     5. 加入なのに標準報酬月額が無い人は計算せず、名前を画面に出す（黙って0円にしない）
//     6. 「勤怠から取込」で保険料も計算される
//     7. 明細の日別実働は15分単位で切捨て（8:03〜17:53・休憩83分 → 8.25h）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const RATES = { health_pct: 9.73, care_pct: 1.62, child_support_pct: 0.23, pension_pct: 18.3, employment_pct: 0.5 };
const STAFF = [
  { id: 's1', name: '今泉貴雄', hourly_wage: 1200, social_insurance: '加入', employment_insurance: '加入', std_monthly_remuneration: 200000, care_insurance: '対象', pension_insurance: '対象', is_active: true },
  { id: 's2', name: '大和田薫', hourly_wage: 1400, social_insurance: '加入', employment_insurance: '加入', std_monthly_remuneration: 170000, care_insurance: '対象外', pension_insurance: '対象外', is_active: true },
  { id: 's3', name: '吉田友美', hourly_wage: 1200, social_insurance: '加入', employment_insurance: '加入', std_monthly_remuneration: 200000, care_insurance: '対象', pension_insurance: '対象', is_active: true },
  { id: 's4', name: '川島幸子', hourly_wage: 1200, social_insurance: '未加入', employment_insurance: '未加入', is_active: true },
  { id: 's5', name: '石田将来', hourly_wage: 1200, social_insurance: '加入', employment_insurance: '加入', is_active: true },
];
const LINES = [
  { id: 'L1', month: '2026-07', staff_id: 's1', staff_name: '今泉貴雄', hourly_wage: 1200, work_hours: 136.2, stopkill_count: 10 },
  { id: 'L2', month: '2026-07', staff_id: 's2', staff_name: '大和田薫', hourly_wage: 1400, work_hours: 100.5, stopkill_count: 2, commute_round_km: 13, commute_count: 19 },
  { id: 'L3', month: '2026-07', staff_id: 's3', staff_name: '吉田友美', hourly_wage: 1200, work_hours: 136.25, commute_round_km: 20, commute_count: 21, health_insurance: 1 },
  { id: 'L4', month: '2026-07', staff_id: 's4', staff_name: '川島幸子', hourly_wage: 1200, work_hours: 40, health_insurance: 999 },
  { id: 'L5', month: '2026-07', staff_id: 's5', staff_name: '石田将来', hourly_wage: 1200, work_hours: 40 },
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    try { localStorage.setItem('tg_staff_key', 'testkey'); } catch (e) {}
    window.__opened = []; window.open = () => { const w = { document: { write: h => w.html = (w.html || '') + h, close() {} } }; window.__opened.push(w); return w; };
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.dismiss());
  await page.route('**/rest/v1/rpc/admin_payroll_list', rt => rt.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ lines: JSON.parse(JSON.stringify(LINES)), staff: STAFF, rates: RATES, attendance: [{ staff_name: '今泉貴雄', days: 21, hours: 143, extra_km: 0 }], trips: [], trip_rates: [], bonuses: [] }) }));
  await page.route('**/rest/v1/rpc/staff_key_ok', rt => rt.fulfill({ status: 200, contentType: 'application/json', body: 'true' }));
  await page.route('**/rest/v1/attendance**', rt => rt.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify([{ work_date: '2026-07-02', clock_in: '08:03', clock_out: '17:53', break_minutes: 83 }]) }));
  await page.goto('file://' + path.resolve(__dirname, '../../payroll.html'));
  await page.fill('#month', '2026-07');
  await page.evaluate(() => load()); await page.waitForTimeout(300);

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);
  T('「保険料を計算」ボタンがある', await page.$('button:has-text("保険料を計算")') !== null, '');

  await page.evaluate(() => insuranceAll());
  const g = await page.evaluate(() => Object.fromEntries(lines.map(l => [l.staff_name, { h: l.health_insurance, c: l.care_insurance, p: l.pension, e: l.employment_insurance, pay: calc(l).pay }])));
  const im = g['今泉貴雄'], ow = g['大和田薫'], yo = g['吉田友美'], ka = g['川島幸子'];
  T('今泉: 健保9,960＋介護1,620＝11,580（7月メモと一致）・厚年18,300', im.h === 9960 && im.c === 1620 && im.h + im.c === 11580 && im.p === 18300, JSON.stringify(im));
  T('今泉: 雇保967（総支給193,440×0.5%、7月メモと一致）', im.pay === 193440 && im.e === 967, JSON.stringify(im));
  T('大和田: 健保8,466・介護なし・厚年0（7月メモと一致）', ow.h === 8466 && ow.c === '' && ow.p === 0, JSON.stringify(ow));
  T('大和田: 雇保 = 総支給×0.5%（151,640 → 758、7月メモと一致）', ow.pay === 151640 && ow.e === 758, JSON.stringify(ow));
  T('吉田: 雇保は50銭以下切捨て（171,900×0.5%=859.5 → 859）・手入力の1円は計算値で上書き', yo.pay === 171900 && yo.e === 859 && yo.h === 9960, JSON.stringify(yo));
  T('川島（社保・雇保とも未加入）: 健保・厚年・雇保は空欄', ka.h === '' && ka.p === '' && ka.e === '', JSON.stringify(ka));
  const m1 = await page.$eval('#msg', e => e.textContent);
  T('標準報酬月額が無い加入者（石田）は計算せず名前を画面に出す', /石田将来: 社会保険は加入なのに標準報酬月額が未設定/.test(m1) && await page.evaluate(() => lines.find(l => l.staff_name === '石田将来').health_insurance == null), m1);

  // 勤怠から取込でも保険料が入る
  await page.evaluate(() => { lines.forEach(l => { l.health_insurance = null; l.employment_insurance = null; }); importAllAttendance(); });
  const im2 = await page.evaluate(() => { const l = lines.find(x => x.staff_name === '今泉貴雄'); return { hrs: l.work_hours, h: l.health_insurance, e: l.employment_insurance }; });
  T('勤怠から取込: 時間（143h）と保険料が一緒に入る（雇保は新しい総支給で計算）', im2.hrs === 143 && im2.h === 9960 && im2.e === yen50test(143 * 1200 + 30000), JSON.stringify(im2));

  // 日別実働は15分単位で切捨て
  const hrs = await page.evaluate(() => attHrs({ clock_in: '08:03', clock_out: '17:53', break_minutes: 83 }));
  T('日別実働: 8:03〜17:53・休憩83分 → 507分 → 15分切捨てで 8.25h', hrs === 8.25, String(hrs));
  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });

function yen50test(pay) { const x = pay * 0.005, f = Math.floor(x); return x - f > 0.5 ? f + 1 : f; }
