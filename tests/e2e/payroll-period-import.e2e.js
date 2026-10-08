// 給与明細: Excelから取り込んだ過去明細・賞与・期間まとめ出力
//
//   きっかけ（2026-10-08）
//     市役所から R7.10〜R8.9 の給与明細（全従業員分）の提出依頼。アプリの給与データは 2026-07 から。
//     それ以前は Excel にしか無かったので取り込んだ。Excel 側には アプリに無い項目
//     （単価17円の通勤費の金額・技術手当などの手当・介護保険・役員報酬・年末賞与）がある。
//
//   ここで測ること
//     1. 取り込んだ明細の差引支給額が元の Excel と一致する（渡邊 R7.10 → 15,741 / 沖 R7.10 → 77,857）
//     2. 明細書に 手当名・介護保険・役員報酬・転記の旨 が出る
//     3. 賞与は別の「賞与明細書」になり、差引が元と一致する（田口 R7年末 182,989）
//     4. 期間まとめ: 先頭に支給一覧、明細の無い月を赤字で出す。1人ずつ月順
//     5. どこかの月が読めなければ何も開かず、月を画面に出す（黙って抜かさない）
//     6. 取込行を画面から保存しても、取込の欄（通勤費の金額・手当）を送る＝消さない
//     7. 一覧表の合計行の列数が見出しとそろう（介護保険の列を足したため）
//     8. 本人ページ（payslip.html）も同じ金額になる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const IMP = '（9期）.xls から取込（10/8）';
const WATANABE = { id: 'L1', month: '2025-10', staff_id: 's3', staff_name: '渡邊恵', hourly_wage: 1225, work_hours: 8.5,
  commute_fixed: 1428, allowances: [{ label: '技術手当', amount: 3900 }], other_allowance_memo: 'アワコネ往復 42km×2回（往復キロ17円）', source: IMP };
const OKI = { id: 'L2', month: '2025-10', staff_id: 's1', staff_name: '沖浩志', monthly_salary: 100000, base_label: '役員報酬',
  health_insurance: 5576, care_insurance: 1600, pension: 8967, employment_insurance: 300, income_tax: 3600, resident_tax: 2100, source: IMP };
const TAGUCHI_BONUS = { id: 'B1', month: '2025-12', title: '年末賞与', staff_name: '田口和利', amount: 225000,
  health_insurance: 11227, care_insurance: 1056, pension: 20587, employment_insurance: 1350, income_tax: 7791, source: IMP };
const TAGUCHI_DEC = { id: 'L3', month: '2025-12', staff_id: 's2', staff_name: '田口和利', monthly_salary: 225000,
  health_insurance: 12518, care_insurance: 3600, pension: 20130, employment_insurance: 675, income_tax: 5680, resident_tax: 6500, source: IMP };
const DATA = {
  '2025-10': { lines: [OKI, WATANABE], bonuses: [] },
  '2025-11': { lines: [], bonuses: [] },
  '2025-12': { lines: [TAGUCHI_DEC], bonuses: [TAGUCHI_BONUS] },
};

