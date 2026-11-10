// 出店・納品先の在庫（outlet.html）: 読み込みは1回だけ・失敗したら黙らない（2026-11-10 全画面の見直し）
//
//   きっかけ（通信をすべて失敗させて全画面を測った）
//     ・読み込みに失敗すると何も出ず（未処理の例外）、納品先のボタンが空のままだった
//     ・店舗リンクなしで開くと、読み込み（load）が2回走っていた（同じ問い合わせを2度送っていた）
//
//   ここで測ること（納品先・商品は架空）
//     1. 開いたときの読み込みは1回だけ
//     2. 失敗したら画面に出す（未処理の例外にしない）。「もう一度読み込む」で読み直せる
//     3. 店舗リンク（?store=）で失敗したときも画面に出す
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

async function open(browser, query, net) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await ctx.addInitScript(() => {
    try { localStorage.setItem('tg_staff_key', 'TESTKEY'); sessionStorage.setItem('tg_role_v1', 'admin'); sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {}
    window.alert = () => {}; window.confirm = () => false; window.prompt = () => null;
    window.__rej = []; window.addEventListener('unhandledrejection', e => window.__rej.push(String(e.reason && e.reason.message || e.reason)));
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', rt => {
    const url = decodeURIComponent(rt.request().url());
    if (url.startsWith('file:')) return rt.continue();
    const J = (x, s) => rt.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (!/\/rest\/v1\//.test(url)) return rt.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    const table = url.split('/rest/v1/')[1].split('?')[0];
    net.calls[table] = (net.calls[table] || 0) + 1;
    if (net.fail) return J({ message: 'テスト用の通信失敗' }, 503);
    if (table === 'retail_outlets') return J([{ id: 'ro1', name: '架空直売所', delivery_notes: '' }]);
    if (table === 'products') return J([{ id: 'p1', name: '架空ジャーキー', unit: '袋', stock_qty: 5, price: 800 }]);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../outlet.html') + (query || ''));
  await page.waitForTimeout(800);
  return { ctx, page, errors };
}
const chips = page => page.evaluate(() => { const el = document.getElementById('chips'); const a = el.querySelector('[role=alert]'); const r = el.getBoundingClientRect(); return { text: el.innerText, alert: a ? a.innerText : '', w: r.width, h: r.height, over: Math.max(0, document.documentElement.scrollWidth - innerWidth), rej: window.__rej.slice() }; });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

  // 1. 読み込みは1回だけ
  const netA = { fail: false, calls: {} };
  const a = await open(browser, '', netA);
  const ca = await chips(a.page);
  T('1. 開いたとき、納品先の問い合わせは1回だけ', netA.calls.retail_outlets === 1 && netA.calls.products === 1, JSON.stringify(netA.calls));
  T('1. 納品先のボタンが出る', /架空直売所/.test(ca.text) && !ca.alert, ca.text);
  T('1. ページエラーなし', a.errors.length === 0 && ca.rej.length === 0, a.errors.concat(ca.rej).join(' / '));
  await a.ctx.close();

  // 2. 失敗したら画面に出す・読み直せる
  const netB = { fail: true, calls: {} };
  const b = await open(browser, '', netB);
  let cb = await chips(b.page);
  T('2. 失敗したら画面に出す', /読み込めませんでした/.test(cb.alert) && cb.w > 100 && cb.h > 30, JSON.stringify(cb));
  T('2. 未処理の例外にしない', b.errors.length === 0 && cb.rej.length === 0, b.errors.concat(cb.rej).join(' / '));
  T('2. 知らせはスマホの幅に収まる（横にはみ出さない）', cb.over === 0, cb.over);
  netB.fail = false;
  if (await b.page.$('#chips [role=alert] button')) await b.page.click('#chips [role=alert] button');
  await b.page.waitForTimeout(600);
  cb = await chips(b.page);
  T('2. 「もう一度読み込む」で読み直せる（知らせが消えて納品先が出る）', /架空直売所/.test(cb.text) && !cb.alert, cb.text);
  await b.ctx.close();

  // 3. 店舗リンクで失敗
  const netC = { fail: true, calls: {} };
  const c = await open(browser, '?store=TESTTOKEN', netC);
  const cc = await chips(c.page);
  T('3. 店舗リンクで失敗したときも画面に出す', /読み込めませんでした/.test(cc.alert), JSON.stringify(cc));
  T('3. 未処理の例外にしない', c.errors.length === 0 && cc.rej.length === 0, c.errors.concat(cc.rej).join(' / '));
  await c.ctx.close();

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
