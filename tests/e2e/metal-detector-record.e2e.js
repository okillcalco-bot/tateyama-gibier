// 金属検出機 点検記録表（2026-10-08 保健所から求められた）
//
//   退勤時の施設チェック（punch.html「カット室・金属検出機：正しく作動するか」）が facility_check_logs に
//   毎日残っている。それを書類・帳票（HACCP・衛生管理）で月ごとの点検記録表として出す。
//
//   ここで測ること
//     1. HACCP・衛生管理に「金属検出機 点検記録表」があり、facility_check_logs を item=金属検出機・対象月で問い合わせる
//     2. 1日1行（日付(曜)・カット室・作動確認・結果・確認者）。異常日は件数を注記し、セルが赤くなる
//     3. 提出セットの対応表（別表17 三）に載り、印刷一式に入る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Tokyo' });
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const reqs = [];
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    const qs = decodeURIComponent(u.split('?')[1] || '');
    if (/\/rest\/v1\/facility_check_logs/.test(u)) { reqs.push(qs); return J([
      { check_date: '2026-09-01', result: '可', value: null, note: null, staff_name: '吉田友美' },
      { check_date: '2026-09-02', result: '否', value: null, note: '反応せず→電源入れ直しで復旧', staff_name: '川島幸子' },
      { check_date: '2026-09-03', result: '可', value: null, note: null, staff_name: '今泉貴雄' },
    ]); }
    if (/\/rest\/v1\/report_docs/.test(u)) return J(r.request().method() === 'POST' ? [{ id: 'rd1', status: '作成済み', output_count: 0 }] : []);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(700);
  const results = []; const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  const def = await page.evaluate(() => { const d = DOC_DEFS.find(x => x.key === 'metal_detector'); return d && { cat: d.cat, title: d.title }; });
  T('HACCP・衛生管理に「金属検出機 点検記録表」', def && def.cat === 'HACCP・衛生管理' && def.title === '金属検出機 点検記録表', JSON.stringify(def));
  const d = await page.evaluate(async () => DOC_DEFS.find(x => x.key === 'metal_detector').gen('2026-09'));
  const q = reqs[0] || '';
  T('問い合わせは item=金属検出機・9/1〜9/30', /item=eq\.金属検出機/.test(q) && /check_date=gte\.2026-09-01/.test(q) && /check_date=lte\.2026-09-30/.test(q), q);
  T('1日1行: 9/1(火)・カット室・作動確認・可・吉田友美', JSON.stringify(d.rows[0]) === JSON.stringify(['9/1(火)', 'カット室', '正しく作動するか（作動確認）', '可', '吉田友美', '']), JSON.stringify(d.rows[0]));
  T('異常日の対応が備考に出る', d.rows[1][3] === '否' && /電源入れ直し/.test(d.rows[1][5]), JSON.stringify(d.rows[1]));
  T('注記: 点検3日・異常1日', /点検 3日・異常 1日/.test(d.note), d.note);

  await page.evaluate(() => { document.getElementById('doc-month').value = '2026-09'; window.__h = ''; window.open = () => ({ document: { write: s => { window.__h += s; }, open() {}, close() {} }, print() {} }); });
  await page.evaluate(() => docOutput('metal_detector', 'print'));
  await page.waitForTimeout(400);
  const html = await page.evaluate(() => window.__h);
  T('印刷: 見出しと「否」のセルが赤', /金属検出機 点検記録表/.test(html) && /color:#c00;font-weight:600;">否</.test(html), '');
  const map = await page.evaluate(() => HACCP_MAP.find(r => r.docs.includes('metal_detector')));
  T('提出セットの対応表（別表17 三）に載る', map && /別表17 三/.test(map.law), JSON.stringify(map && map.law));
  await page.evaluate(() => { window.__pack = ''; window.open = () => ({ document: { write: s => { window.__pack += s; }, open() {}, close() {} }, print() {} }); });
  await page.evaluate(() => haccpPackPrint());
  await page.waitForTimeout(1500);
  T('提出セットの印刷一式に入る', /金属検出機 点検記録表/.test(await page.evaluate(() => window.__pack)), '');

  T('pageerrorなし', errors.length === 0, errors.join(' / '));
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