async function open(browser, opts) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    try { localStorage.setItem('tg_staff_key', 'testkey'); } catch (e) {}
    window.__opened = [];
    window.open = () => { const w = { document: { write: h => w.html = (w.html || '') + h, close() {} } }; window.__opened.push(w); return w; };
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.dismiss());
  const saved = [];
  await page.route('**/rest/v1/rpc/admin_payroll_list', rt => {
    const m = JSON.parse(rt.request().postData()).p_month;
    if (opts && opts.failMonth === m) return rt.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'boom' }) });
    const d = DATA[m] || { lines: [], bonuses: [] };
    rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...d, staff: [], attendance: [], trips: [], trip_rates: [] }) });
  });
  await page.route('**/rest/v1/rpc/admin_payroll_upsert', rt => { saved.push(JSON.parse(rt.request().postData()).p); rt.fulfill({ status: 200, contentType: 'application/json', body: '"L1"' }); });
  await page.route('**/rest/v1/rpc/staff_key_ok', rt => rt.fulfill({ status: 200, contentType: 'application/json', body: 'true' }));
  await page.route('**/rest/v1/attendance**', rt => rt.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.goto('file://' + path.resolve(__dirname, '../../payroll.html'));
  await page.waitForTimeout(400);
  return { page, ctx, errors, saved };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  const { page, ctx, errors, saved } = await open(browser);
  await page.fill('#month', '2025-10');
  await page.evaluate(() => load());
  await page.waitForTimeout(300);

  const nets = await page.evaluate(() => Object.fromEntries(lines.map(l => [l.staff_name, calc(l).net])));
  T('渡邊 R7.10 差引 15,741（元 15,740.5）', nets['渡邊恵'] === 15741, JSON.stringify(nets));
  T('沖 R7.10 差引 77,857（元と一致）', nets['沖浩志'] === 77857, JSON.stringify(nets));

  const cols = await page.evaluate(() => {
    const h = document.querySelectorAll('.card table thead th').length;
    const f = [...document.querySelectorAll('#foot tr td')].reduce((a, td) => a + (+td.getAttribute('colspan') || 1), 0);
    return { h, f };
  });
  T('合計行の列数が見出しとそろう', cols.h === cols.f, JSON.stringify(cols));
  T('介護保険の列がある', await page.$('th:has-text("介護保険")') !== null, '');

  // 取込行を保存しても取込の欄を送る
  await page.evaluate(() => { const i = lines.findIndex(l => l.staff_name === '渡邊恵'); lines[i]._dirty = true; return saveLine(i); });
  const p = saved[0] || {};
  T('保存時に通勤費の金額・手当・介護保険を送る（消さない）', p.commute_fixed === 1428 && Array.isArray(p.allowances) && p.allowances[0].label === '技術手当' && 'care_insurance' in p, JSON.stringify(p));

  // 単月の明細
  await page.evaluate(() => payslipOpen(lines.findIndex(l => l.staff_name === '沖浩志')));
  await page.waitForTimeout(200);
  const okiHtml = await page.evaluate(() => (window.__opened.pop() || {}).html || '');
  T('沖の明細: 役員報酬・介護・転記の旨', /役員報酬/.test(okiHtml) && /介護 ¥1,600/.test(okiHtml) && /¥77,857/.test(okiHtml) && /Excel）の内容をアプリに転記/.test(okiHtml), okiHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300));
  await page.evaluate(() => payslipOpen(lines.findIndex(l => l.staff_name === '渡邊恵')));
  await page.waitForTimeout(200);
  const wHtml = await page.evaluate(() => (window.__opened.pop() || {}).html || '');
  T('渡邊の明細: 技術手当・通勤費の内訳（17円）・打刻なしの理由', /技術手当/.test(wHtml) && /往復キロ17円/.test(wHtml) && /当時の給与明細から転記/.test(wHtml) && /¥15,741/.test(wHtml), wHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300));

  // 期間まとめ
  await page.fill('#pFrom', '2025-10'); await page.fill('#pTo', '2025-12');
  await page.evaluate(() => payslipPeriodPrint());
  await page.waitForTimeout(400);
  const all = await page.evaluate(() => (window.__opened.pop() || {}).html || '');
  const text = all.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  T('先頭に支給一覧', /給与支給一覧 2025年10月〜2025年12月/.test(text), text.slice(0, 200));
  T('明細の無い月（2025-11）を赤字で出す', /明細の無い月: 2025-11/.test(text), '');
  T('賞与明細書（田口 差引 182,989）', /賞与明細書/.test(text) && /¥182,989/.test(text), '');
  const want = await page.evaluate(() => ['沖浩志', '渡邊恵', '田口和利'].sort((a, b) => a.localeCompare(b, 'ja')));
  const order = want.map(n => text.indexOf('氏名: ' + n));
  const tg = [...text.matchAll(/氏名: 田口和利/g)].map(m => m.index);
  T('1人ずつまとまって並ぶ（氏名順・同じ人の明細は続けて）', order.every(i => i > 0) && order[0] < order[1] && order[1] < order[2]
    && tg.length === 2 && !want.filter(n => n !== '田口和利').some(n => { const i = text.indexOf('氏名: ' + n); return i > tg[0] && i < tg[1]; }), JSON.stringify({ want, order, tg }));
  const slips = (all.match(/<section class="slip/g) || []).length;
  T('一覧1＋明細4枚（沖・渡邊・田口12月・田口賞与）', slips === 5, String(slips));
  const pm = await page.$eval('#pMsg', e => e.textContent);
  T('画面にも明細の無い月を出す', /3名分を開きました/.test(pm) && /2025-11/.test(pm), pm);
  T('pageerrorなし', errors.length === 0, errors.join(' / '));
  await ctx.close();

  // 読めない月があれば何も開かない
  {
    const o = await open(browser, { failMonth: '2025-12' });
    await o.page.fill('#pFrom', '2025-10'); await o.page.fill('#pTo', '2025-12');
    await o.page.evaluate(() => payslipPeriodPrint());
    await o.page.waitForTimeout(300);
    const n = await o.page.evaluate(() => window.__opened.length);
    const m = await o.page.$eval('#pMsg', e => e.textContent);
    T('読めない月があれば開かず、月とエラーを出す', n === 0 && /2025-12 の読み込みに失敗/.test(m), m);
    await o.ctx.close();
  }

  // 本人ページ
  {
    const c2 = await browser.newContext();
    const pg = await c2.newPage();
    const errs = []; pg.on('pageerror', e => errs.push(e.message));
    await pg.route('**/rest/v1/rpc/staff_payslip_view', rt => rt.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, staff_name: '渡邊恵', months: ['2025-10'], month: '2025-10', line: WATANABE, trips: [], attendance: [] }) }));
    await pg.goto('file://' + path.resolve(__dirname, '../../payslip.html') + '#t=abc');
    await pg.waitForTimeout(500);
    const t = await pg.$eval('#slipArea', e => e.textContent.replace(/\s+/g, ' '));
    T('本人ページも同じ差引（¥15,741）・技術手当・転記の旨', /¥15,741/.test(t) && /技術手当/.test(t) && /当時の給与明細から転記/.test(t) && !/出勤日数0日/.test(t), t.slice(0, 300));
    T('本人ページ pageerrorなし', errs.length === 0, errs.join(' / '));
    await c2.close();
  }

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
