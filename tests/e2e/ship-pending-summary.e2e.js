// 出荷待ちの注文を分かりやすく（2026-11-20 沖「注文入ってるかどうかわかりづらい」）
//
//   これまで: 出荷タブの印（バッジ）は注文ポータルの数だけ。BASE・通販（さとふる・まいぷれ・AWAWA）は
//   出荷タブの下のほうまで開かないと分からなかった。
//
//   ここで測ること（注文はすべて架空）
//     1. 出荷タブの一番上に「出荷待ちの注文 N件」と、注文ポータル／BASE／通販の件数が出る
//     2. 新しい注文・BASE・今日までの集荷は赤（急ぎ）で出る
//     3. メニューの出荷タブの印は3つの合計。急ぎがあれば赤
//     4. ダッシュボードの「今日やること」に通販の注文が出る（今日までの集荷は赤）
//     5. 注文が増えたら「新しい注文が入りました」と知らせる
//     6. どれかを確かめられなかったら「0件」に見せない（知らせ・印は「?」）
//     7. 件数を押すとその一覧へ移る／スマホの幅で横にはみ出さない／ページエラーなし
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const today = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();

async function open(browser, net) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await ctx.addInitScript(() => {
    try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); localStorage.setItem('tg_staff_key', 'TESTKEY'); } catch (e) {}
    window.alert = () => {}; window.confirm = () => true; window.prompt = () => null; window.open = () => null;
    window.__rej = []; window.addEventListener('unhandledrejection', e => window.__rej.push(String(e.reason && e.reason.message || e.reason)));
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    if (url.startsWith('file:')) return rt.continue();
    const J = (x, s) => rt.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (!/\/rest\/v1\//.test(url)) return rt.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    const table = url.split('/rest/v1/')[1].split('?')[0];
    if (table === 'orders' && m === 'GET' && /status=in\.\(受注,確認済\)/.test(url)) return net.failPortal ? J({ message: 'テスト用の通信失敗' }, 503) : J(net.portal);
    if (table === 'rpc/base_orders') return J({ orders: net.base.map((o, i) => ({ unique_key: 'B' + i, dispatch_status: 'ordered', ordered: 1, order_items: [{ title: '架空ジャーキー', status: 'ordered' }] })) });
    if (table === 'marketplace_orders' && m === 'GET') return net.failMp ? J({ message: 'テスト用の通信失敗' }, 503) : J(net.mp);
    if (m !== 'GET') return J([{ id: 'x' }], 201);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(900);
  return { ctx, page, errors };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

  const net = {
    portal: [{ id: 'p1', status: '受注' }, { id: 'p2', status: '確認済' }],
    base: [],
    mp: [{ id: 'm1', pickup_date: today, item_code: '9000001' }, { id: 'm2', pickup_date: '2099-12-31', item_code: '9000002' }],
  };
  const { ctx, page, errors } = await open(browser, net);
  const baseCount = await page.evaluate(async () => { try { const r = await baseBacklogFetch(); return r.candidates.length; } catch (e) { return 'err:' + e.message; } });
  net.baseExpected = typeof baseCount === 'number' ? baseCount : 0;

  // 出荷タブを開く
  await page.evaluate(() => document.querySelector('[data-tab="shipping"]').click());
  await page.waitForTimeout(900);
  const sum = await page.evaluate(() => {
    const box = document.getElementById('ship-summary'); const r = box.getBoundingClientRect();
    const chips = [...box.querySelectorAll('[data-ship-chip]')].map(b => ({ t: b.dataset.shipChip, text: b.innerText.replace(/\s+/g, ' '), red: /200,\s*80,\s*80/.test(b.getAttribute('style')) }));
    const panel = document.getElementById('panel-shipping');
    return { text: box.innerText.replace(/\s+/g, ' '), chips, top: box === panel.querySelector('.section'), h: r.height, over: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      badge: document.getElementById('nav-badge-shipping').textContent, badgeWarn: document.getElementById('nav-badge-shipping').classList.contains('warn') };
  });
  const total = 2 + net.baseExpected + 2;
  T('1. 出荷タブの一番上に出る', sum.top && sum.h > 60, JSON.stringify({ top: sum.top, h: sum.h }));
  T('1. 「出荷待ちの注文 N件」（ポータル2＋BASE＋通販2）', new RegExp('出荷待ちの注文 ' + total + '件').test(sum.text), sum.text);
  const chip = t => sum.chips.find(c => c.t === t) || {};
  T('1. 注文ポータル 2件（新しい注文1件）', /2\s*件/.test(chip('ship-portal').text) && /新しい注文 1件/.test(chip('ship-portal').text), chip('ship-portal').text);
  T('1. 通販 2件（今日までに集荷1件）', /2\s*件/.test(chip('ship-mp').text) && /今日までに集荷 1件/.test(chip('ship-mp').text), chip('ship-mp').text);
  T('2. 新しい注文があるポータルは赤', chip('ship-portal').red);
  T('2. 今日までに集荷がある通販は赤', chip('ship-mp').red);
  T('3. メニューの印は合計で、急ぎがあるので赤', sum.badge === String(total) && sum.badgeWarn, JSON.stringify({ badge: sum.badge, warn: sum.badgeWarn }));
  T('7. スマホの幅で横にはみ出さない', sum.over === 0, sum.over);

  // 7. 押すと一覧へ
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.querySelector('[data-ship-chip="ship-mp"]').click());
  await page.waitForTimeout(800);
  const y = await page.evaluate(() => document.getElementById('ship-mp').getBoundingClientRect().top);
  T('7. 通販の件数を押すと通販の一覧へ移る', y >= -5 && y < 200, y);

  // 5. 増えたら知らせる
  net.mp.push({ id: 'm3', pickup_date: '2099-12-31', item_code: '9000003' });
  await page.evaluate(() => { document.querySelectorAll('#toasts .toast').forEach(e => e.remove()); return shipSummaryRefresh(); });
  await page.waitForTimeout(300);
  const toasts = await page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map(e => e.textContent));
  T('5. 注文が増えたら「新しい注文が入りました」と知らせる', toasts.some(t => /新しい注文が入りました/.test(t) && /通販 1件/.test(t)), toasts.join(' / '));

  // 4. 今日やること
  await page.evaluate(() => loadTodayTodos()); await page.waitForTimeout(600);
  const todo = await page.evaluate(() => document.getElementById('today-todos').innerText.replace(/\s+/g, ' '));
  T('4. 今日やることに「今日までに集荷」の通販が出る', /1 ⏰ 通販の注文（今日までに集荷）/.test(todo), todo);
  T('4. 今日やることに残りの通販の注文が出る', /2 🛍 通販の注文/.test(todo), todo);

  // 6. 確かめられなかった
  net.failMp = true; net.failPortal = true;
  await page.evaluate(() => shipSummaryRefresh()); await page.waitForTimeout(300);
  const f = await page.evaluate(() => ({ alert: (document.querySelector('#ship-summary [role=alert]') || {}).innerText || '', text: document.getElementById('ship-summary').innerText, badge: document.getElementById('nav-badge-shipping').textContent }));
  T('6. 確かめられなかったら「注文が無いとは限りません」と出す', /確かめられませんでした/.test(f.alert) && /注文ポータル/.test(f.alert) && /通販/.test(f.alert), f.alert);
  T('6. 確かめられないのに「ありません」とは出さない', !/出荷待ちの注文はありません/.test(f.text), f.text.slice(0, 120));
  T('6. 確かめられなかった欄は「0件・なし」でなく「?・確かめられません」', (f.text.match(/確かめられません(?!でした)/g) || []).length === 2 && !/注文ポータル・電話など\s*0\s*件/.test(f.text), f.text.replace(/\s+/g, ' ').slice(0, 200));
  net.failMp = false; net.failPortal = false;

  T('7. ページエラー・未処理の例外なし', errors.length === 0 && (await page.evaluate(() => window.__rej.length)) === 0, errors.concat(await page.evaluate(() => window.__rej)).join(' / '));
  await ctx.close();

  // 1. 何もないとき
  {
    const n2 = { portal: [], base: [], mp: [] };
    const o = await open(browser, n2);
    await o.page.evaluate(() => document.querySelector('[data-tab="shipping"]').click()); await o.page.waitForTimeout(900);
    const t = await o.page.evaluate(() => ({ text: document.getElementById('ship-summary').innerText, badge: document.getElementById('nav-badge-shipping').textContent }));
    T('1. 注文がないときは「出荷待ちの注文はありません」・印なし', /出荷待ちの注文はありません/.test(t.text) && t.badge === '', JSON.stringify(t));
    await o.ctx.close();
  }

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
