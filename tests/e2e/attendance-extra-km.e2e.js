// 勤怠の「追加距離（km）」→ 給与の通勤費に加算されるか
//
//   きっかけ（2026-09-16）
//     「吉田さんの今月の給料の交通費に添付の距離を加算して。通常の自宅とセンター往復以外のも
//      たまにありそうだから、勤怠管理に距離を足せるようにして」
//     それまで交通費は「自宅⇔センター往復km×出勤回数」と「行き先別（産廃・アワコネ）」だけで、
//     配達などの単発の移動は手書きメモで渡すしかなかった。
//     出退勤記録（管理者チェック）の行に km と内容を入れられるようにし、
//     給与計算（payroll.html）と本人ページ（payslip.html）が月合計を通勤費に足す。
//
//   ここで測ること
//     index.html（出退勤記録）
//       1. 行に追加距離kmと内容の入力欄がある
//       2. 既存の値がプリフィルされる
//       3. 保存で attendance に extra_km（小数1桁）・extra_km_note が送られる
//       4. 空欄なら null で送られる（0加算）
//     payroll.html（給与計算）
//       5. 勤怠集計の extra_km が通勤費に 円/km で加算される
//       6. 通勤費の内訳（commTitle）に「勤怠の追加距離」が出る
//       7. 明細（payslipSection）の内訳と日別行に追加距離と内容が出る
//       8. 追加距離が無い人の通勤費は変わらない（回帰）
//     payslip.html（本人ページ）
//       9. 月給・行き先別・追加距離を含めた通勤費が担当者画面（payroll.html）と同じ式になる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  /* ───────── index.html: 出退勤記録 ───────── */
  {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_role_v1', 'admin'); } catch (e) {} });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', async d => { await d.dismiss(); });

    const STAFF = [
      { id: 's1', name: '吉田友美', role: '解体', hourly_wage: 1200 },
      { id: 's2', name: '白石秀一', role: '解体', hourly_wage: 1200 },
    ];
    const ATT = [
      { id: 'a1', staff_id: 's1', staff_name: '吉田友美', work_date: '2026-09-02', clock_in: '08:00', clock_out: '16:00', break_minutes: 60, note: null, extra_km: 36.1, extra_km_note: '千倉へ配達' },
    ];
    const writes = [];
    await page.route('**/rest/v1/**', rt => {
      const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
      const J = x => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
      if (m === 'PATCH' && /\/attendance\b/.test(url)) { writes.push({ m, url, body: JSON.parse(req.postData() || '{}') }); return J([{ id: 'a1' }]); }
      if (m === 'POST' && /\/attendance\b/.test(url)) { writes.push({ m, url, body: JSON.parse(req.postData() || '{}') }); return J([{ id: 'a2' }]); }
      if (m !== 'GET') return J([]);
      if (/\/staff\b/.test(url)) return J(STAFF);
      if (/\/attendance\b/.test(url)) return J(ATT);
      return J([]);
    });
    await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));

    await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
    await page.waitForTimeout(600);
    await page.evaluate(() => { document.querySelector('[data-tab="staff"]').click(); });
    await page.waitForTimeout(300);
    await page.evaluate(async () => { document.getElementById('att-date').value = '2026-09-02'; await loadAttendance(); });
    await page.waitForTimeout(200);

    T('出退勤記録の見出しに「追加距離」がある', await page.$('#att-body') !== null && (await page.textContent('body')).includes('追加距離'), '');
    const rows = await page.$$('#att-body tr[data-staff]');
    T('スタッフ分の行が出る', rows.length === 2, String(rows.length));
    T('行に追加距離kmの入力欄がある', await page.$('#att-body tr[data-staff="s1"] .att-xkm') !== null, '');
    T('行に内容の入力欄がある', await page.$('#att-body tr[data-staff="s1"] .att-xnote') !== null, '');
    const pre = await page.$eval('#att-body tr[data-staff="s1"] .att-xkm', el => el.value);
    const preNote = await page.$eval('#att-body tr[data-staff="s1"] .att-xnote', el => el.value);
    T('既存の追加距離(36.1)がプリフィルされる', pre === '36.1', pre);
    T('既存の内容がプリフィルされる', preNote === '千倉へ配達', preNote);

    // 3) 値を変えて保存 → PATCH に extra_km / extra_km_note
    await page.fill('#att-body tr[data-staff="s1"] .att-xkm', '38.24');
    await page.fill('#att-body tr[data-staff="s1"] .att-xnote', ' 館山駅へ配達 ');
    await page.evaluate(() => attSave('s1', '吉田友美'));
    await page.waitForTimeout(300);
    const w1 = writes.find(w => w.m === 'PATCH');
    T('保存で attendance に PATCH される', !!w1, JSON.stringify(writes.map(w => w.m)));
    T('extra_km が小数1桁に丸めて送られる（38.24→38.2）', w1 && w1.body.extra_km === 38.2, w1 && JSON.stringify(w1.body.extra_km));
    T('extra_km_note が前後の空白を除いて送られる', w1 && w1.body.extra_km_note === '館山駅へ配達', w1 && JSON.stringify(w1.body.extra_km_note));
    T('打刻時刻はそのまま保たれる', w1 && w1.body.clock_in === '08:00' && w1.body.clock_out === '16:00', w1 && JSON.stringify([w1.body.clock_in, w1.body.clock_out]));

    // 4) 空欄で保存 → null（新規行は POST）
    await page.fill('#att-body tr[data-staff="s2"] .att-in', '09:00');
    await page.fill('#att-body tr[data-staff="s2"] .att-out', '15:00');
    await page.evaluate(() => attSave('s2', '白石秀一'));
    await page.waitForTimeout(300);
    const w2 = writes.find(w => w.m === 'POST' && /\/attendance\b/.test(w.url) && w.body.staff_id === 's2');
    T('追加距離が空欄なら extra_km は null', w2 && w2.body.extra_km === null, w2 && JSON.stringify(w2.body.extra_km));
    T('内容が空欄なら extra_km_note は null', w2 && w2.body.extra_km_note === null, w2 && JSON.stringify(w2.body.extra_km_note));

    T('index.html ページエラーなし', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  /* ───────── payroll.html: 給与計算 ───────── */
  {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => { try { localStorage.setItem('tg_staff_key', 'testkey'); } catch (e) {} });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', async d => { await d.dismiss(); });

    const STAFF = [
      { id: 's1', name: '吉田友美', hourly_wage: 1200, monthly_salary: null, employment_type: '時給', commute_round_km: 20, commute_yen_per_km: 20, is_active: true, deleted: false },
      { id: 's2', name: '白石秀一', hourly_wage: 1200, monthly_salary: null, employment_type: '時給', commute_round_km: 30, commute_yen_per_km: 20, is_active: true, deleted: false },
    ];
    const LINES = [
      { id: 'L1', month: '2026-09', staff_id: 's1', staff_name: '吉田友美', hourly_wage: 1200, work_days: 12, work_hours: 80, commute_round_km: 20, commute_yen_per_km: 20, commute_count: 12 },
      { id: 'L2', month: '2026-09', staff_id: 's2', staff_name: '白石秀一', hourly_wage: 1200, work_days: 10, work_hours: 60, commute_round_km: 30, commute_yen_per_km: 20, commute_count: 10 },
    ];
    // 9/2 36.1, 9/3 34, 9/4 34, 9/7 36.1, 9/9 38.2, 9/11 38.2 → 216.6km（手書きメモそのもの）
    const ATT_AGG = [
      { staff_name: '吉田友美', days: 12, hours: 80, extra_km: 216.6, extra_km_days: 6 },
      { staff_name: '白石秀一', days: 10, hours: 60, extra_km: 0, extra_km_days: 0 },
    ];
    const ATT_ROWS = [
      { work_date: '2026-09-02', clock_in: '08:00', clock_out: '16:00', break_minutes: 60, note: null, extra_km: 36.1, extra_km_note: '千倉へ配達' },
      { work_date: '2026-09-03', clock_in: '08:00', clock_out: '16:00', break_minutes: 60, note: null, extra_km: 34, extra_km_note: null },
      { work_date: '2026-09-05', clock_in: '08:00', clock_out: '16:00', break_minutes: 60, note: null, extra_km: null, extra_km_note: null },
    ];

    await page.route('**/rest/v1/rpc/admin_payroll_list', rt => rt.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ lines: LINES, staff: STAFF, attendance: ATT_AGG, trips: [], trip_rates: [] }),
    }));
    await page.route('**/rest/v1/rpc/staff_key_ok', rt => rt.fulfill({ status: 200, contentType: 'application/json', body: 'true' }));
    await page.route('**/rest/v1/attendance**', rt => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ATT_ROWS) }));

    await page.goto('file://' + path.resolve(__dirname, '../../payroll.html'));
    await page.fill('#month', '2026-09');
    await page.waitForTimeout(600);

    const centerYen = 20 * 20 * 12;             // 4800
    const extraYen = Math.round(216.6 * 20);    // 4332
    const c1 = await page.evaluate(() => calc(lines.find(l => l.staff_name === '吉田友美')));
    T('通勤費＝センター往復(4800)＋勤怠の追加距離(216.6km×20円=4332)', c1.comm === centerYen + extraYen, String(c1.comm));
    T('支給額にも加算されている（基本給96000+通勤費9132）', c1.pay === 96000 + centerYen + extraYen, String(c1.pay));
    const c2 = await page.evaluate(() => calc(lines.find(l => l.staff_name === '白石秀一')));
    T('追加距離の無い人の通勤費は従来通り（30×20×10=6000）', c2.comm === 6000, String(c2.comm));

    const title = await page.evaluate(() => commTitle(lines.find(l => l.staff_name === '吉田友美')));
    T('通勤費の内訳に「勤怠の追加距離 216.6km×20円」が出る', title.includes('勤怠の追加距離 216.6km×20円'), title);
    const title2 = await page.evaluate(() => commTitle(lines.find(l => l.staff_name === '白石秀一')));
    T('追加距離の無い人の内訳には出ない', !title2.includes('追加距離'), title2);

    const attCell = await page.evaluate(() => document.querySelector('#body tr td .att') && document.querySelector('#body tr td .att').textContent);
    T('一覧の勤怠欄に「追加距離 216.6km（6日）」が出る', !!attCell && attCell.includes('追加距離') && attCell.includes('216.6km') && attCell.includes('6日'), attCell);

    const slip = await page.evaluate(() => payslipSection(lines.find(l => l.staff_name === '吉田友美'), '2026-09', [
      { work_date: '2026-09-02', clock_in: '08:00', clock_out: '16:00', break_minutes: 60, extra_km: 36.1, extra_km_note: '千倉へ配達' },
      { work_date: '2026-09-03', clock_in: '08:00', clock_out: '16:00', break_minutes: 60, extra_km: 34, extra_km_note: null },
      { work_date: '2026-09-05', clock_in: '08:00', clock_out: '16:00', break_minutes: 60, extra_km: null, extra_km_note: null },
    ]));
    T('明細の通勤費に合計(¥9,132)が出る', slip.includes('¥9,132'), '');
    T('明細の通勤費内訳に「勤怠の追加距離 216.6km×20円」が出る', slip.includes('勤怠の追加距離 216.6km×20円'), '');
    T('明細の日別行に追加距離と内容が出る', slip.includes('追加距離 36.1km（千倉へ配達）') && slip.includes('追加距離 34km'), '');
    T('追加距離の無い日には出ない', (slip.match(/追加距離 /g) || []).length === 3, String((slip.match(/追加距離 /g) || []).length));

    // 勤怠集計（attMap）が無い月でも、日別行から合計を足し上げて内訳に出す
    const slipNoAgg = await page.evaluate(() => {
      const saved = attMap['吉田友美']; delete attMap['吉田友美'];
      const html = payslipSection(lines.find(l => l.staff_name === '吉田友美'), '2026-09', [
        { work_date: '2026-09-02', clock_in: '08:00', clock_out: '16:00', break_minutes: 60, extra_km: 36.1 },
        { work_date: '2026-09-03', clock_in: '08:00', clock_out: '16:00', break_minutes: 60, extra_km: 34 },
      ]);
      attMap['吉田友美'] = saved; return html;
    });
    T('勤怠集計が無くても日別行から合計(70.1km)を内訳に出す', slipNoAgg.includes('勤怠の追加距離 70.1km×20円'), '');

    T('payroll.html ページエラーなし', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  /* ───────── payslip.html: 本人ページ ───────── */
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));

    const VIEW = {
      ok: true, staff_name: '吉田友美', months: ['2026-09'], month: '2026-09',
      line: { month: '2026-09', staff_name: '吉田友美', hourly_wage: 1200, monthly_salary: null, work_days: 12, work_hours: 80,
              commute_round_km: 20, commute_yen_per_km: 20, commute_count: 12, stopkill_count: 0 },
      trips: [{ destination: '産廃処理', round_km: 10, trip_count: 2, yen_per_km: 20 }],
      attendance: [
        { work_date: '2026-09-02', clock_in: '08:00', clock_out: '16:00', break_minutes: 60, extra_km: 36.1, extra_km_note: '千倉へ配達' },
        { work_date: '2026-09-03', clock_in: '08:00', clock_out: '16:00', break_minutes: 60, extra_km: 34, extra_km_note: null },
        { work_date: '2026-09-05', clock_in: '08:00', clock_out: '16:00', break_minutes: 60, extra_km: null, extra_km_note: null },
      ],
    };
    await page.route('**/rest/v1/rpc/staff_payslip_view', rt => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(VIEW) }));
    await page.goto('file://' + path.resolve(__dirname, '../../payslip.html') + '#t=testtoken');
    await page.waitForTimeout(600);

    const shown = await page.$eval('#content', el => !el.classList.contains('hidden')).catch(() => false);
    T('本人ページが表示される', shown, '');
    const body = await page.textContent('#slipArea');
    // 4800（センター）＋400（産廃10km×20×2）＋1402（70.1km×20）＝6602
    T('通勤費＝センター4800＋行き先別400＋追加距離1402＝¥6,602', body.includes('¥6,602'), body.replace(/\s+/g, ' ').slice(0, 300));
    T('内訳に「勤怠の追加距離 70.1km×20円」が出る', body.includes('勤怠の追加距離 70.1km×20円'), '');
    T('内訳に行き先別（産廃処理）も出る', body.includes('産廃処理 10km×20円×2回'), '');
    T('日別行に追加距離と内容が出る', body.includes('追加距離 36.1km（千倉へ配達）'), '');
    T('支給額（96000+6602=¥102,602）', body.includes('¥102,602'), '');

    // 月給者は月給が基本給になる（担当者画面と同じ式）
    const monthly = await page.evaluate(() => calc({ monthly_salary: 100000, hourly_wage: null, work_hours: 0, commute_round_km: 0, commute_count: 0 }, [], []));
    T('月給者の基本給は月給そのまま（100,000）', monthly.base === 100000, String(monthly.base));

    T('payslip.html ページエラーなし', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
