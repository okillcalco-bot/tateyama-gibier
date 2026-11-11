// 受注管理（order-admin.html）: 読み込みに失敗したら黙らない（2026-11-10 全画面の見直し）
//
//   きっかけ（通信をすべて失敗させて全画面を測った）
//     ・最初の読み込み（注文・顧客・価格…）が失敗しても console.error だけで、画面は空の一覧のまま出ていた。
//       「空」と「読めなかった」の区別がつかない
//     ・その状態で「更新」を押すと、失敗していても「データを更新しました」と出ていた
//     ・請求書作成タブを開く／発行日を変える／↻ を押すとき、採番の取得に失敗すると
//       何も出ないまま未処理の例外（unhandledrejection）になっていた
//
//   ここで測ること（顧客・注文はすべて架空）
//     1. 読み込みに失敗したら、失敗したことと「もう一度読み込む」を画面に出す
//     2. 失敗しているあいだは「データを更新しました」と言わない
//     3. 通信が戻って読み直せたら、知らせは消えて一覧が出る
//     4. 採番に失敗したら番号欄に出す（未処理の例外にしない）。戻ったら ↻ で取り直せる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    try { localStorage.setItem('tg_staff_key', 'TESTKEY'); sessionStorage.setItem('tg_role_v1', 'admin'); sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {}
    window.__alerts = []; window.alert = m => window.__alerts.push(String(m)); window.confirm = () => false; window.prompt = () => null; window.open = () => null;
    window.__rej = []; window.addEventListener('unhandledrejection', e => window.__rej.push(String(e.reason && e.reason.message || e.reason)));
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const CUST = { id: 'cust-a', code: 'C0901', name: '架空食堂', address: '架空県架空市', is_active: true };
  const ORDERS = [{ id: 'o1', customer_id: CUST.id, customer_name: CUST.name, order_code: 'DIR-TEST-001', order_date: '2026-10-01', delivery_date: '2026-10-01', status: '発送済', total_amount: 1000,
    order_items: [{ id: 'i1', species: 'イノシシ', part_name: 'レバー', weight_kg: 2, unit_price: 500, subtotal: 1000, amount: 1000 }], shipments: [] }];
  const net = { failAll: true, failNumber: false };
  await page.route('**/*', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    if (url.startsWith('file:')) return rt.continue();
    const J = (x, s) => rt.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (!/\/rest\/v1\/|\/auth\/v1\//.test(url)) return rt.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    if (/rpc\/staff_key_ok/.test(url)) return J(true);
    if (net.failAll) return J({ message: 'テスト用の通信失敗' }, 503);
    if (m !== 'GET') return J([]);
    if (/\/documents\b/.test(url) && /doc_number=like/.test(url)) return net.failNumber ? J({ message: 'テスト用の通信失敗' }, 503) : J([{ doc_number: url.match(/like\.([^*&]+)/)[1] + '004' }]);
    if (/\/customers\b/.test(url)) return J([CUST]);
    if (/\/orders\b/.test(url)) return J(ORDERS);
    return J([]);
  });
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);
  const banner = () => page.evaluate(() => { const el = document.getElementById('loadErrBanner'); if (!el) return null; const r = el.getBoundingClientRect(); return { text: el.innerText, w: r.width, h: r.height, btn: !!el.querySelector('button'), role: el.getAttribute('role') }; });

  // 1. 最初の読み込みが失敗
  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(900);
  let b = await banner();
  T('1. 読み込みに失敗したら知らせを出す（画面に見えている）', b && b.w > 100 && b.h > 20 && /読み込めませんでした/.test(b.text), JSON.stringify(b));
  T('1. 「空に見えても0件とは限らない」と伝える', b && /0件」とは限りません/.test(b.text), b && b.text);
  T('1. 「もう一度読み込む」を押せる', b && b.btn && /もう一度読み込む/.test(b.text), b && b.text);
  T('1. 読み上げにも伝わる（role=alert）', b && b.role === 'alert', b && b.role);

  // 2. 失敗しているあいだは「更新しました」と言わない
  await page.evaluate(() => refreshAll());
  await page.waitForTimeout(500);
  let al = await page.evaluate(() => window.__alerts.slice());
  b = await banner();
  T('2. 失敗しているあいだは「データを更新しました」と出さない', !al.some(a => /更新しました/.test(a)), JSON.stringify(al));
  T('2. 知らせは出たまま', b && /読み込めませんでした/.test(b.text), JSON.stringify(b));

  // 3. 通信が戻ったら、知らせの「もう一度読み込む」で読み直せる
  net.failAll = false;
  if (await page.$('#loadErrBanner button')) await page.click('#loadErrBanner button'); else await page.evaluate(() => refreshAll());
  await page.waitForTimeout(900);
  al = await page.evaluate(() => window.__alerts.slice());
  b = await banner();
  const listed = await page.evaluate(() => { switchTab('orders'); return document.body.innerText.includes('DIR-TEST-001') || document.body.innerText.includes('架空食堂'); });
  T('3. 読み直せたら知らせは消える', b === null, JSON.stringify(b));
  T('3. 読み直せたときは「データを更新しました」と出す', al.some(a => /更新しました/.test(a)), JSON.stringify(al));
  T('3. 一覧に注文が出る', listed);

  // 4. 採番の失敗
  net.failNumber = true;
  await page.evaluate(() => { window.__rej.length = 0; switchTab('invoice'); });
  await page.waitForTimeout(600);
  let num = await page.evaluate(() => { const el = document.getElementById('invNumber'); return { v: el.value, ph: el.placeholder, rej: window.__rej.slice() }; });
  T('4. 採番に失敗したら番号欄に出す', num.v === '' && /番号を取れませんでした/.test(num.ph), JSON.stringify(num));
  T('4. 未処理の例外にしない', num.rej.length === 0, JSON.stringify(num.rej));
  await page.evaluate(() => { const d = document.getElementById('invDate'); d.value = '2026-10-15'; d.dispatchEvent(new Event('change', { bubbles: true })); });
  await page.waitForTimeout(400);
  num = await page.evaluate(() => { const el = document.getElementById('invNumber'); return { v: el.value, ph: el.placeholder, rej: window.__rej.slice() }; });
  T('4. 発行日を変えたときも同じ（黙らない・例外にしない）', num.v === '' && /番号を取れませんでした/.test(num.ph) && num.rej.length === 0, JSON.stringify(num));
  net.failNumber = false;
  await page.click('button[title="採番し直す"]');
  await page.waitForTimeout(500);
  num = await page.evaluate(() => { const el = document.getElementById('invNumber'); return { v: el.value, ph: el.placeholder }; });
  T('4. 通信が戻ったら ↻ で取り直せる（最後の番号の次・202610-005）', /-202610-005$/.test(num.v) && num.ph === '', JSON.stringify(num));

  T('ページエラーなし', errors.length === 0, errors.join(' / '));
  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 240) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
