// 捕獲記録（capture-form.html）: 名簿を読めなかったときに、古い固定リストを黙って出さない（2026-11-10 全画面の見直し）
//
//   きっかけ（通信をすべて失敗させて全画面を測った）
//     スタッフ名簿を読めないと、コードに書いてあった昔の固定リスト（5人分）が記録者の候補に黙って出ていた。
//     今の名簿と合っていないので、記録者に今いない人の名前が入りうる。読めなかったこと自体も画面に出ていなかった。
//     捕獲者台帳を読めなかったときも何も出ていなかった。
//
//   ここで測ること（スタッフ名は架空）
//     1. 読めたとき: 名簿どおりの候補が出て、この端末に控えを残す。知らせは出さない
//     2. 読めなかったとき（控えあり）: 控えの名簿を候補に出し、読めなかったことと控えの日付を画面に出す
//     3. 読めなかったとき（控えなし）: 候補を出さない（固定リストを出さない）・読めなかったことを画面に出す
//     4. 捕獲者台帳を読めなかったときも画面に出す
//     5. 知らせはスマホの幅に収まり、「読み直す」は確認してから（入力中の内容を黙って消さない）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

async function open(browser, net, cache) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, timezoneId: 'Asia/Tokyo', locale: 'ja-JP' });
  await ctx.addInitScript(c => {
    try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); localStorage.setItem('tg_staff_key', 'TESTKEY'); if (c) localStorage.setItem('tgc_staff_names_v1', JSON.stringify(c)); } catch (e) {}
    window.__dlg = []; window.alert = m => window.__dlg.push('alert:' + m); window.confirm = m => { window.__dlg.push('confirm:' + m); return false; }; window.prompt = () => null;
    window.__rej = []; window.addEventListener('unhandledrejection', e => window.__rej.push(String(e.reason && e.reason.message || e.reason)));
  }, cache || null);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', rt => {
    const url = decodeURIComponent(rt.request().url());
    if (url.startsWith('file:')) return rt.continue();
    const J = (x, s) => rt.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (!/\/rest\/v1\//.test(url)) return rt.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    const table = url.split('/rest/v1/')[1].split('?')[0];
    if (table === 'staff') return net.failStaff ? J({ message: 'テスト用の通信失敗' }, 503) : J([{ name: '架空 太郎' }, { name: '架空 花子' }]);
    if (table === 'hunters') return net.failHunters ? J({ message: 'テスト用の通信失敗' }, 503) : J([{ id: 'h1', name: '架空 捕獲者', name_public: true }]);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../capture-form.html'));
  await page.waitForTimeout(900);
  const state = await page.evaluate(() => {
    const w = document.getElementById('masterWarn'); const r = w ? w.getBoundingClientRect() : null;
    let cached = null; try { cached = JSON.parse(localStorage.getItem('tgc_staff_names_v1') || 'null'); } catch (e) {}
    return { opts: [...document.querySelectorAll('#recorder option')].map(o => o.value).filter(Boolean), warn: w ? w.innerText : '', warnW: r ? r.width : 0, warnRight: r ? r.right : 0,
      role: w ? w.getAttribute('role') : '', over: Math.max(0, document.documentElement.scrollWidth - innerWidth), cached, rej: window.__rej.slice(),
      btnH: w && w.querySelector('button') ? w.querySelector('button').getBoundingClientRect().height : 0 };
  });
  return { ctx, page, errors, state };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

  // 1. 読めたとき
  const a = await open(browser, {}, null);
  T('1. 名簿どおりの候補が出る', JSON.stringify(a.state.opts) === JSON.stringify(['架空 太郎', '架空 花子']), JSON.stringify(a.state.opts));
  T('1. この端末に控えを残す', a.state.cached && JSON.stringify(a.state.cached.names) === JSON.stringify(['架空 太郎', '架空 花子']) && a.state.cached.at > 0, JSON.stringify(a.state.cached));
  T('1. 読めたときは知らせを出さない', a.state.warn === '', a.state.warn);
  await a.ctx.close();

  // 2. 読めなかったとき（控えあり）
  const at = new Date('2026-11-01T03:00:00Z').getTime();
  const b = await open(browser, { failStaff: true }, { names: ['架空 太郎', '架空 花子', '試験 次郎'], at });
  T('2. 控えの名簿だけを候補に出す（固定リストの名前を混ぜない）', JSON.stringify(b.state.opts) === JSON.stringify(['架空 太郎', '架空 花子', '試験 次郎']), JSON.stringify(b.state.opts));
  T('2. 読めなかったことと、控えの日付（2026/11/1）を画面に出す', /スタッフ名簿を読み込めませんでした/.test(b.state.warn) && /前回読めた名簿（2026\/11\/1）/.test(b.state.warn), b.state.warn);
  T('2. 控えは消さない（次に読めるまで残す）', b.state.cached && b.state.cached.at === at, JSON.stringify(b.state.cached));
  await b.ctx.close();

  // 3. 読めなかったとき（控えなし）
  const c = await open(browser, { failStaff: true }, null);
  T('3. 候補を出さない（固定リストを出さない）', c.state.opts.length === 0, JSON.stringify(c.state.opts));
  T('3. 読めなかったことを画面に出す', /スタッフ名簿を読み込めませんでした/.test(c.state.warn) && /候補が出せません/.test(c.state.warn), c.state.warn);
  T('3. 読み上げにも伝わる（role=alert）', c.state.role === 'alert', c.state.role);
  T('3. ページエラー・未処理の例外なし', c.errors.length === 0 && c.state.rej.length === 0, c.errors.concat(c.state.rej).join(' / '));

  // 5. 見た目と「読み直す」
  T('5. 知らせはスマホの幅に収まる', c.state.warnW > 200 && c.state.warnRight <= 390 && c.state.over === 0, JSON.stringify([c.state.warnW, c.state.warnRight, c.state.over]));
  T('5. 「読み直す」は指で押せる大きさ（高さ36px以上）', c.state.btnH >= 36, c.state.btnH);
  await c.page.evaluate(() => { document.getElementById('memo').value = '入力中のメモ'; });
  if (await c.page.$('#masterWarn button')) await c.page.click('#masterWarn button');
  await c.page.waitForTimeout(300);
  const after = await c.page.evaluate(() => ({ dlg: window.__dlg.slice(), memo: document.getElementById('memo').value }));
  T('5. 「読み直す」は確認を出す（断れば入力中の内容は残る）', after.dlg.some(d => /^confirm:.*入力中の内容は消えます/.test(d)) && after.memo === '入力中のメモ', JSON.stringify(after));
  await c.ctx.close();

  // 4. 捕獲者台帳を読めなかったとき
  const d = await open(browser, { failHunters: true }, null);
  T('4. 捕獲者台帳を読めなかったことを画面に出す', /捕獲者台帳を読み込めませんでした/.test(d.state.warn), d.state.warn);
  T('4. スタッフ名簿は読めているので候補は出る', d.state.opts.length === 2, JSON.stringify(d.state.opts));
  T('4. ページエラー・未処理の例外なし', d.errors.length === 0 && d.state.rej.length === 0, d.errors.concat(d.state.rej).join(' / '));
  await d.ctx.close();

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
