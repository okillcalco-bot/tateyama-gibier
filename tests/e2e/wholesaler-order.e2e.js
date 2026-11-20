// 仲卸用の注文と、冷凍・冷蔵の指定（2026-11-20 沖「トレタテとかノブレスオブリージュは仲卸なので、そこから他の飲食店の
//   注文がメインになるため、仲卸用の注文バージョンも作っておいて。それと、冷蔵も選べるように備考欄への記入もできるように」）
//
//   実測: 仲卸経由の出荷は ノブレス51店・43件、トレタテ16店・27件。どれも「お店の名義＋備考に仲卸の名前」で入っている。
//
//   ここで測ること（お客様・お店・商品はすべて架空）
//     1. 仲卸のお客様: 「仲卸用」の印が出て、確認の画面でお届け先のお店を選べる（名前・かなで探せる）
//     2. お届け先を選ばないと注文できない（自社あてに化けない）。選んだお店・温度・備考がそのまま送られる
//     3. 「自社あて」を選ぶと登録の住所を見せ、お届け先なしで送る
//     4. 完了の画面と履歴・進行中の注文に、お届け先のお店と冷蔵が出る
//     5. 普通のお客様: お届け先の欄は出ない。冷凍・冷蔵は選べ、備考も書ける。既定は冷凍
//     6. 新しい注文の関数がまだ無い（404）とき: 今までの関数で注文でき、冷蔵は備考の先頭に【冷蔵希望】として伝わる
//     7. お届け先の一覧を読めなかったら、確認の画面で知らせて読み直せる（黙って自社あてにしない）
//     8. お店側: 冷蔵の注文に「❄ 冷蔵で発送」の印。送り状は、住所の無い注文なら顧客台帳から引き、冷蔵にしておく。
//        台帳から読めなければ知らせる
//     9. スマホの幅で横にはみ出さない／ページエラーなし
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const CATALOG = [{ product_id: 'p1', display_name: 'ロース ブロック', species: 'イノシシ', mark: '◎', unit_price: 5000, is_orderable: true, min_order_kg: 0.5, step_kg: 0.5, is_favorite: false }];
const SHOPS = [{ id: 's1', name: '架空ビストロ', kana: 'かくうびすとろ', area: '東京都架空区' }, { id: 's2', name: 'テスト割烹', kana: 'てすとかっぽう', area: '千葉県架空市' }, { id: 's3', name: '見本食堂', kana: 'みほんしょくどう', area: null }];

