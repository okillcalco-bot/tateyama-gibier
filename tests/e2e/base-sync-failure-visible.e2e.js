// BASE（ネットショップ）への反映に失敗したら画面に出す（2026-11-10 全画面の見直し）
//
//   きっかけ（書き込みの失敗を捨てている所を機械で拾って、1つずつ読んだ）
//     ・在庫数の反映（base_update_stock）: 成功のときだけ「BASEの在庫も更新」と出て、失敗は console だけだった。
//       BASE側の数が古いまま＝無い在庫がネットで売れるおそれがあるのに、画面では分からなかった
//     ・発送済みの反映（base_dispatch）: 結果を見ず、例外も捨てていた。BASEでは未発送のまま＝お客様に発送の知らせが届かない
//     ・出店・納品先の在庫ページ（outlet.html）も同じ（結果を見ず、例外も捨てていた）
//     どれも BASE の関数は「失敗」を例外ではなく { error: ... } で返すので、結果を見ないと失敗に気づけない。
//
//   ここで測ること（商品・注文は架空）
//     1. 業務アプリ: 在庫の反映に失敗（接続切れ・BASEのエラー・通信）→ 知らせを出す。すぐ消えない（4秒後も出ている）
//     2. 業務アプリ: 成功のときは今までどおり（知らせは出さない）
//     3. 業務アプリ: BASE注文の発送処理で、BASE側を発送済みにできなかった品目を出す。こちらの出荷記録は作る
//     4. 出店ページ: 在庫の手直し・完成の記録で、BASEに反映できなかった商品を出す。こちらの記録は作る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

