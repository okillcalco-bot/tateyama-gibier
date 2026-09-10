// スタッフ管理: 通勤距離（自宅⇔センター往復km）をスタッフ台帳から設定できるか
//
//   きっかけ（2026-09-10）
//     「交通費って反映できてるんだっけ？どこで自宅を設定する？」という質問。
//     実測: staff.commute_round_kmは13人中6人しか値が入っておらず、
//     スタッフ管理の編集フォームにはそもそも入力欄が無かった。
//     設定できるのは給与計算タブの明細行（payroll_lines、月ごと）だけで、
//     スタッフ台帳（staff）には反映されず、値の無い人は毎月0円のまま
//     再入力もできない状態だった。
//     スタッフ編集フォームに「自宅⇔センター往復km」「通勤費単価」を追加し、
//     一度設定すれば以後の月の給与計算に自動で使われるようにした。
//
//   ここで測ること
//     1. スタッフ編集フォームに往復km・単価の入力欄がある
//     2. 既存の値（例: 20km）が編集時にプリフィルされる
//     3. 保存すると staff テーブルへPATCHされる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_role_v1', 'admin'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { await d.dismiss(); });

  const STAFF = [
    { id: 's1', name: '吉田友美', role: '解体', commute_round_km: 20, commute_yen_per_km: 20, hourly_wage: 1200 },
  ];
  const patched = [];

  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = x => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m === 'PATCH' && /\/staff\b/.test(url)) { patched.push(JSON.parse(req.postData() || '{}')); return J([{}]); }
    if (m !== 'GET') return J([]);
    if (/\/staff\b/.test(url)) return J(STAFF);
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));

  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(600);

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  await page.evaluate(() => { document.querySelector('[data-tab="staff"]').click(); });
  await page.waitForTimeout(300);

  T('往復kmの入力欄がある', await page.$('#stf-f-commute_round_km') !== null, '');
  T('通勤費単価の入力欄がある', await page.$('#stf-f-commute_yen_per_km') !== null, '');

  await page.evaluate(() => staffEdit('s1'));
  await page.waitForTimeout(100);
  const kmVal = await page.$eval('#stf-f-commute_round_km', el => el.value);
  const yenVal = await page.$eval('#stf-f-commute_yen_per_km', el => el.value);
  T('既存の往復km(20)がプリフィルされる', kmVal === '20', kmVal);
  T('既存の単価(20)がプリフィルされる', yenVal === '20', yenVal);

  await page.fill('#stf-f-commute_round_km', '35.5');
  await page.evaluate(() => staffSave());
  await page.waitForTimeout(200);
  T('保存でstaffにPATCHされる', patched.length === 1, JSON.stringify(patched));
  T('往復kmが数値として送られる', patched[0] && patched[0].commute_round_km === 35.5, JSON.stringify(patched));

  T('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