async function portal(browser, net) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  net.calls = [];
  await page.route('**/rest/v1/**', rt => {
    const url = rt.request().url();
    const J = (x, s) => rt.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (!/\/rpc\//.test(url)) return J([]);
    const fn = url.split('/rpc/')[1].split('?')[0];
    const body = JSON.parse(rt.request().postData() || '{}');
    net.calls.push({ fn, body });
    if (fn === 'portal_login_v2') return J([{ status: 'ok', token: 'T', must_change: false, name: net.name, honorific: '御中' }]);
    if (fn === 'portal_me') return J([{ name: net.name, honorific: '御中', address: '架空県架空市1-1' }]);
    if (fn === 'portal_catalog') return J(CATALOG);
    if (fn === 'portal_ship_to_list') return net.shipTo === 'missing' ? J({ code: 'PGRST202', message: 'Could not find the function' }, 404) : net.shipTo === 'fail' ? J({ message: 'テスト用の通信失敗' }, 503) : J(net.shipTo);
    if (fn === 'portal_my_orders') return J(net.orders || []);
    if (fn === 'portal_place_order_v2') return net.v2missing ? J({ code: 'PGRST202', message: 'Could not find the function' }, 404) : J({ order_code: 'ORD-TEST-V2', items: [{ name: 'ロース ブロック', requested_kg: 0.5, unit_price: 5000, amount: 2500 }], total_amount: 2500 });
    if (fn === 'portal_place_order') return J({ order_code: 'ORD-TEST-V1', items: [], total_amount: 0 });
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../order.html'));
  await page.waitForTimeout(300);
  await page.fill('#lg-id', 'C9999'); await page.fill('#lg-pw', 'password'); await page.click('#lg-btn');
  await page.waitForTimeout(700);
  return { ctx, page, errors };
}
const toConfirm = async page => { await page.evaluate(() => { showScreen('list'); addToCart('p1'); }); await page.click('#bar-go'); await page.waitForTimeout(300); };
const last = (net, fn) => net.calls.filter(c => c.fn === fn).pop();

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

  // ── 仲卸のお客様 ──
  {
    const net = { name: '架空仲卸', shipTo: { is_wholesaler: true, shops: SHOPS },
      orders: [{ id: 'o1', order_code: 'ORD-TEST-1', status: '受注', order_date: '2026-11-20', delivery_date: '2026-11-25', total_amount: 2500, can_doc: false, ship_to_name: '架空ビストロ', temp_zone: '冷蔵', items: [{ name: 'ロース ブロック', kg: 0.5 }], shipments: [] }] };
    const { ctx, page, errors } = await portal(browser, net);
    const head = await page.evaluate(() => ({ badge: !!document.querySelector('#h-name .wsbadge'), text: document.getElementById('h-name').innerText, act: document.getElementById('myactive').innerText.replace(/\s+/g, ' ') }));
    T('1. 仲卸のお客様には「仲卸用」の印が出る', head.badge && /架空仲卸/.test(head.text), head.text);
    T('4. 進行中の注文に、お届け先のお店と冷蔵が出る', /架空ビストロ あて/.test(head.act) && /冷蔵/.test(head.act), head.act);
    await toConfirm(page);
    const c1 = await page.evaluate(() => ({ box: !document.getElementById('c-shipto-box').classList.contains('hidden'), addrHidden: document.getElementById('c-addr-box').classList.contains('hidden'), opts: [...document.getElementById('c-shipto').options].map(o => o.textContent), temp: tempChosen() }));
    T('1. 確認の画面にお届け先のお店の一覧が出る（市区町村つき・自社あても選べる）', c1.box && c1.opts.length === 5 && /架空ビストロ（東京都架空区）/.test(c1.opts[1]) && c1.opts[3] === '見本食堂' && /自社あて（架空仲卸）/.test(c1.opts[4]), JSON.stringify(c1.opts));
    T('1. お店を選ぶまで、登録の住所（自社）は見せない', c1.addrHidden);
    await page.fill('#c-shipto-q', 'テスト'); await page.waitForTimeout(100);
    let opts = await page.evaluate(() => [...document.getElementById('c-shipto').options].map(o => o.value));
    T('1. お店の名前でさがせる', opts.join() === ',s2,__self', opts.join());
    await page.fill('#c-shipto-q', 'みほん'); await page.waitForTimeout(100);
    opts = await page.evaluate(() => [...document.getElementById('c-shipto').options].map(o => o.value));
    T('1. かなでもさがせる', opts.join() === ',s3,__self', opts.join());
    await page.fill('#c-shipto-q', ''); await page.waitForTimeout(100);

    // 2. 選ばないと注文できない
    await page.click('#c-go'); await page.waitForTimeout(400);
    const blocked = await page.evaluate(() => ({ toast: [...document.querySelectorAll('#toasts .toast')].map(e => e.textContent).join(' / '), onConfirm: !document.getElementById('scr-confirm').classList.contains('hidden') }));
    T('2. お届け先を選ばないと注文できない（送らない）', !last(net, 'portal_place_order_v2') && !last(net, 'portal_place_order') && /お届け先のお店を選んでください/.test(blocked.toast) && blocked.onConfirm, blocked.toast);

    await page.selectOption('#c-shipto', 's2');
    await page.check('input[name="c-temp"][value="冷蔵"]');
    await page.fill('#c-memo', '午前着でお願いします');
    await page.click('#c-go'); await page.waitForTimeout(600);
    const sent = last(net, 'portal_place_order_v2');
    T('2. 選んだお店・冷蔵・備考がそのまま送られる', sent && sent.body.p_ship_to === 's2' && sent.body.p_temp === '冷蔵' && sent.body.p_memo === '午前着でお願いします' && !last(net, 'portal_place_order'), JSON.stringify(sent && sent.body).slice(0, 300));
    const done = await page.evaluate(() => ({ shown: !document.getElementById('scr-done').classList.contains('hidden'), text: document.getElementById('d-delivery').innerText.replace(/\s+/g, ' ') }));
    T('4. 完了の画面に、お届け先のお店と温度が出る', done.shown && /お届け先: テスト割烹/.test(done.text) && /配送の温度: 冷蔵/.test(done.text), done.text);

    // 3. 自社あて
    await toConfirm(page);
    const reset = await page.evaluate(() => ({ ship: document.getElementById('c-shipto').value, temp: tempChosen() }));
    T('2. 次の注文では、お届け先と温度は選び直し（前のお店・冷蔵を引きずらない）', reset.ship === '' && reset.temp === '冷凍', JSON.stringify(reset));
    await page.selectOption('#c-shipto', '__self'); await page.waitForTimeout(100);
    const self = await page.evaluate(() => ({ addrShown: !document.getElementById('c-addr-box').classList.contains('hidden'), addr: document.getElementById('c-addr').innerText }));
    await page.click('#c-go'); await page.waitForTimeout(600);
    const sent2 = last(net, 'portal_place_order_v2');
    T('3. 「自社あて」は登録の住所を見せ、お届け先なし・冷凍で送る', self.addrShown && /登録のご住所|架空県架空市/.test(self.addr) && sent2.body.p_ship_to === null && sent2.body.p_temp === '冷凍', JSON.stringify([self, sent2.body.p_ship_to, sent2.body.p_temp]));

    // 4. 履歴
    await page.evaluate(() => openHistory()); await page.waitForTimeout(400);
    const hist = await page.evaluate(() => document.getElementById('hist-rows').innerText.replace(/\s+/g, ' '));
    T('4. 履歴に、お届け先のお店と冷蔵が出る', /お届け先: 架空ビストロ/.test(hist) && /冷蔵でお届け/.test(hist), hist.slice(0, 200));
    await page.evaluate(() => showScreen('list')); await page.waitForTimeout(150);
    T('9. 仲卸の画面: スマホの幅で横にはみ出さない', (await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth))) === 0);
    T('9. 仲卸の画面: ページエラーなし', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  // ── 普通のお客様 ──
  {
    const net = { name: '架空食堂', shipTo: { is_wholesaler: false, shops: [] } };
    const { ctx, page, errors } = await portal(browser, net);
    await toConfirm(page);
    const c = await page.evaluate(() => ({ badge: !!document.querySelector('#h-name .wsbadge'), box: document.getElementById('c-shipto-box').classList.contains('hidden'), addr: !document.getElementById('c-addr-box').classList.contains('hidden'), temps: [...document.querySelectorAll('input[name="c-temp"]')].map(r => r.value + (r.checked ? '*' : '')), memo: !!document.getElementById('c-memo'), h: document.querySelector('.tempsel label').getBoundingClientRect().height }));
    T('5. 普通のお客様に、仲卸の印・お届け先のお店の欄は出ない', !c.badge && c.box && c.addr, JSON.stringify(c));
    T('5. 冷凍・冷蔵を選べる（既定は冷凍・指で押せる大きさ）・備考を書ける', c.temps.join() === '冷凍*,冷蔵' && c.memo && c.h >= 44, JSON.stringify(c));
    await page.click('#c-go'); await page.waitForTimeout(600);
    const s1 = last(net, 'portal_place_order_v2');
    T('5. 何も選ばなければ冷凍・お届け先なしで送る', s1 && s1.body.p_temp === '冷凍' && s1.body.p_ship_to === null, JSON.stringify(s1 && s1.body).slice(0, 200));

    // 6. 関数が無い
    net.v2missing = true;
    await toConfirm(page);
    await page.check('input[name="c-temp"][value="冷蔵"]'); await page.fill('#c-memo', '裏口へ');
    await page.click('#c-go'); await page.waitForTimeout(700);
    const old = last(net, 'portal_place_order');
    const doneShown = await page.evaluate(() => !document.getElementById('scr-done').classList.contains('hidden'));
    T('6. 新しい関数が無いときは今までの関数で注文できる', old && doneShown, JSON.stringify(old && Object.keys(old.body)));
    T('6. 冷蔵は備考の先頭に【冷蔵希望】として伝わる（備考も残る）', old && /^【冷蔵希望】\n裏口へ$/.test(old.body.p_memo), old && old.body.p_memo);
    await toConfirm(page);
    await page.click('#c-go'); await page.waitForTimeout(700);
    const old2 = last(net, 'portal_place_order');
    T('6. 冷凍のときは備考に何も足さない', old2 && old2.body.p_memo === null, old2 && String(old2.body.p_memo));
    T('9. 普通の画面: ページエラーなし', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  // ── 7. 一覧を読めなかった ──
  {
    const net = { name: '架空仲卸', shipTo: 'fail' };
    const { ctx, page } = await portal(browser, net);
    await toConfirm(page);
    const f = await page.evaluate(() => { const e = document.getElementById('c-shipto-err'); return { shown: !e.classList.contains('hidden'), text: e.innerText, btn: !!e.querySelector('button') }; });
    T('7. お届け先の一覧を読めなかったら、確認の画面で知らせる', f.shown && /読み込めませんでした/.test(f.text) && /ご登録の住所あて/.test(f.text) && f.btn, JSON.stringify(f));
    net.shipTo = { is_wholesaler: true, shops: SHOPS };
    await page.click('#c-shipto-err button'); await page.waitForTimeout(500);
    const g = await page.evaluate(() => ({ err: document.getElementById('c-shipto-err').classList.contains('hidden'), box: !document.getElementById('c-shipto-box').classList.contains('hidden'), n: document.getElementById('c-shipto').options.length }));
    T('7. 読み直すと、お届け先のお店を選べるようになる', g.err && g.box && g.n === 5, JSON.stringify(g));
    await ctx.close();
    const net2 = { name: '架空食堂', shipTo: 'missing' };
    const o2 = await portal(browser, net2);
    await toConfirm(o2.page);
    const m = await o2.page.evaluate(() => ({ err: document.getElementById('c-shipto-err').classList.contains('hidden'), box: document.getElementById('c-shipto-box').classList.contains('hidden') }));
    T('7. 一覧の関数がまだ無い（404）ときは、知らせを出さず今までどおり', m.err && m.box, JSON.stringify(m));
    await o2.ctx.close();
  }

  // ── 8. お店側 ──
  {
    const ymd = off => { const d = new Date(); d.setDate(d.getDate() + off); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    const ORDERS = [
      { id: 'a', order_code: 'ORD-TEST-a', customer_id: 's2', customer_name: 'テスト割烹', delivery_name: 'テスト割烹', delivery_address: '', delivery_phone: '', status: '受注', channel: 'ポータル', delivery_date: ymd(2), temp_zone: '冷蔵', ordered_by_customer_id: 'w1', memo: '架空仲卸（仲卸からのご注文）\n午前着' },
      { id: 'b', order_code: 'ORD-TEST-b', customer_id: 'c9', customer_name: '架空食堂', delivery_name: '架空食堂', delivery_address: '架空県架空市1-1', delivery_phone: '000-0000-0000', status: '確認済', channel: 'ポータル', delivery_date: ymd(3), temp_zone: '冷凍', ordered_by_customer_id: 'c9' },
      { id: 'c', order_code: 'ORD-TEST-c', customer_id: 'c8', customer_name: '見本亭', delivery_address: '架空県見本市2-2', status: '確認済', channel: 'ポータル', delivery_date: ymd(4), memo: '【冷蔵希望】\n裏口へ' },
      { id: 'd', order_code: 'ORD-TEST-d', customer_id: 's9', customer_name: '住所なし店', delivery_address: '', status: '確認済', channel: 'ポータル', delivery_date: ymd(5), ordered_by_customer_id: 'w1' },
    ];
    const net = { failCust: false };
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); localStorage.setItem('tg_staff_key', 'TESTKEY'); } catch (e) {} window.alert = () => {}; window.confirm = () => true; window.prompt = () => null; window.open = () => null; window.__rej = []; window.addEventListener('unhandledrejection', e => window.__rej.push(String(e.reason && e.reason.message || e.reason))); });
    const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', rt => {
      const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
      if (url.startsWith('file:')) return rt.continue();
      const J = (x, s) => rt.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(x) });
      if (!/\/rest\/v1\//.test(url)) return rt.fulfill({ status: 200, contentType: 'text/plain', body: '' });
      const table = url.split('/rest/v1/')[1].split('?')[0];
      if (table === 'orders' && m === 'GET' && /status=in\.\(受注,確認済\)/.test(url)) return J(ORDERS);
      if (table === 'rpc/base_orders') return J({ orders: [] });
      if (table === 'customers' && /id=eq\.s2/.test(url)) return net.failCust ? J({ message: 'テスト用の通信失敗' }, 503) : J([{ name: 'テスト割烹', honorific: '御中', phone: '000-1111-2222', address: '千葉県架空市3-3', building: '架空ビル1F' }]);
      if (table === 'customers' && /id=eq\.s9/.test(url)) return J([{ name: '住所なし店', honorific: '様', phone: '', address: '', building: '' }]);
      return J(m === 'GET' ? [] : [{ id: 'x' }]);
    });
    await page.goto('file://' + path.resolve(__dirname, '../../index.html')); await page.waitForTimeout(900);
    await page.evaluate(() => document.querySelector('[data-tab="shipping"]').click()); await page.waitForTimeout(1200);
    const cards = await page.evaluate(() => [...document.querySelectorAll('.order-card[id^="order-"]')].map(c => ({ id: c.id.replace('order-', ''), cold: !!c.querySelector('[data-temp="冷蔵"]'), text: c.innerText.replace(/\s+/g, ' ') })));
    const by = id => cards.find(c => c.id === id) || {};
    T('8. 冷蔵の注文だけに「❄ 冷蔵で発送」の印（備考の【冷蔵希望】も拾う）', by('a').cold && !by('b').cold && by('c').cold && !by('d').cold, JSON.stringify(cards.map(c => [c.id, c.cold])));
    T('8. 仲卸が頼んだ注文と分かる（お店の名前・仲卸の名前・備考）', /テスト割烹/.test(by('a').text) && /仲卸からの注文/.test(by('a').text) && /架空仲卸/.test(by('a').text) && /午前着/.test(by('a').text) && !/仲卸からの注文/.test(by('b').text), by('a').text.slice(0, 160));
    const wb = async id => { await page.evaluate(() => document.querySelectorAll('#toasts .toast').forEach(e => e.remove())); await page.evaluate(i => waybillOpenFromOrder(i), id); await page.waitForTimeout(400); return page.evaluate(() => ({ address: document.getElementById('wb-address').value, building: document.getElementById('wb-building').value, phone: document.getElementById('wb-phone').value, name: document.getElementById('wb-name').value, cool: document.getElementById('wb-cool').value, open: document.getElementById('waybillModal').style.display === 'block', toast: [...document.querySelectorAll('#toasts .toast')].map(e => e.textContent).join(' / ') })); };
    let w = await wb('b');
    T('8. 住所のある注文の送り状は今までどおり（注文の住所・冷凍）', w.open && w.address === '架空県架空市1-1' && w.cool === '冷凍', JSON.stringify(w));
    w = await wb('a');
    T('8. 住所の無い注文の送り状は、顧客台帳から住所・建物・電話を引き、冷蔵にしておく', w.open && w.address === '千葉県架空市3-3' && w.building === '架空ビル1F' && w.phone === '000-1111-2222' && w.name === 'テスト割烹' && w.cool === '冷蔵', JSON.stringify(w));
    await page.evaluate(() => { document.getElementById('wb-cool').value = '冷凍'; });
    w = await wb('d');
    T('8. 台帳にも住所が無ければ、空のまま開いて知らせる', w.open && w.address === '' && /住所がありません/.test(w.toast), JSON.stringify(w));
    net.failCust = true;
    w = await wb('a');
    T('8. 台帳を読めなければ、空のまま開いて知らせる（別の住所を入れない）', w.open && w.address === '' && /読めませんでした/.test(w.toast), JSON.stringify(w));
    T('9. 業務アプリ: スマホの幅で横にはみ出さない', (await page.evaluate(() => { document.getElementById('waybillModal').style.display = 'none'; return Math.max(0, document.documentElement.scrollWidth - innerWidth); })) === 0);
    T('9. 業務アプリ: ページエラー・未処理の例外なし', errors.length === 0 && (await page.evaluate(() => window.__rej.length)) === 0, errors.concat(await page.evaluate(() => window.__rej)).join(' / '));
    await ctx.close();
  }

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 260) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
