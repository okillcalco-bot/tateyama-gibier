// DB読み出しの1000行の壁（2026-09-17）
//   PostgREST は1回の応答を最大1000行で切る（max-rows）。limit=20000 と書いても1000行しか来ず、
//   過年度ページが「令和3〜5の途中（917頭）」で止まって見えた。
//   直し: 各ページの sb() は limit>1000 の GET を 1000行ずつ offset を進めて全部つなぐ。
//   ここでは 9ページの sb() を実際のページ上で呼び、疑似サーバー（1000行で切る）に対して
//   全部つながること／limit≤1000 はそのまま1回で済むこと／limit の残りだけ取りに行くことを測る。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const TOTAL = 2345;                  // 疑似テーブルの行数
const CAP = 1000;                    // サーバーが1回に返す上限（PostgREST max-rows）
// [ページ, 呼び方]  sig=A: sb(table, query) / sig=B: sb('GET', table, null, query)
const PAGES = [
  ['history.html', 'A'], ['public-analysis.html', 'A'], ['buyback.html', 'A'], ['mileage-analysis.html', 'A'],
  ['lca.html', 'A'], ['catch-analysis.html', 'A'], ['sales-dashboard.html', 'A'],
  ['index.html', 'B'], ['order-admin.html', 'B'],
];

async function open(browser, file) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_role_v1', 'admin'); sessionStorage.setItem('tg_access_v1', 'ok'); localStorage.setItem('tg_staff_key', 'k'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const reqs = [];
  await page.route('**/*', r => {
    const u = decodeURIComponent(r.request().url());
    if (u.startsWith('file:')) return r.continue();
    if (/cdnjs|jsdelivr|fonts\./.test(u)) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.Chart=function(){};window.Chart.defaults={font:{}};window.Chart.register=function(){};' });
    const m = u.match(/\/rest\/v1\/ptest\?(.*)$/);
    if (m) {
      const p = new URLSearchParams(m[1]);
      const limit = p.has('limit') ? Number(p.get('limit')) : TOTAL, offset = Number(p.get('offset') || 0);
      reqs.push({ limit: p.get('limit'), offset: p.get('offset') });
      const n = Math.max(0, Math.min(limit, CAP, TOTAL - offset));   // サーバーは1000行で切る
      const rows = Array.from({ length: n }, (_, i) => ({ id: offset + i }));
      return r.fulfill({ status: n < TOTAL - offset ? 206 : 200, contentType: 'application/json', headers: { 'content-range': `${offset}-${offset + n - 1}/*` }, body: JSON.stringify(rows) });
    }
    if (/rpc\/staff_key_ok/.test(u)) return r.fulfill({ status: 200, contentType: 'application/json', body: 'true' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.goto('file://' + path.resolve(__dirname, '../../' + file));
  await page.waitForTimeout(600);
  return { page, errors, reqs };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = []; const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  for (const [f, sig] of PAGES) {
    const { page, errors, reqs } = await open(browser, f);
    const call = (q) => page.evaluate(([sig, q]) => (sig === 'A' ? sb('ptest', q) : sb('GET', 'ptest', null, q)).then(rows => ({ n: rows.length, first: rows[0] && rows[0].id, last: rows[rows.length - 1] && rows[rows.length - 1].id, ids: rows.every((r, i) => r.id === i) })), [sig, q]);

    // 1) limit=20000 → 1000行ずつ3回で 2345行が全部つながる
    reqs.length = 0;
    const a = await call('?select=id&order=id.asc&limit=20000');
    T(`${f}: limit=20000 で ${TOTAL}行が全部つながる（サーバーは1000行で切る）`, a.n === TOTAL && a.first === 0 && a.last === TOTAL - 1 && a.ids, JSON.stringify(a));
    T(`${f}: 1000行ずつ offset を進めて3回で取る`, reqs.length === 3 && reqs.map(r => r.limit + '@' + r.offset).join() === '1000@0,1000@1000,1000@2000', JSON.stringify(reqs));

    // 2) limit≤1000 はそのまま1回（offset を付けない）
    reqs.length = 0;
    const b = await call('?select=id&limit=500');
    T(`${f}: limit=500 はそのまま1回で 500行`, b.n === 500 && reqs.length === 1 && reqs[0].limit === '500' && reqs[0].offset === null, JSON.stringify(reqs));

    // 3) limit=1500 は 1000 + 残り500 の2回で、1500行で止まる
    reqs.length = 0;
    const c = await call('?select=id&limit=1500');
    T(`${f}: limit=1500 は 1000＋残り500 の2回で 1500行`, c.n === 1500 && c.last === 1499 && reqs.map(r => r.limit + '@' + r.offset).join() === '1000@0,500@1000', JSON.stringify(reqs));

    // 4) limit の位置が先頭（?limit=…）でも付け替えられる
    reqs.length = 0;
    const d = await call('?limit=20000&select=id');
    T(`${f}: ?limit= が先頭でも全部つながる`, d.n === TOTAL && reqs.length === 3, JSON.stringify(reqs));

    T(`${f}: pageerrorなし`, errors.length === 0, errors.join(' / '));
    await page.context().close();
  }

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
