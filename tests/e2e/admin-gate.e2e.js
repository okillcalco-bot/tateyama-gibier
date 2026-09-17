// 解析ページは管理者だけ（admin-gate.js）
//   「解析は管理者だけが見られるようにしたいね」（2026-09-17）
//   対象: history / buyback / lca / mileage-analysis / catch-analysis / sales-dashboard
//   1. 管理者でないセッションで開くと、コード入力の画面になり、中身は隠れ、DB は読まない
//   2. 違うコード → 「コードが違います」。正しいコード（2468）→ 画面が開き、DB を読み始め、セッションが管理者になる
//   3. 業務アプリで管理者になったセッション（tg_role_v1=admin）はそのまま開く
//   4. admin-gate.js が読めなかったときは、黙って開かずにそう表示する
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const PAGES = ['history.html', 'buyback.html', 'lca.html', 'mileage-analysis.html', 'catch-analysis.html', 'sales-dashboard.html'];

async function open(browser, file, { admin = false, blockGate = false } = {}) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(a => { try { if (a) sessionStorage.setItem('tg_role_v1', 'admin'); localStorage.setItem('tg_staff_key', 'k'); } catch (e) {} }, admin);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const rest = [];
  await page.route('**/*', r => {
    const u = decodeURIComponent(r.request().url());
    if (blockGate && /admin-gate\.js$/.test(u)) return r.abort();
    if (u.startsWith('file:')) return r.continue();
    if (/cdnjs|jsdelivr|fonts\./.test(u)) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.Chart=function(){};window.Chart.defaults={font:{}};window.Chart.register=function(){};' });
    const m = u.match(/\/rest\/v1\/([\w/]+)/); if (m) rest.push(m[1]);
    if (/rpc\/staff_key_ok/.test(u)) return r.fulfill({ status: 200, contentType: 'application/json', body: 'true' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.goto('file://' + path.resolve(__dirname, '../../' + file));
  await page.waitForTimeout(700);
  return { page, errors, rest };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = []; const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  for (const f of PAGES) {
    // 1) 管理者でない
    const a = await open(browser, f);
    const st = await a.page.evaluate(() => ({
      gate: !!document.getElementById('admin-gate'), closed: document.documentElement.getAttribute('data-admin-gate'),
      hidden: [...document.body.children].filter(el => el.id !== 'admin-gate').every(el => getComputedStyle(el).visibility === 'hidden'),
      text: (document.getElementById('admin-gate') || {}).textContent || '' }));
    T(`${f}: 管理者でないとコード入力の画面（管理者専用ページ）になり、中身は隠れる`, st.gate && st.closed === 'closed' && st.hidden && /管理者専用ページ/.test(st.text), JSON.stringify([st.closed, st.hidden]));
    T(`${f}: コードを入れるまで DB を読まない`, a.rest.length === 0, a.rest.join(','));
    await a.page.fill('#admin-gate-code', '0000');
    await a.page.waitForTimeout(150);
    const err = await a.page.evaluate(() => document.getElementById('admin-gate-err').textContent);
    T(`${f}: 違うコードは「コードが違います」`, /コードが違います/.test(err) && (await a.page.evaluate(() => !!document.getElementById('admin-gate'))), err);
    await a.page.fill('#admin-gate-code', '2468');
    await a.page.waitForTimeout(700);
    const after = await a.page.evaluate(() => ({ gate: !!document.getElementById('admin-gate'), attr: document.documentElement.getAttribute('data-admin-gate'), role: sessionStorage.getItem('tg_role_v1'), access: sessionStorage.getItem('tg_access_v1') }));
    T(`${f}: 正しいコードで開き、セッションが管理者になる`, !after.gate && after.attr === null && after.role === 'admin' && after.access === 'ok', JSON.stringify(after));
    T(`${f}: 開いたあとは DB を読み始める`, a.rest.length > 0, String(a.rest.length));
    T(`${f}: pageerrorなし`, a.errors.length === 0, a.errors.join(' / '));
    await a.page.context().close();

    // 3) 管理者セッション
    const b = await open(browser, f, { admin: true });
    T(`${f}: 管理者セッションならそのまま開いて DB を読む`, !(await b.page.evaluate(() => !!document.getElementById('admin-gate'))) && b.rest.length > 0, String(b.rest.length));
    await b.page.context().close();

    // 4) admin-gate.js が読めない
    const c = await open(browser, f, { blockGate: true });
    T(`${f}: admin-gate.js が読めなければ開かずにそう表示する`, /admin-gate\.js/.test(await c.page.evaluate(() => document.body.innerText)) && c.rest.length === 0, String(c.rest.length));
    await c.page.context().close();
  }

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
