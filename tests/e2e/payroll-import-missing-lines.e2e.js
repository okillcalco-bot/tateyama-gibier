// 給与計算（payroll.html）: 「勤怠から日数・時間を取込」で全員分が反映されるか
//
//   きっかけ（2026-09-10）
//     「8月の給与計算したいんだけど、みんな勤怠入力してるのに1人分しか取り込めない」
//     という指摘。実測: 2026-08は10人が打刻していたが、payroll_linesの明細行は
//     今泉貴雄の1人分しか無かった。取込ボタンは既存の明細行にしか反映しないため、
//     行が無い人はそもそも画面に出てこず、取り込みようがなかった。
//
//   ここで測ること
//     1. 明細行が1人分しか無くても、勤怠のある全員が取込で行ごと追加される
//     2. 追加された行にも日数・時間が正しく入る
//     3. すでにある行（今泉貴雄）はそのまま取り込まれる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { localStorage.setItem('tg_staff_key', 'testkey'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { await d.dismiss(); });

  const STAFF = [
    { id: 's1', name: '今泉貴雄', hourly_wage: 1200, commute_round_km: 10, commute_yen_per_km: 20, stopkill_eligible: true, is_active: true, deleted: false },
    { id: 's2', name: '吉田友美', hourly_wage: 1100, commute_round_km: 8, commute_yen_per_km: 20, stopkill_eligible: false, is_active: true, deleted: false },
    { id: 's3', name: '大和田薫', hourly_wage: 1100, commute_round_km: 6, commute_yen_per_km: 20, stopkill_eligible: false, is_active: true, deleted: false },
  ];
  const LINES = [
    { id: 'L1', month: '2026-08', staff_id: 's1', staff_name: '今泉貴雄', hourly_wage: 1200, work_days: null, work_hours: null },
  ];
  const ATTENDANCE = [
    { staff_name: '今泉貴雄', days: 22, hours: 149.6 },
    { staff_name: '吉田友美', days: 20, hours: 140 },
    { staff_name: '大和田薫', days: 18, hours: 126.5 },
  ];

  await page.route('**/rest/v1/rpc/admin_payroll_list', rt => rt.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ lines: LINES, staff: STAFF, attendance: ATTENDANCE, trips: [], trip_rates: [] }),
  }));
  await page.route('**/rest/v1/rpc/staff_key_ok', rt => rt.fulfill({ status: 200, contentType: 'application/json', body: 'true' }));
  await page.route('**/rest/v1/rpc/admin_payroll_upsert', rt => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify('L-new') }));
  await page.route('**/rest/v1/attendance**', rt => rt.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

  await page.goto('file://' + path.resolve(__dirname, '../../payroll.html'));
  await page.waitForTimeout(600);

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  const staffNames = async () => page.$$eval('#body tr td:first-child', els => els.map(e => e.textContent.trim()));

  let names = await staffNames();
  T('初期表示は明細行1名分だけ', names.length === 1 && names[0].includes('今泉貴雄'), JSON.stringify(names));

  await page.click('button:has-text("勤怠から日数・時間を取込")');
  await page.waitForTimeout(200);

  names = await staffNames();
  T('取込で勤怠のある3名分に行が増える', names.length === 3, JSON.stringify(names));
  T('吉田友美の行が追加される', names.some(n => n.includes('吉田友美')), JSON.stringify(names));
  T('大和田薫の行が追加される', names.some(n => n.includes('大和田薫')), JSON.stringify(names));

  const daysVals = await page.$$eval('#body tr', trs => trs.map(tr => tr.querySelectorAll('input')[1]?.value)); // 0:hourly_wage 1:work_days
  T('追加された行にも勤怠の日数が入る（20・18を含む）',
    daysVals.includes('20') && daysVals.includes('18'), JSON.stringify(daysVals));

  const msg = await page.$eval('#msg', el => el.textContent);
  T('新規追加を知らせるメッセージが出る', /新規追加/.test(msg), msg);

  T('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
