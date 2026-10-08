// 労働条件通知書（labor-notice.html）
//
//   きっかけ（2026-10-08）
//     市役所から「労働条件通知書（全従業員分）」の提出依頼。Wordで7名分しか無く、賃金も2024年当時のまま。
//
//   ここで測ること
//     1. 状態: Word原本しか無く賃金が今と違う人は「要更新」、何も無い人は「未作成」
//     2. 下書きはスタッフ台帳から: 時給・通勤のkm単価・止めさし手当・社会保険／雇用保険
//     3. 発行は admin_labor_notice_issue に送り、通知書が開く（氏名・和暦の交付日・○印の項目）
//     4. 発行に失敗したら画面に出し、通知書は開かない（記録されていないのに印刷させない）
//     5. 全員分印刷: 発行済みの最新だけを並べ、未発行の人を名前で出す
//     6. 契約期間ありで日付が無い・賃金0円 は発行しない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const STAFF = [
  { id: 's1', name: '白石秀一', employment_type: '時給', hourly_wage: 1400, commute_yen_per_km: 20, stopkill_eligible: true, social_insurance: null, employment_insurance: null, role: '精肉' },
  { id: 's2', name: '今泉貴雄', employment_type: '時給', hourly_wage: 1200, commute_yen_per_km: 20, stopkill_eligible: true, social_insurance: '加入', employment_insurance: '加入', role: '止め刺し・解体' },
  { id: 's3', name: '田口和利', employment_type: '月給', monthly_salary: 225000, commute_yen_per_km: 20, social_insurance: '加入', employment_insurance: '加入' },
];
const NOTICES = [
  { id: 'w1', staff_name: '白石秀一', issued_on: '2024-10-02', conditions: { wage_type: '時給', wage: 1125, commute_rate: 17 }, source: '202410労働条件通知書（白石）.docx', source_url: 'https://drive.google.com/file/d/x/view' },
  { id: 'a1', staff_name: '田口和利', issued_on: '2026-10-01', conditions: { wage_type: '月給', wage: 225000, allowances: [], employment_insurance: '有', overtime: '無', contract: 'なし' }, source: null },
];
const DEFAULTS = { employer_name: '合同会社アルコ', employer_addr: '千葉県館山市大戸３７', employer_rep: '代表社員 沖浩志', place: '館山市ジビエ加工処理施設', duties: 'ジビエ加工処理', hours_text: '始業8:30 終業17:00', break_min: 60, overtime: '無', holidays: '土・日', leave_text: '6か月→5日', cutoff: '毎月末日', payday: '翌月10日', pay_method: '振込', retire_age: '無', rehire: '無', resign_notice: '30日前', contact_dept: '代表', contact_name: '沖', contact_tel: '000' };

