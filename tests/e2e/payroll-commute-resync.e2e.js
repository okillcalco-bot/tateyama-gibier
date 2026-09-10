// 給与計算（payroll.html）: 明細行を作った後にスタッフ台帳の往復kmを設定しても、
// 「取込」を押し直せば通勤費に反映されるか
//
//   きっかけ（2026-09-10）
//     「通勤費が往復キロ数入れたのに更新されてない」という指摘。
//     実測: 川島幸子・相川武士は、先に（勤怠から自動追加で）8月分の明細行が
//     作られ、その後でスタッフ管理から往復km(42km)を設定していた。
//     importAtt()は勤怠の日数・時間・通勤回数しか同期しておらず、
//     往復kmはスタッフ台帳を更新しても既存の明細行には反映されなかった
//     （明細行作成時の一度きりのコピーのままだった）。
//     取込のたびにスタッフ台帳の往復km・単価も同期し直すようにした。
//
//   ここで測ること
//     1. 台帳が未設定のまま作られた明細行（往復km空欄）がある
//     2. その後スタッフ台帳側に往復kmが設定される
//     3. その行の📥（取込）を押すと、往復kmが台帳の値に更新される
//     4. 台帳が空欄のスタッフは、取込を押しても明細行の値を消さない
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
    // スタッフ台帳側で後から往復kmが設定された人（明細行はまだ空欄のまま）
    { id: 's1', name: '川島幸子', hourly_wage: 1200, commute_round_km: 42, commute_yen_per_km: 20, is_active: true, deleted: false },
    // 台帳側が未設定の人（取込しても明細行の既存値を消してはいけない）
    { id: 's2', name: '白石秀一', hourly_wage: 1200, commute_round_km: null, commute_yen_per_km: 20, is_active: true, deleted: false },
  ];
  const LINES = [
    { id: 'L1', month: '2026-08', staff_id: 's1', staff_name: '川島幸子', hourly_wage: 1200, work_days: 7, work_hours: 40, commute_round_km: null, commute_count: 7, commute_yen_per_km: 20 },
    { id: 'L2', month: '2026-08', staff_id: 's2', staff_name: '白石秀一', hourly_wage: 1200, work_days: 16, work_hours: 51.25, commute_round_km: 29, commute_count: 16, commute_yen_per_km: 20 },
  ];
  const ATTENDANCE = [
    { staff_name: '川島幸子', days: 7, hours: 40 },
    { staff_name: '白石秀一', days: 16, hours: 51.25 },
  ];

  await page.route('**/rest/v1/rpc/admin_payroll_list', rt => rt.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ lines: LINES, staff: STAFF, attendance: ATTENDANCE, trips: [], trip_rates: [] }),
  }));
  await page.route('**/rest/v1/rpc/staff_key_ok', rt => rt.fulfill({ status: 200, contentType: 'application/json', body: 'true' }));
  await page.route('**/rest/v1/attendance**', rt => rt.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

  await page.goto('file://' + path.resolve(__dirname, '../../payroll.html'));
  await page.waitForTimeout(600);

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  const kmInputByName = async (name) => page.evaluate((nm) => {
    const i = lines.findIndex(l => l.staff_name === nm);
    return i >= 0 ? lines[i].commute_round_km : undefined;
  }, name);

  T('川島さんの明細行は最初は往復km未設定', (await kmInputByName('川島幸子')) === null, String(await kmInputByName('川島幸子')));

  // 川島さんの行の📥（取込）を押す
  const idxKawashima = await page.evaluate(() => lines.findIndex(l => l.staff_name === '川島幸子'));
  await page.evaluate((i) => importAtt(i), idxKawashima);
  await page.waitForTimeout(100);
  T('取込後、台帳の往復km(42)が明細行に反映される', (await kmInputByName('川島幸子')) === 42, String(await kmInputByName('川島幸子')));

  // 白石さんの行の📥（取込）を押しても、台帳が未設定なら明細行の値(29)を消さない
  const idxShiraishi = await page.evaluate(() => lines.findIndex(l => l.staff_name === '白石秀一'));
  await page.evaluate((i) => importAtt(i), idxShiraishi);
  await page.waitForTimeout(100);
  T('台帳未設定のスタッフは取込で既存の往復kmを消さない', (await kmInputByName('白石秀一')) === 29, String(await kmInputByName('白石秀一')));

  T('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
