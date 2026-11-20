// 注文システム（お店側）の見直し（2026-11-20 沖「注文システムは下記の観点で見直して」）
//
//   実測で分かったこと: 出荷待ちの注文は「配達予定: 日付」だけで、今日・明日・過ぎているの区別が無い。
//   時間帯とお客様のメモは出ていない。おすすめ掲示は8月のものが11月まで出たままで、古いと気づく手がかりが無い。
//
//   ここで測ること（お客様・商品・注文はすべて架空）
//     1. 納品希望日の印: 過ぎている／今日／明日／あとN日／未定 を言葉と色で出す（曜日つき）
//     2. 業務アプリの出荷待ちカードに、印・時間帯・お客様のメモが出る
//     3. 受発注管理の注文一覧と出荷カードに同じ印が出る（発送済みの注文には付けない）
//     4. 掲示板: 載せてから14日以上の掲示を知らせる。載せた日が出る
//     5. 商品一覧の「⭐ いちおし」から、商品・印・見出しが入った掲示の入力が開く。もう載っている商品はその掲示を開く
//     6. スマホの幅で横にはみ出さない／ページエラーなし
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const ymd = off => { const d = new Date(); d.setDate(d.getDate() + off); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const O = (id, off, extra) => Object.assign({ id, order_code: 'ORD-TEST-' + id, customer_name: '架空食堂' + id, status: '確認済', channel: 'ポータル', order_date: ymd(-5), delivery_date: off == null ? null : ymd(off), total_amount: 1000, created_at: '2026-11-01T00:00:00Z', order_items: [] }, extra || {});
const ORDERS = [O('a', -2), O('b', 0, { delivery_time_zone: '午前中', memo: '裏口から納品（架空のメモ）<b>x</b>' }), O('c', 1), O('d', 3), O('e', 10), O('f', null), O('g', -1, { status: '発送済' })];

async function mk(browser, file, handler, width) {
  const ctx = await browser.newContext({ viewport: { width: width || 390, height: 844 } });
  await ctx.addInitScript(() => {
    try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); localStorage.setItem('tg_staff_key', 'TESTKEY'); } catch (e) {}
    window.__alerts = []; window.alert = m => window.__alerts.push(String(m)); window.confirm = () => true; window.prompt = () => null; window.open = () => null;
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
    const r = handler(table, url, m);
    if (r !== undefined) return J(r);
    return J(m === 'GET' ? [] : [{ id: 'x' }]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../' + file));
  await page.waitForTimeout(900);
  return { ctx, page, errors };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

  // ── 業務アプリ（index.html）──
  {
    const { ctx, page, errors } = await mk(browser, 'index.html', (table, url, m) => {
      if (table === 'orders' && m === 'GET' && /status=in\.\(受注,確認済\)/.test(url)) return ORDERS.filter(o => o.status !== '発送済');
      if (table === 'rpc/base_orders') return { orders: [] };
    });
    // 1. 印の言葉（日付を固定して測る）
    const info = await page.evaluate(() => { const t = new Date(2026, 10, 20); return ['2026-11-18', '2026-11-20', '2026-11-21', '2026-11-23', '2026-11-30', null, '2026-12-01', 'こわれた値'].map(d => dueInfo(d, t)); });
    T('1. 過ぎている: 「2日過ぎています」', info[0].level === 'over' && /2日過ぎています/.test(info[0].label) && /11\/18（水）/.test(info[0].label), JSON.stringify(info[0]));
    T('1. 今日: 「今日が納品希望日」', info[1].level === 'today' && /今日が納品希望日 11\/20（金）/.test(info[1].label), info[1].label);
    T('1. 明日: 「明日が納品希望日」', info[2].level === 'soon' && /明日が納品希望日 11\/21（土）/.test(info[2].label), info[2].label);
    T('1. 3日以内: 「あと3日」', info[3].level === 'near' && /11\/23（月）・あと3日/.test(info[3].label), info[3].label);
    T('1. 先: 「あと10日」／月をまたいでも正しい', info[4].level === 'later' && /あと10日/.test(info[4].label) && /12\/1（火）・あと11日/.test(info[6].label), info[4].label + ' | ' + info[6].label);
    T('1. 未定・こわれた値は「納品日 未定」（過ぎた扱いにしない）', info[5].level === 'none' && info[7].level === 'none' && /未定/.test(info[5].label), JSON.stringify([info[5], info[7]]));

    await page.evaluate(() => document.querySelector('[data-tab="shipping"]').click());
    await page.waitForTimeout(1200);
    const cards = await page.evaluate(() => [...document.querySelectorAll('.order-card[id^="order-"]')].map(c => ({ id: c.id.replace('order-', ''), due: (c.querySelector('[data-due]') || {}).dataset?.due, text: c.innerText.replace(/\s+/g, ' '), memo: (c.querySelector('[data-order-memo]') || {}).innerHTML || '', red: /192,\s*57,\s*43|#c0392b/i.test((c.querySelector('[data-due]') || { getAttribute: () => '' }).getAttribute('style')) })));
    const by = id => cards.find(c => c.id === id) || {};
    T('2. 出荷待ちカード6件それぞれに印', cards.length === 6 && ['over', 'today', 'soon', 'near', 'later', 'none'].join() === ['a', 'b', 'c', 'd', 'e', 'f'].map(i => by(i).due).join(), JSON.stringify(cards.map(c => [c.id, c.due])));
    T('2. 過ぎている・今日は赤', by('a').red && by('b').red && !by('e').red);
    T('2. 時間帯が出る', /午前中/.test(by('b').text), by('b').text.slice(0, 120));
    T('2. お客様のメモが出る（タグは文字として出す）', /裏口から納品/.test(by('b').text) && /&lt;b&gt;/.test(by('b').memo) && !/<b>x<\/b>/.test(by('b').memo), by('b').memo);
    T('2. メモの無い注文にメモ欄は出さない', by('a').memo === '');
    const over = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
    T('6. 業務アプリ: スマホの幅で横にはみ出さない', over === 0, over);
    T('6. 業務アプリ: ページエラー・未処理の例外なし', errors.length === 0 && (await page.evaluate(() => window.__rej.length)) === 0, errors.concat(await page.evaluate(() => window.__rej)).join(' / '));
    await ctx.close();
  }

  // ── 受発注管理（order-admin.html）──
  {
    const old = new Date(Date.now() - 90 * 86400000).toISOString(), fresh = new Date(Date.now() - 3 * 86400000).toISOString();
    const BULL = [
      { id: 'b1', product_id: 'p1', product_name: '架空ロース', title: '今週のおすすめ', body: '', badge: '', sort_order: 1, is_active: true, created_at: old, image_url: '' },
      { id: 'b2', product_id: null, product_name: null, title: '新しいお知らせ', body: '', badge: '', sort_order: 2, is_active: true, created_at: fresh, image_url: '' },
      { id: 'b3', product_id: null, product_name: null, title: '下げた古い掲示', body: '', badge: '', sort_order: 3, is_active: false, created_at: old, image_url: '' },
    ];
    const PROD = [{ id: 'p1', display_name: '架空ロース', species: 'イノシシ', sort_order: 1, is_active: true, portal_visible: true, is_orderable: true, mark: '◎', parts: [], prices: [{ price_rank: 'standard', unit_price: 5000 }] },
      { id: 'p2', display_name: '架空モモ', species: 'シカ', sort_order: 2, is_active: true, portal_visible: true, is_orderable: true, mark: '△', parts: [], prices: [{ price_rank: 'standard', unit_price: 4000 }] }];
    const { ctx, page, errors } = await mk(browser, 'order-admin.html', (table, url, m) => {
      if (table === 'rpc/staff_key_ok') return true;
      if (table === 'rpc/admin_list_bulletins') return BULL;
      if (table === 'rpc/admin_list_portal_products') return PROD;
      if (table === 'orders' && m === 'GET') return ORDERS;
    }, 1200);
    await page.evaluate(async () => { await loadOrders(); });
    await page.waitForTimeout(300);
    const list = await page.evaluate(() => [...document.querySelectorAll('#ordersBody tr')].map(tr => ({ code: tr.cells[0].innerText.trim(), due: (tr.cells[2].querySelector('[data-due]') || {}).dataset?.due || '', text: tr.cells[2].innerText.replace(/\s+/g, ' ') })));
    const lby = id => list.find(r => r.code === 'ORD-TEST-' + id) || {};
    T('3. 注文一覧に印（過ぎ・今日・明日・未定）', lby('a').due === 'over' && lby('b').due === 'today' && lby('c').due === 'soon' && lby('f').due === 'none', JSON.stringify(list.map(r => [r.code, r.due])));
    T('3. 注文一覧に時間帯', /午前中/.test(lby('b').text), lby('b').text);
    T('3. 発送済みの注文には「過ぎています」を付けない', lby('g').due === '' && !/過ぎて/.test(lby('g').text), lby('g').text);
    const ship = await page.evaluate(() => [...document.querySelectorAll('.ship-card')].map(c => ({ due: (c.querySelector('[data-due]') || {}).dataset?.due, memo: (c.querySelector('[data-order-memo]') || {}).innerText || '' })));
    T('3. 出荷カードに印とメモ', ship.length === 6 && ship.filter(s => s.due).length === 6 && ship.some(s => /裏口から納品/.test(s.memo)), JSON.stringify(ship));

    // 4. 掲示の古さ
    await page.evaluate(async () => { await loadBulletins(); });
    await page.waitForTimeout(300);
    const st = await page.evaluate(() => { const e = document.getElementById('bullStale'); return { shown: e.style.display !== 'none', text: e.innerText, rows: [...document.querySelectorAll('#bullBody tr')].map(tr => tr.cells[2].innerText.replace(/\s+/g, ' ')) }; });
    T('4. 14日以上たった表示中の掲示を知らせる（1件・名前と日数つき）', st.shown && /1件/.test(st.text) && /今週のおすすめ 90日前/.test(st.text) && !/下げた古い掲示/.test(st.text) && !/新しいお知らせ/.test(st.text), st.text);
    T('4. 一覧に載せた日が出る', /90日前に掲載/.test(st.rows[0]) && /3日前に掲載/.test(st.rows[1]), st.rows.join(' | '));

    // 5. いちおし
    await page.evaluate(() => renderPortalProducts());
    const btns = await page.evaluate(() => [...document.querySelectorAll('#ppBody [data-pick]')].map(b => b.innerText.trim()));
    T('5. 商品ごとに「いちおし」ボタン。もう載っている商品は「いちおし中」', btns.length === 2 && /いちおし中/.test(btns[0]) && !/中/.test(btns[1]), btns.join(' | '));
    await page.evaluate(() => bullQuickPick('p2')); await page.waitForTimeout(200);
    const f = await page.evaluate(() => ({ id: document.getElementById('bullfId').value, product: document.getElementById('bullfProduct').value, badge: document.getElementById('bullfBadge').value, title: document.getElementById('bullfTitle').value, active: document.getElementById('bullfActive').checked, open: getComputedStyle(document.getElementById('bullModal')).display !== 'none' }));
    T('5. 新しい掲示の入力が、商品・印・見出し入りで開く', f.open && f.id === '' && f.product === 'p2' && f.badge === 'いちおし' && f.title === '架空モモ' && f.active, JSON.stringify(f));
    await page.evaluate(() => { closeModal('bullModal'); return bullQuickPick('p1'); }); await page.waitForTimeout(200);
    const g = await page.evaluate(() => ({ id: document.getElementById('bullfId').value, title: document.getElementById('bullfTitle').value }));
    T('5. もう載っている商品は、その掲示の編集が開く（二重に作らない）', g.id === 'b1' && g.title === '今週のおすすめ', JSON.stringify(g));
    T('6. 受発注管理: ページエラー・未処理の例外なし', errors.length === 0 && (await page.evaluate(() => window.__rej.length)) === 0, errors.concat(await page.evaluate(() => window.__rej)).join(' / '));
    await ctx.close();
  }

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 240) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