async function open(browser, file, net) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); localStorage.setItem('tg_staff_key', 'TESTKEY'); } catch (e) {}
    window.__dlg = []; window.alert = m => window.__dlg.push('alert:' + m); window.confirm = () => true; window.prompt = () => '7'; window.open = () => null;
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
    if (m !== 'GET') net.writes.push(m + ' ' + table);
    if (table === 'rpc/base_update_stock') { if (net.stock === 'throw') return J({ message: 'テスト用の通信失敗' }, 503); return J(net.stock || { item: { item_id: 1 } }); }
    if (table === 'rpc/base_dispatch') { if (net.dispatch === 'throw') return J({ message: 'テスト用の通信失敗' }, 503); return J(net.dispatch || { order: {} }); }
    if (table === 'products' && m === 'GET') { const all = [{ id: 'p1', name: '架空ジャーキー', unit: '袋', stock_qty: 5, price: 800, base_item_id: '111' }, { id: 'p2', name: '架空ソーセージ', unit: '本', stock_qty: 9, price: 600, base_item_id: null }]; const idm = url.match(/[?&]id=eq\.([^&]+)/); return J(idm ? all.filter(x => x.id === idm[1]) : all); }
    if (table === 'retail_outlets') return J([{ id: 'ro1', name: '架空直売所', delivery_notes: '' }]);
    if (table === 'orders' && m === 'POST') return J([{ id: 'new-order' }], 201);
    if (m !== 'GET') return J([{ id: 'x' }], 201);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../' + file));
  await page.waitForTimeout(800);
  return { ctx, page, errors };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

  // ── 業務アプリ（index.html） ──
  {
    const net = { writes: [], stock: null, dispatch: null };
    const { ctx, page, errors } = await open(browser, 'index.html', net);
    const warns = () => page.evaluate(() => [...document.querySelectorAll('#toasts [role=alert]')].map(e => e.textContent));
    const toasts = () => page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map(e => e.textContent));
    const clear = () => page.evaluate(() => { document.querySelectorAll('#toasts .toast').forEach(e => e.remove()); });

    // 1. 接続切れ
    net.stock = { error: 'not_connected' };
    await page.evaluate(() => baseSyncStock('p1', 3)); await page.waitForTimeout(300);
    let w = await warns();
    T('1. 接続切れ: 在庫を更新できなかったことを出す（商品名・数・つなぎ直しの案内）', w.length === 1 && /在庫数を更新できませんでした/.test(w[0]) && /架空ジャーキー → 3/.test(w[0]) && /接続が切れています/.test(w[0]) && /BASE連携でつなぎ直/.test(w[0]), w.join(' / '));
    await page.waitForTimeout(4300);
    w = await warns();
    T('1. 知らせはすぐ消えない（4秒後も出ている）', w.length === 1, w.length);
    await clear();
    // 1. BASEのエラー
    net.stock = { error: 'invalid_request', error_description: '在庫数が不正です' };
    await page.evaluate(() => baseSyncStock('p1', 3)); await page.waitForTimeout(300);
    w = await warns();
    T('1. BASEのエラー: 理由をそのまま出す', w.length === 1 && /在庫数が不正です/.test(w[0]) && /BASEの管理画面で確かめて/.test(w[0]), w.join(' / '));
    await clear();
    // 1. 通信
    net.stock = 'throw';
    await page.evaluate(() => baseSyncStock('p1', 3)); await page.waitForTimeout(300);
    w = await warns();
    T('1. 通信の失敗: 黙らない', w.length === 1 && /更新できませんでした（通信）/.test(w[0]), w.join(' / '));
    await clear();
    // 2. 成功・対象外
    net.stock = null;
    await page.evaluate(() => baseSyncStock('p1', 3)); await page.waitForTimeout(300);
    w = await warns(); let t = await toasts();
    T('2. 成功: 知らせは出さず、今までどおり「BASEの在庫も更新」', w.length === 0 && t.some(x => /BASEの在庫も更新: 架空ジャーキー → 3/.test(x)), t.join(' / '));
    await clear();
    await page.evaluate(() => baseSyncStock('p2', 3)); await page.waitForTimeout(300);
    w = await warns(); t = await toasts();
    T('2. BASEと対応付けていない商品: 何も出さない', w.length === 0 && t.length === 0, w.concat(t).join(' / '));

    // 3. BASE注文の発送処理
    const ship = async (dispatch) => {
      net.dispatch = dispatch; net.writes.length = 0; await clear();
      await page.evaluate(() => {
        baseOrderCache['K1'] = { unique_key: 'K1', last_name: '架空', first_name: '太郎', ordered: 1794300000, total: 1600,
          order_items: [{ order_item_id: 9001, item_id: 111, title: '架空ジャーキー', amount: 1, price: 800, status: 'ordered' }, { order_item_id: 9002, item_id: 222, title: '架空セット', amount: 1, price: 800, status: 'ordered' }] };
        window.loadBaseOrders = async () => {};
        return baseOrderShip('K1');
      });
      await page.waitForTimeout(400);
      return { w: await warns(), t: await toasts(), writes: net.writes.slice() };
    };
    let s = await ship({ error: 'access_denied', error_description: '権限がありません' });
    T('3. 発送済みにできなかった品目を出す（品目名・理由・BASEで直す案内）', s.w.some(x => /BASE側を「発送済み」にできませんでした/.test(x) && /架空ジャーキー（権限がありません）/.test(x) && /架空セット（権限がありません）/.test(x) && /BASEの管理画面で発送済みに/.test(x)), s.w.join(' / '));
    T('3. こちらの出荷記録は作る（注文・出荷）', s.writes.includes('POST orders') && s.writes.includes('POST shipments'), s.writes.join(','));
    s = await ship('throw');
    T('3. 通信の失敗でも黙らない', s.w.some(x => /発送済み」にできませんでした/.test(x) && /架空ジャーキー（通信）/.test(x)), s.w.join(' / '));
    s = await ship(null);
    T('3. 成功: 発送済みの知らせは出さない', !s.w.some(x => /発送済み/.test(x)) && s.t.some(x => /発送処理が完了しました（2品目）/.test(x)), s.w.concat(s.t).join(' / '));
    const rej = await page.evaluate(() => window.__rej.slice());
    T('業務アプリ: ページエラー・未処理の例外なし', errors.length === 0 && rej.length === 0, errors.concat(rej).join(' / '));
    await ctx.close();
  }

  // ── 出店・納品先の在庫（outlet.html） ──
  {
    const net = { writes: [], stock: { error: 'not_connected' }, dispatch: null };
    const { ctx, page, errors } = await open(browser, 'outlet.html', net);
    await page.evaluate(() => pick('__center__')); await page.waitForTimeout(300);
    // 4. 在庫の手直し（prompt は 7 を返す）
    await page.evaluate(() => { window.__dlg.length = 0; return stockEdit('p1', null); }); await page.waitForTimeout(400);
    let d = await page.evaluate(() => window.__dlg.slice());
    T('4. 手直し: BASEに反映できなかったことを出す（商品名・数・理由）', d.some(x => /BASE（ネットショップ）の在庫数を更新できませんでした/.test(x) && /架空ジャーキー → 7（BASEとの接続が切れています）/.test(x)), d.join(' / '));
    T('4. 手直し: こちらの記録は作る（増減の記録・在庫数）', net.writes.includes('POST product_movements') && net.writes.includes('PATCH products'), net.writes.join(','));
    net.stock = 'throw'; net.writes.length = 0;
    await page.evaluate(() => { window.__dlg.length = 0; products.find(p => p.id === 'p1').stock_qty = 5; return stockEdit('p1', null); }); await page.waitForTimeout(400);
    d = await page.evaluate(() => window.__dlg.slice());
    T('4. 手直し: 通信の失敗でも黙らない', d.some(x => /更新できませんでした/.test(x) && /架空ジャーキー → 7（通信）/.test(x)), d.join(' / '));
    net.stock = null;
    await page.evaluate(() => { window.__dlg.length = 0; products.find(p => p.id === 'p1').stock_qty = 5; return stockEdit('p1', null); }); await page.waitForTimeout(400);
    d = await page.evaluate(() => window.__dlg.slice());
    T('4. 手直し: 成功のときは何も出さない', d.length === 0, d.join(' / '));
    // 4. 完成の記録（まとめて）
    net.stock = { error: 'invalid_request', error_description: '在庫数が不正です' }; net.writes.length = 0;
    const saved = await page.evaluate(async () => {
      window.__dlg.length = 0;
      await openForm('完成');
      const q = [...document.querySelectorAll('.f-qty')]; if (!q.length) return 'no-form';
      q.forEach(el => { el.value = '2'; });
      const st = document.getElementById('f-staff'); if (st && !st.value) { const o = document.createElement('option'); o.value = '架空 太郎'; o.textContent = '架空 太郎'; st.appendChild(o); st.value = '架空 太郎'; }
      await saveForm(); return 'ok';
    });
    await page.waitForTimeout(400);
    d = await page.evaluate(() => window.__dlg.slice());
    T('4. 完成の記録: BASEに反映できなかった商品だけを出す（対応付けの無い商品は出さない）', saved === 'ok' && d.some(x => /更新できませんでした/.test(x) && /架空ジャーキー → 7（在庫数が不正です）/.test(x) && !/架空ソーセージ/.test(x)), saved + ' ' + d.join(' / '));
    T('4. 完成の記録: こちらの記録は作る', net.writes.includes('POST product_movements') && net.writes.filter(x => x === 'PATCH products').length === 2, net.writes.join(','));
    const rej = await page.evaluate(() => window.__rej.slice());
    T('出店ページ: ページエラー・未処理の例外なし', errors.length === 0 && rej.length === 0, errors.concat(rej).join(' / '));
    await ctx.close();
  }

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 260) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
