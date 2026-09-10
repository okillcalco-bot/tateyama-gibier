// 給与計算（payroll.html）: 月給者（沖浩志・田口和利）の基本給が0円になっていた問題
//
//   きっかけ（2026-09-10）
//     「差引支給額をLINEに...僕と田口さんは毎月固定（沖10万、田口22万5千円）だから」
//     という要望で調べたところ、沖浩志・田口和利はstaff.employment_type='月給'
//     staff.monthly_salaryが設定済みだったが、admin_payroll_list/upsertの
//     どちらもmonthly_salaryを一切扱っておらず、画面に届いていなかった。
//     calc()は base=時給×時間 のみだったため、時給が無い月給者は基本給が
//     常に0円近くになっていた（実害: 2026-08分が未反映のままだった）。
//
//   ここで測ること
//     1. 月給が設定されている行は、時給・時間に関係なく月給がそのまま基本給になる
//     2. 時給の行はこれまで通り時給×時間で計算される（回帰）
//     3. スタッフ台帳の月給を後から設定しても、取込（📥）で既存の明細行に反映される
//     4. 「月給」の入力欄が画面にある
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
    { id: 's1', name: '沖浩志', hourly_wage: null, monthly_salary: 100000, employment_type: '月給', is_active: true, deleted: false },
    { id: 's2', name: '田口和利', hourly_wage: null, monthly_salary: 225000, employment_type: '月給', is_active: true, deleted: false },
    { id: 's3', name: '白石秀一', hourly_wage: 1200, monthly_salary: null, employment_type: '時給', is_active: true, deleted: false },
  ];
  const LINES = [
    // まだmonthly_salaryが明細行に無い（=マイグレーション前に作られた行を模す）
    { id: 'L1', month: '2026-08', staff_id: 's1', staff_name: '沖浩志', hourly_wage: null, monthly_salary: null, work_days: 31, work_hours: 248 },
    { id: 'L2', month: '2026-08', staff_id: 's3', staff_name: '白石秀一', hourly_wage: 1200, monthly_salary: null, work_days: 16, work_hours: 51.25 },
  ];

  await page.route('**/rest/v1/rpc/admin_payroll_list', rt => rt.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ lines: LINES, staff: STAFF, attendance: [], trips: [], trip_rates: [] }),
  }));
  await page.route('**/rest/v1/rpc/staff_key_ok', rt => rt.fulfill({ status: 200, contentType: 'application/json', body: 'true' }));
  await page.route('**/rest/v1/attendance**', rt => rt.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

  await page.goto('file://' + path.resolve(__dirname, '../../payroll.html'));
  await page.fill('#month', '2026-08');
  await page.waitForTimeout(600);

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  T('「月給」の入力欄がある', await page.$('th:has-text("月給")') !== null, '');

  // 1) 沖浩志は明細行にmonthly_salaryが無い状態 → まだ基本給0円のはず
  const netBefore = await page.evaluate(() => {
    const i = lines.findIndex(l => l.staff_name === '沖浩志');
    return calc(lines[i]).base;
  });
  T('月給が明細行に無いうちは基本給0円（修正前の再現）', netBefore === 0, String(netBefore));

  // 2) スタッフ台帳の月給を、取込（📥）で明細行に同期する
  const idxOki = await page.evaluate(() => lines.findIndex(l => l.staff_name === '沖浩志'));
  await page.evaluate((i) => {
    const s = staffList.find(x => x.name === '沖浩志');
    lines[i].monthly_salary = s.monthly_salary;
  }, idxOki);
  const baseAfter = await page.evaluate((i) => calc(lines[i]).base, idxOki);
  T('台帳の月給(100000)が同期されると基本給も100,000円になる', baseAfter === 100000, String(baseAfter));

  // 3) 時給の人は従来通り時給×時間で計算される（回帰）
  const idxShiraishi = await page.evaluate(() => lines.findIndex(l => l.staff_name === '白石秀一'));
  const shiraishiBase = await page.evaluate((i) => calc(lines[i]).base, idxShiraishi);
  T('時給の人はこれまで通り時給×時間（1200*51.25=61500）', shiraishiBase === 61500, String(shiraishiBase));

  // 4) 田口和利も同様（addLineで新規追加した場合に月給が引き継がれるか）
  await page.selectOption('#addSel', { label: '田口和利' }).catch(() => {});
  const taguchiOption = await page.$eval('#addSel', el => [...el.options].some(o => o.textContent === '田口和利'));
  T('追加候補に田口和利がいる', taguchiOption, '');
  if (taguchiOption) {
    await page.selectOption('#addSel', { label: '田口和利' });
    await page.click('button:has-text("＋ 行を追加")');
    await page.waitForTimeout(100);
    const taguchiMonthly = await page.evaluate(() => {
      const i = lines.findIndex(l => l.staff_name === '田口和利');
      return lines[i] && lines[i].monthly_salary;
    });
    T('行を追加すると台帳の月給(225000)が引き継がれる', Number(taguchiMonthly) === 225000, String(taguchiMonthly));
  }

  T('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
