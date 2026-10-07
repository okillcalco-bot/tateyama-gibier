// 衛生記録の日付・時刻は日本時間で出す
//
//   きっかけ（2026-10-07 保健所の立入当日に発見）
//     cleaning_logs.cleaned_at は timestamptz で、PostgREST は UTC（+00:00）で返す。
//     温度記録表は文字列を slice していたため、17:57 に記録した温度が「08:57」と出ていた。
//     また範囲指定の「2026-10-01T00:00:00」は UTC として扱われ、日本時間 0〜9時の記録が
//     前月・前日に入る／当日の清掃状況から抜ける。
//
//   ここで測ること
//     1. 温度記録表の日付・時刻が日本時間（17:57・朝8時の記録は当日扱い）
//     2. 日次衛生点検表・清掃記録表（月表）・市役所報告の清掃欄も日本時間の日付で振り分け
//     3. 月の範囲・当日の問い合わせは +09:00 付きで出す
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Tokyo' });
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));

  // PostgREST が実際に返す形（UTC）
  const LOGS = [
    { id: 'a', room: '冷蔵・冷凍庫', staff_name: '吉田友美', cleaned_at: '2026-10-01T23:30:00+00:00', temperature: '冷蔵-1 / 冷凍-20', items: '' }, // JST 10/2 08:30
    { id: 'b', room: '冷蔵・冷凍庫', staff_name: '今泉貴雄', cleaned_at: '2026-10-07T08:57:40.855+00:00', temperature: '冷蔵-1 / 冷凍-20', items: '' }, // JST 10/7 17:57
    { id: 'c', room: '解体室', staff_name: '川島幸子', cleaned_at: '2026-10-06T22:10:00+00:00', temperature: null, items: '床' }, // JST 10/7 07:10
  ];
  const reqs = [];
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    const qs = decodeURIComponent(u.split('?')[1] || '');
    if (/\/rest\/v1\/cleaning_logs/.test(u)) {
      reqs.push(qs);
      return J(/room=eq\.冷蔵・冷凍庫/.test(qs) ? LOGS.filter(l => l.room === '冷蔵・冷凍庫') : LOGS);
    }
    return J([]);
  });

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(600);

  const tl = await page.evaluate(async () => DOC_DEFS.find(d => d.key === 'temp_log').gen('2026-10'));
  T('温度記録表: 17:57 の記録は 10-07 17:57（UTCの 08:57 ではない）', tl.rows.some(r => r[0] === '10-07' && r[1] === '17:57'), JSON.stringify(tl.rows));
  T('温度記録表: 朝 8:30 の記録は当日 10-02 08:30（前日に入らない）', tl.rows.some(r => r[0] === '10-02' && r[1] === '08:30'), JSON.stringify(tl.rows));
  const monthReq = reqs.find(q => /room=eq\.冷蔵・冷凍庫/.test(q)) || '';
  T('月の範囲は日本時間（+09:00）で問い合わせる', /cleaned_at=gte\.2026-10-01T00:00:00\+09:00/.test(monthReq) && /cleaned_at=lte\.2026-10-31T23:59:59\+09:00/.test(monthReq), monthReq);

  const dc = await page.evaluate(async () => DOC_DEFS.find(d => d.key === 'daily_check').gen('2026-10'));
  const dates = dc.rows.map(r => r[0]);
  T('日次衛生点検表: 朝7:10の解体室清掃は 10-07 に入る（10-06 に入らない）', dates.includes('10-07') && !dates.includes('10-06') && !dates.includes('10-01'), dates.join(','));

  const parts = await page.evaluate(() => [jstParts('2026-10-06T15:00:00+00:00'), jstParts('2026-10-06T14:59:00Z')]);
  T('jstParts: UTC15:00 は翌日0:00、14:59 は当日23:59', parts[0].ymd === '2026-10-07' && parts[0].hm === '00:00' && parts[1].ymd === '2026-10-06' && parts[1].hm === '23:59', JSON.stringify(parts));

  const city = await page.evaluate(async () => { const d = await cityReportData('2026-10'); return JSON.stringify(d); });
  T('市役所報告の問い合わせも +09:00 付き', reqs.some(q => /select=room,staff_name,cleaned_at/.test(q) && /\+09:00/.test(q)), '');

  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