async function open(browser, opts) {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Tokyo' });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('tg_staff_key', 'testkey'); } catch (e) {}
    window.__opened = [];
    window.open = () => { const w = { document: { write: h => w.html = (w.html || '') + h, close() {} } }; window.__opened.push(w); return w; };
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const issued = [];
  await page.route('**/rest/v1/rpc/admin_labor_notice_list', rt => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ staff: STAFF, notices: NOTICES, defaults: DEFAULTS }) }));
  await page.route('**/rest/v1/rpc/admin_labor_notice_issue', rt => {
    issued.push(JSON.parse(rt.request().postData()).p);
    if (opts && opts.fail) return rt.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'boom' }) });
    rt.fulfill({ status: 200, contentType: 'application/json', body: '"new1"' });
  });
  await page.goto('file://' + path.resolve(__dirname, '../../labor-notice.html'));
  await page.waitForTimeout(500);
  return { page, ctx, errors, issued };
}
const rowText = (page, name) => page.$$eval('#rows tr', (trs, n) => (trs.find(t => t.textContent.includes(n)) || {}).textContent.replace(/\s+/g, ' '), name);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  const { page, ctx, errors, issued } = await open(browser);
  T('白石: Word原本の時給1,125円 → 現在1,400円で「要更新」', /要更新（通知書 時給1,125円 → 現在 時給1,400円）/.test(await rowText(page, '白石秀一')), await rowText(page, '白石秀一'));
  T('今泉: 通知書なしで「未作成」', /未作成/.test(await rowText(page, '今泉貴雄')), await rowText(page, '今泉貴雄'));
  T('田口: アプリ発行済みで賃金一致なら「最新」', /最新/.test(await rowText(page, '田口和利')), await rowText(page, '田口和利'));
  T('Word原本へのリンク', await page.$('a[href="https://drive.google.com/file/d/x/view"]') !== null, '');

  // 下書き（今泉）
  await page.evaluate(() => editOpen(staff.findIndex(s => s.name === '今泉貴雄')));
  const draft = await page.evaluate(() => ({ wage: ef_wage.value, type: ef_wage_type.value, allow: ef_allowances_text.value, si: ef_social_insurance.value, ei: ef_employment_insurance.value }));
  T('下書き: 時給1,200・通勤20円/km・止めさし手当・社保/雇保あり', draft.wage === '1200' && draft.type === '時給' && /通勤手当｜20円/.test(draft.allow) && /止めさし・搬入手当｜3,000円/.test(draft.allow) && draft.si === '厚生年金・健康保険' && draft.ei === '有', JSON.stringify(draft));

  // 足りない入力は発行しない
  await page.selectOption('#ef_contract', 'あり');
  await page.evaluate(() => editIssue());
  await page.waitForTimeout(200);
  const em = await page.$eval('#emMsg', e => e.textContent);
  T('契約期間ありで日付が無ければ発行しない', issued.length === 0 && /契約期間の開始・終了/.test(em), em);
  await page.selectOption('#ef_contract', 'なし');

  await page.fill('#ef_issued_on', '2026-10-08');
  await page.evaluate(() => editIssue());
  await page.waitForTimeout(300);
  const p = issued[0] || {};
  T('発行: 氏名・交付日・条件を送る', p.staff_name === '今泉貴雄' && p.issued_on === '2026-10-08' && p.conditions && p.conditions.wage === 1200 && p.conditions.allowances.length === 2, JSON.stringify(p).slice(0, 300));
  const html = await page.evaluate(() => (window.__opened.pop() || {}).html || '');
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  T('通知書: 氏名・和暦の交付日・時間給1,200円', /今泉貴雄 殿/.test(text) && /令和8年10月8日/.test(text) && /ハ 時間給 （1,200円）/.test(text), text.slice(0, 400));
  T('通知書: ○印（期間の定めなし・雇用保険 有）', /<span class="maru">期間の定めなし<\/span>/.test(html) && /雇用保険の適用（<span class="maru">有<\/span>・無）/.test(html), '');
  // 実寸: A4（印刷幅186mm）で1枚に収まり、所在地が途中で折り返さない
  {
    const q = await ctx.newPage();
    await q.setViewportSize({ width: 703, height: 1000 });   // 186mm ≒ 703px
    await q.setContent(html); await q.emulateMedia({ media: 'print' });
    const m = await q.evaluate(() => { const s = document.querySelector('.notice'); const a = document.querySelector('.nw'); const r = a.getClientRects(); return { h: s.getBoundingClientRect().height, lines: r.length }; });
    T('A4縦1枚に収まる（高さ < 273mm≒1031px）・所在地は1行', m.h < 1031 && m.lines === 1, JSON.stringify(m));
    await q.close();
  }
  T('発行後は「最新」になる', /最新/.test(await rowText(page, '今泉貴雄')), await rowText(page, '今泉貴雄'));

  // 全員分印刷
  await page.evaluate(() => printLatestAll());
  await page.waitForTimeout(200);
  const all = await page.evaluate(() => (window.__opened.pop() || {}).html || '');
  const n = (all.match(/<section class="notice">/g) || []).length;
  T('全員分: 発行済みの最新2名（今泉・田口）を並べ、未発行（白石）を名前で出す', n === 2 && /未発行: 白石秀一/.test(all), String(n));
  T('pageerrorなし', errors.length === 0, errors.join(' / '));
  await ctx.close();

  {
    const o = await open(browser, { fail: true });
    await o.page.evaluate(() => editOpen(staff.findIndex(s => s.name === '今泉貴雄')));
    await o.page.evaluate(() => editIssue());
    await o.page.waitForTimeout(300);
    const m = await o.page.$eval('#emMsg', e => e.textContent);
    const opened = await o.page.evaluate(() => window.__opened.length);
    T('発行失敗は画面に出し、通知書は開かない', /発行できませんでした: boom/.test(m) && opened === 0, m);
    await o.ctx.close();
  }

  let pass = 0;
  for (const [nm, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + nm + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
