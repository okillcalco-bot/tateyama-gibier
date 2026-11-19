// 通販（さとふる・まいぷれ・AWAWA）の注文: 出荷タブに載り、「出荷した」で加工品の棚の在庫から引く（2026-11-19 沖）
//
//   ここで測ること（注文・商品はすべて架空）
//     1. 未出荷の注文が出荷タブに載る（集荷日が今日までのものは目立たせる）。読み取れなかった注文は警告つきで載る
//     2. 在庫との対応がある注文: 「出荷した」で 注文の数 × 対応の数 だけ棚の在庫を引き、出荷の記録（product_movements）を残す
//        ・出荷済にするのは「未出荷のとき」だけ（status=eq.未出荷 の条件つき。二重に押しても二重に引かない）
//        ・売上の記録（orders）を作る。客名は通販の名前（届け先の個人名は入れない）
//     3. 別の端末で先に出荷済になっていたら、在庫を引かない
//     4. 対応が未設定の注文: 確かめてから出荷済にする（在庫は引かない）。対応は画面で決めて保存できる（前の対応は消さずに外した印）
//     5. 読み込みに失敗したら「0件」に見せず、知らせと「もう一度読み込む」を出す
//     6. スマホの幅で横にはみ出さない・ページエラーなし
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const today = (() => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
const ORDERS = [
  { id: 'o1', platform: 'まいぷれ', source_message_id: 'msgA', line_no: 1, item_code: '9000001', item_name: '架空2種セット', item_detail: '架空味付け肉 250g×1袋 / 架空ミンチ 210g×1袋', qty: 2, amount: null, pickup_date: today, tracking_nos: '500000000001,500000000002', status: '未出荷', note: null },
  { id: 'o2', platform: 'さとふる', source_message_id: 'msgB', line_no: 1, item_code: '9000002', item_name: '架空満足セット 計1kg', item_detail: null, qty: 1, amount: null, pickup_date: '2099-12-31', status: '未出荷', note: null },
  { id: 'o3', platform: 'AWAWA', source_message_id: 'msgC', line_no: 1, item_code: null, item_name: '（読み取れませんでした）', qty: 1, amount: null, pickup_date: null, status: '未出荷', note: '注文メールの形式が変わった可能性があります。Gmail の「架空」を確認してください' },
];
const MAPS = [
  { id: 'm1', platform: 'まいぷれ', item_code: '9000001', item_name: '架空2種セット', product_id: 'p1', qty: 1 },
  { id: 'm2', platform: 'まいぷれ', item_code: '9000001', item_name: '架空2種セット', product_id: 'p2', qty: 1 },
];

async function open(browser, net, opts) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 390, height: 844 }, hasTouch: true }, opts || {}));
  await ctx.addInitScript(() => {
    try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); localStorage.setItem('tg_staff_key', 'TESTKEY'); } catch (e) {}
    window.__dlg = []; window.alert = m => window.__dlg.push('alert:' + m); window.confirm = m => { window.__dlg.push('confirm:' + m); return true; }; window.prompt = () => '架空の理由'; window.open = () => null;
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
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    if (m !== 'GET') net.writes.push({ m, table, url, body });
    if (net.failLoad && m === 'GET' && /marketplace_/.test(table)) return J({ message: 'テスト用の通信失敗' }, 503);
    if (table === 'marketplace_orders' && m === 'GET') return J(net.orders.filter(o => o.status === '未出荷'));
    if (table === 'marketplace_orders' && m === 'PATCH') {
      const id = (url.match(/id=eq\.([^&]+)/) || [])[1];
      const o = net.orders.find(x => x.id === id);
      if (/status=eq\.未出荷/.test(url) && (!o || o.status !== '未出荷')) return J([]);
      if (o) Object.assign(o, body);
      return J(o ? [o] : []);
    }
    if (table === 'marketplace_item_map' && m === 'GET') return J(net.maps.filter(x => !x.deleted_at));
    if (table === 'marketplace_item_map' && m === 'PATCH') { const ids = ((url.match(/id=in\.\(([^)]+)\)/) || [])[1] || '').split(','); net.maps.forEach(x => { if (ids.includes(x.id)) x.deleted_at = body.deleted_at; }); return J([]); }
    if (table === 'marketplace_item_map' && m === 'POST') { (Array.isArray(body) ? body : [body]).forEach((r, i) => net.maps.push(Object.assign({ id: 'mn' + net.maps.length + i }, r))); return J([], 201); }
    if (table === 'products' && m === 'GET') { const idm = url.match(/[?&]id=eq\.([^&]+)/); return J(idm ? net.prods.filter(x => x.id === idm[1]) : net.prods); }
    if (table === 'products' && m === 'PATCH') { const id = (url.match(/id=eq\.([^&]+)/) || [])[1]; const p = net.prods.find(x => x.id === id); if (p) Object.assign(p, body); return J([p]); }
    if (table === 'orders' && m === 'POST') return J([{ id: 'new-order' }], 201);
    if (table === 'rpc/base_update_stock') return J({ item: {} });
    if (m !== 'GET') return J([{ id: 'x' }], 201);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(800);
  // 出荷タブを開く（実際に見える状態で測る）
  await page.evaluate(() => { const b = document.querySelector('[data-tab="shipping"]'); if (b) b.click(); });
  await page.waitForTimeout(500);
  return { ctx, page, errors };
}
const fresh = () => ({
  writes: [], failLoad: false,
  orders: JSON.parse(JSON.stringify(ORDERS)), maps: JSON.parse(JSON.stringify(MAPS)),
  prods: [{ id: 'p1', name: '架空味付け肉 250g', stock_qty: 10 }, { id: 'p2', name: '架空ミンチ 210g', stock_qty: 1 }, { id: 'p3', name: '架空スライス 300g', stock_qty: 8 }],
});

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

  {
    const net = fresh();
    const { ctx, page, errors } = await open(browser, net);
    await page.evaluate(() => mpLoad()); await page.waitForTimeout(400);
    const info = await page.evaluate(() => {
      const box = document.getElementById('mp-orders');
      box.scrollIntoView();
      const cards = [...box.querySelectorAll('[data-mp]')];
      const vis = box.getBoundingClientRect().height > 50;
      return { vis, n: cards.length, text: box.innerText, late: cards[0] && /今日まで/.test(cards[0].innerText), over: Math.max(0, document.documentElement.scrollWidth - innerWidth),
        alerts: [...box.querySelectorAll('[role=alert]')].map(e => e.innerText) };
    });
    T('1. 出荷タブに通販の注文が見えている', info.vis, info.vis);
    T('1. 未出荷の注文3件が載る', info.n === 3, info.n);
    T('1. 集荷日が今日の注文は「今日まで」と目立たせる', info.late, info.text.slice(0, 200));
    T('1. 対応がある注文は「在庫から」に棚の商品と数（注文2 × 対応1）', /架空味付け肉 250g ×2/.test(info.text) && /架空ミンチ 210g ×2/.test(info.text), info.text.slice(0, 400));
    T('1. 棚が足りないものは「足りない」と出す（ミンチ 棚1 < 2）', /架空ミンチ 210g ×2（棚 1） ⚠足りない/.test(info.text), info.text.slice(0, 400));
    T('1. 対応が未設定の注文はそう出す', /在庫との対応が未設定/.test(info.text));
    T('1. 読み取れなかった注文は警告つきで載る（黙って捨てない）', info.alerts.some(a => /形式が変わった/.test(a)), info.alerts.join(' / '));
    T('6. スマホの幅で横にはみ出さない', info.over === 0, info.over);

    // 2. 出荷（対応あり）
    net.writes.length = 0;
    await page.evaluate(() => mpShip('o1')); await page.waitForTimeout(800);
    const claim = net.writes.find(w => w.table === 'marketplace_orders' && w.m === 'PATCH');
    T('2. 出荷済にするのは未出荷のときだけ（条件つき）', claim && /status=eq\.未出荷/.test(claim.url) && claim.body.status === '出荷済', claim && claim.url);
    const mv = net.writes.filter(w => w.table === 'product_movements');
    T('2. 出荷の記録を対応の数だけ残す（各2袋）', mv.length === 2 && mv.every(w => w.body.qty === 2 && w.body.movement_type === '出荷' && /まいぷれ/.test(w.body.destination)), JSON.stringify(mv.map(w => w.body)));
    T('2. 棚の在庫を引く（味付け肉 10→8）', net.prods.find(p => p.id === 'p1').stock_qty === 8, net.prods.find(p => p.id === 'p1').stock_qty);
    T('2. 足りないものは0より下にしない（ミンチ 1→0）', net.prods.find(p => p.id === 'p2').stock_qty === 0, net.prods.find(p => p.id === 'p2').stock_qty);
    const ord = net.writes.find(w => w.table === 'orders' && w.m === 'POST');
    T('2. 売上の記録を作る（客名は通販の名前・個人名なし）', ord && ord.body.customer_name === 'まいぷれのご当地ギフト' && /^MP-MY-/.test(ord.body.order_code) && /伝票番号/.test(ord.body.notes || ''), JSON.stringify(ord && ord.body));
    T('2. 足りない棚があることを出荷前の確認で伝える', (await page.evaluate(() => window.__dlg.slice())).some(d => /足りないものがあります: 架空ミンチ 210g/.test(d)));

    // 3. 二重に押しても引かない
    net.writes.length = 0;
    await page.evaluate(() => { mpCache.orders.push({ id: 'o1', platform: 'まいぷれ', source_message_id: 'msgA', line_no: 1, item_code: '9000001', item_name: '架空2種セット', qty: 2, status: '未出荷' }); return mpShip('o1'); });
    await page.waitForTimeout(500);
    T('3. 別の端末で先に出荷済なら在庫を引かない', !net.writes.some(w => w.table === 'products' || w.table === 'product_movements'), JSON.stringify(net.writes.map(w => w.m + ' ' + w.table)));

    // 4. 対応が未設定 → 対応を決めて保存
    await page.evaluate(() => mpLoad()); await page.waitForTimeout(300);
    await page.evaluate(() => mpEditMap('o2')); await page.waitForTimeout(200);
    const dlgOver = await page.evaluate(() => { const d = document.querySelector('#mp-map-ov [role=dialog]'); const r = d.getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth }; });
    T('4. 対応の画面がスマホの幅に収まる', dlgOver.l >= 0 && dlgOver.r <= dlgOver.w, JSON.stringify(dlgOver));
    await page.evaluate(() => { const s = document.querySelector('#mp-map-rows select'); s.value = 'p3'; document.querySelector('#mp-map-rows input').value = '2'; mpAddMapRow(); const rows = document.querySelectorAll('#mp-map-rows .mp-map-row'); rows[1].querySelector('select').value = 'p1'; });
    net.writes.length = 0;
    await page.evaluate(() => mpSaveMap('o2')); await page.waitForTimeout(500);
    const post = net.writes.find(w => w.table === 'marketplace_item_map' && w.m === 'POST');
    T('4. 対応を保存（スライス×2・味付け肉×1）', post && post.body.length === 2 && post.body[0].product_id === 'p3' && post.body[0].qty === 2 && post.body[1].product_id === 'p1' && post.body[0].item_code === '9000002', JSON.stringify(post && post.body));
    // 対応を変える → 前のは外した印（消さない）
    await page.evaluate(() => mpEditMap('o2')); await page.waitForTimeout(200);
    await page.evaluate(() => { document.querySelectorAll('#mp-map-rows .mp-map-row')[1].remove(); });
    net.writes.length = 0;
    await page.evaluate(() => mpSaveMap('o2')); await page.waitForTimeout(500);
    T('4. 対応を変えると、前の対応は消さずに外した印を付ける', net.writes.some(w => w.table === 'marketplace_item_map' && w.m === 'PATCH' && w.body.deleted_at) && !net.writes.some(w => w.m === 'DELETE'), JSON.stringify(net.writes.map(w => w.m + ' ' + w.table)));
    // 未設定のまま出荷（o3 は対応なし）
    net.writes.length = 0;
    await page.evaluate(() => { window.__dlg.length = 0; return mpShip('o3'); }); await page.waitForTimeout(500);
    const d = await page.evaluate(() => window.__dlg.slice());
    T('4. 対応が未設定のときは「在庫は引かずに出荷済にしますか」と確かめる', d.some(x => /在庫は引かずに出荷済にしますか/.test(x)), d.join(' / ').slice(0, 200));
    T('4. 対応が未設定なら在庫は動かさない', !net.writes.some(w => w.table === 'products' || w.table === 'product_movements'));

    T('6. ページエラー・未処理の例外なし', errors.length === 0 && (await page.evaluate(() => window.__rej.length)) === 0, errors.join(' / '));
    await ctx.close();
  }

  // 5. 読み込みの失敗
  {
    const net = fresh(); net.failLoad = true;
    const { ctx, page } = await open(browser, net);
    await page.evaluate(() => mpLoad()); await page.waitForTimeout(400);
    const a = await page.evaluate(() => { const el = document.querySelector('#mp-orders [role=alert]'); return el ? el.innerText : ''; });
    T('5. 読み込みに失敗したら「0件とは限らない」と出す', /読み込めませんでした/.test(a) && /0件」とは限りません/.test(a) && /もう一度読み込む/.test(a), a);
    net.failLoad = false;
    await page.click('#mp-orders [role=alert] button'); await page.waitForTimeout(400);
    T('5. 「もう一度読み込む」で読み直せる', (await page.evaluate(() => document.querySelectorAll('#mp-orders [data-mp]').length)) === 3);
    await ctx.close();
  }

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
