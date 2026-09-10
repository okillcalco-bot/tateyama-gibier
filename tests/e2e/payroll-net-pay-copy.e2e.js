// 給与計算（payroll.html）: 差引支給額をLINEに貼り付けられるテキストでコピー
//
//   きっかけ（2026-09-10）
//     「給与、差引支給額はLINEに下記みたいにコピペできるようにして。
//     これ見ながら振り込むから」という要望（例:
//     「8月振込額」に続けて「氏名 金額」を1行ずつ）。
//
//   ここで測ること
//     1. 先頭行が「{対象月}月振込額」になる
//     2. 各行が「氏名 差引支給額（カンマ区切り）」になる（画面の差引支給額と一致）
//     3. クリップボードへ実際に書き込まれる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    try { localStorage.setItem('tg_staff_key', 'testkey'); } catch (e) {}
    window.__clipboard = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__clipboard.push(t); } } });
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { await d.dismiss(); });

  const STAFF = [
    { id: 's1', name: '白石秀一', hourly_wage: 1200, commute_round_km: 29, commute_yen_per_km: 20, is_active: true, deleted: false },
    { id: 's2', name: '沖浩志', hourly_wage: 1200, commute_round_km: null, commute_yen_per_km: 20, is_active: true, deleted: false },
  ];
  const LINES = [
    // 白石: 基本給 51.25h*1200=61500, 通勤 29*20*16=9280 => 支給70780, 控除ゼロ => 差引70780
    { id: 'L1', month: '2026-08', staff_id: 's1', staff_name: '白石秀一', hourly_wage: 1200, work_days: 16, work_hours: 51.25, commute_count: 16, commute_round_km: 29, commute_yen_per_km: 20 },
    // 沖: 248h*1200=297600, 通勤なし => 支給297600, 控除ゼロ => 差引297600
    { id: 'L2', month: '2026-08', staff_id: 's2', staff_name: '沖浩志', hourly_wage: 1200, work_days: 31, work_hours: 248, commute_count: 0, commute_round_km: null, commute_yen_per_km: 20 },
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

  await page.click('button:has-text("差引支給額をLINE用にコピー")');
  await page.waitForTimeout(200);

  const clip = await page.evaluate(() => window.__clipboard[0]);
  T('クリップボードへ書き込まれる', typeof clip === 'string' && clip.length > 0, String(clip));
  const lines = (clip || '').split('\n');
  T('先頭行が「8月振込額」になる', lines[0] === '8月振込額', JSON.stringify(lines));
  T('白石秀一の行が「白石秀一 70,780」になる', lines.includes('白石秀一 70,780'), JSON.stringify(lines));
  T('沖浩志の行が「沖浩志 297,600」になる', lines.includes('沖浩志 297,600'), JSON.stringify(lines));

  const msg = await page.$eval('#msg', el => el.textContent);
  T('コピー完了のメッセージが出る', /コピーしました/.test(msg), msg);

  T('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
