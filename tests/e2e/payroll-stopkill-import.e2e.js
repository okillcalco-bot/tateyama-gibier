// 給与計算（payroll.html）: 「勤怠から取込」で止めさし回数も入る（2026-11-09）
//
//   きっかけ
//     「10月の今泉さんの給与、止めさし行ったと思うんだけど記録なかった？」
//     実測: 勤怠には10月の止めさしが8回（7日分）記録されていたが、取込は日数・時間・通勤回数だけを入れ、
//     止めさし回数は入れていなかった。明細の止めさし欄は空のまま（手で入れないと払われない）。
//
//   ここで測ること（スタッフ・回数は架空）
//     1. 勤怠の止めさし回数（月合計）が明細に入る
//     2. 勤怠に止めさしが無い人は、手で入れた回数を消さない
//     3. 取込の結果に止めさしの回数を出す
//     4. 勤怠の止めさしを読めなかったときは黙らない（結果に出す・手入力の値は残す）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

async function run(browser, failStop) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { localStorage.setItem('tg_staff_key', 'testkey'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { await d.dismiss(); });
  const STAFF = [
    { id: 's1', name: '架空一郎', hourly_wage: 1250, commute_round_km: 10, commute_yen_per_km: 20, stopkill_eligible: true, is_active: true, deleted: false },
    { id: 's2', name: '架空二郎', hourly_wage: 1200, commute_round_km: 8, commute_yen_per_km: 20, stopkill_eligible: true, is_active: true, deleted: false },
  ];
  const LINES = [
    { id: 'L1', month: '2026-10', staff_id: 's1', staff_name: '架空一郎', hourly_wage: 1250, stopkill_count: null, stopkill_unit: 3000 },
    { id: 'L2', month: '2026-10', staff_id: 's2', staff_name: '架空二郎', hourly_wage: 1200, stopkill_count: 2, stopkill_unit: 3000 },   // 手入力の2回
  ];
  const ATT = [{ staff_name: '架空一郎', days: 22, hours: 144.75 }, { staff_name: '架空二郎', days: 10, hours: 60 }];
  const STOP_ROWS = [{ staff_name: '架空一郎', stopkill_count: 1 }, { staff_name: '架空一郎', stopkill_count: 2 }, { staff_name: '架空一郎', stopkill_count: 1 }];
  await page.route('**/rest/v1/rpc/admin_payroll_list', rt => rt.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ lines: LINES, staff: STAFF, attendance: ATT, trips: [], trip_rates: [] }) }));
  await page.route('**/rest/v1/rpc/staff_key_ok', rt => rt.fulfill({ status: 200, contentType: 'application/json', body: 'true' }));
  await page.route('**/rest/v1/attendance**', rt => {
    const u = decodeURIComponent(rt.request().url());
    if (/stopkill_count=gt\.0/.test(u)) {
      if (failStop) return rt.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"boom"}' });
      return rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(STOP_ROWS) });
    }
    return rt.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.goto('file://' + path.resolve(__dirname, '../../payroll.html'));
  await page.waitForTimeout(600);
  await page.click('button:has-text("勤怠から日数・時間を取込")');
  await page.waitForTimeout(200);
  const got = await page.evaluate(() => ({
    stop: Object.fromEntries(lines.map(l => [l.staff_name, l.stopkill_count])),
    msg: document.getElementById('msg').textContent,
    inputs: [...document.querySelectorAll('#body input')].filter(x => /'stopkill_count'/.test(x.getAttribute('oninput') || '')).map(x => x.value),
  }));
  await ctx.close();
  return { got, errors };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

  const a = await run(browser, false);
  T('1. 勤怠の止めさし（1+2+1＝4回）が明細に入る', Number(a.got.stop['架空一郎']) === 4, JSON.stringify(a.got.stop));
  T('1. 画面の止めさし欄にも出る', a.got.inputs.includes('4'), JSON.stringify(a.got.inputs));
  T('2. 勤怠に止めさしが無い人は手入力の2回を残す', Number(a.got.stop['架空二郎']) === 2, JSON.stringify(a.got.stop));
  T('3. 取込の結果に止めさしの回数を出す', /止めさし: 架空一郎 4回/.test(a.got.msg), a.got.msg);
  T('ページエラーなし', a.errors.length === 0, a.errors.join(' / '));

  const b = await run(browser, true);
  T('4. 読めなかったときは結果に出す（黙らない）', /止めさし回数を勤怠から読めませんでした/.test(b.got.msg), b.got.msg);
  T('4. 読めなかったときも手入力の値は残す', Number(b.got.stop['架空二郎']) === 2 && (b.got.stop['架空一郎'] == null || b.got.stop['架空一郎'] === ''), JSON.stringify(b.got.stop));
  T('ページエラーなし（失敗時）', b.errors.length === 0, b.errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
