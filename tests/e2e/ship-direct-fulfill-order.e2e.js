// 出荷画面: 出荷先に未出荷の注文があれば、スキャンした現物でその注文を納品済みにする（2026-10-06）
//
//   きっかけ
//     注文の行ごとにパックを割り当てる仕組みは、注文の品名（「キョン（一頭分・ご希望）」「猪赤つなぎセット」など）が
//     在庫の部位名と合わず候補が出ないため使われていなかった。8/1以降の注文11件のうち3件（晴れと褻・植山・
//     ジビエファクトリー）は注文を残したまま別の「注文なし出荷」で送り、注文が残って二重請求の危険があった。
//
//   ここで測ること
//     1. 出荷先を入れると、そのお客さんの未出荷の注文が出て、最初からチェックが入っている
//     2. チェックしたまま確定すると、新しい注文は作らず、その注文にスキャンした現物が実際の重さで入る
//     3. 注文の依頼行（未割当）は0円・0kgの「依頼内容」になり、依頼の中身は price_source に残る
//     4. スキャンしなかった引当済パックの行も0円にし、そのパックを在庫に戻す（箱に入っていない現物）
//     5. スキャンしたパックがすでに付いている行はそのまま（同じパックを二重に入れない）
//     6. 注文は発送済・合計は明細の合計・出荷はその注文に付く
//     7. チェックを外して確定しようとすると「二重請求のおそれ」を聞く（いいえなら何も書かない）
//     8. 注文が読めないときは赤字で出す（黙って空にしない）
//     9. 請求書の明細に、重さも金額も0の行（依頼内容）を載せない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9134);
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const out = []; const ck = (n, c, e) => out.push([n, !!c, e == null ? '' : String(e)]);
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));

  // DBのかわり
  const ORDER = { id: 'ord-u', order_code: 'ORD-UE', order_date: '2026-09-22', status: '受注', customer_id: 'cust-u', notes: null, memo: null };
  let items = [
    { id: 'oi-1', order_id: 'ord-u', part_name: 'キョン（一頭分・ご希望）', weight_kg: 2, requested_kg: 2, inventory_id: null, subtotal: 6000 },
    { id: 'oi-2', order_id: 'ord-u', part_name: 'カタ', weight_kg: 0.8, requested_kg: null, inventory_id: 'inv-pre', subtotal: 1760 },
    { id: 'oi-3', order_id: 'ord-u', part_name: 'カタ', weight_kg: 1.0, requested_kg: null, inventory_id: 'inv-a', subtotal: 2200 },
  ];
  const log = { orderPost: [], itemPost: [], itemPatch: [], orderPatch: [], ship: [], inv: [] };
  let ordersFail = false, openOrders = true;
  await p.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = (x, st) => rt.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(x) });
    const body = () => JSON.parse(req.postData() || '{}');
    if (/\/rpc\/staff_lookup_customer_id/.test(url)) return J('cust-u');
    if (m === 'GET' && /\/customers/.test(url)) return J([{ id: 'cust-u', price_rank: 'standard', notes: '' }]);
    if (m === 'GET' && /\/price_master/.test(url)) return J([{ species: 'イノシシ', part_name: 'カタ', grade: '並', price_standard: 2200 }]);
    if (/\/orders/.test(url)) {
      if (m === 'GET') {
        if (ordersFail) return J({ message: 'boom' }, 500);
        if (!openOrders) return J([]);
        return J([{ ...ORDER, order_items: items.map(i => ({ ...i })) }]);
      }
      if (m === 'POST') { const bd = body(); log.orderPost.push(bd); return J([{ id: 'new-ord', ...bd }], 201); }
      if (m === 'PATCH') { log.orderPatch.push({ url, body: body() }); if (/id=eq\.ord-u/.test(url)) Object.assign(ORDER, body()); return J([]); }
    }
    if (/\/order_items/.test(url)) {
      if (m === 'GET') return J(items.filter(i => url.includes('order_id=eq.' + i.order_id)).map(i => ({ ...i })));
      if (m === 'PATCH') { const id = url.match(/id=eq\.([^&]+)/)[1]; const bd = body(); log.itemPatch.push([id, bd]); items = items.map(i => i.id === id ? { ...i, ...bd } : i); return J([]); }
      if (m === 'POST') { const bd = body(); const arr = Array.isArray(bd) ? bd : [bd]; log.itemPost.push(...arr); arr.forEach((x, k) => items.push({ id: 'n' + k, ...x })); return J([], 201); }
    }
    if (/\/shipments/.test(url) && m === 'POST') { log.ship.push(body()); return J([{ id: 'sh' }], 201); }
    if (/\/inventory/.test(url) && m === 'PATCH') { log.inv.push({ url, body: body() }); return J([]); }
    return J([]);
  });
  await p.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));
  await p.goto('http://localhost:9134/index.html'); await p.waitForTimeout(700);
  await p.evaluate(() => { window.__toasts = []; window.toast = (msg, type) => window.__toasts.push({ msg, type }); });

  // 1. 出荷先を入れると未出荷の注文が出る
  await p.evaluate(() => { const el = document.getElementById('ship-direct-cust'); el.value = '植山'; });
  await p.evaluate(() => shipOpenOrdersLoad()); await p.waitForTimeout(300);
  const panel = await p.$eval('#ship-direct-openorders', el => el.innerText.replace(/\s+/g, ' '));
  const checked = await p.$eval('#ship-direct-openorders input[type=checkbox]', el => el.checked).catch(() => null);
  ck('出荷先を入れると未出荷の注文が出て、最初からチェックが入っている', /未出荷の注文 1件/.test(panel) && /ORD-UE/.test(panel) && /キョン（一頭分・ご希望） 2kg/.test(panel) && checked === true, panel.slice(0, 160));

  // 7. チェックを外して確定 → 二重の確認（いいえ）→ 何も書かない
  await p.evaluate(() => {
    shipDirectItems = [
      { id: 'inv-a', ident_code: 'TGC-08-T001-KT', part_name: 'カタ', weight: 1.0, species: 'イノシシ', grade: '並', _via: 'scan' },
      { id: 'inv-b', ident_code: 'TGC-08-T002-KT', part_name: 'カタ', weight: 0.5, species: 'イノシシ', grade: '並', _via: 'scan' }];
    shipDirectRender();
  });
  await p.evaluate(() => { document.querySelector('#ship-direct-openorders input[type=checkbox]').click(); });
  let msgs = [];
  const onDlg = async d => { msgs.push(d.message()); await d.dismiss(); };
  p.on('dialog', onDlg);
  await p.evaluate(() => shipDirectConfirm()); await p.waitForTimeout(400);
  p.off('dialog', onDlg);
  ck('チェックを外すと「二重請求のおそれ」を聞き、いいえなら何も書かない', /未出荷の注文が 1件/.test(msgs[0] || '') && /二重請求/.test(msgs[0] || '') && !log.orderPost.length && !log.itemPost.length && !log.ship.length, (msgs[0] || '').replace(/\n/g, ' / ').slice(0, 160));

  // 2〜6. チェックを入れて確定
  await p.evaluate(() => { document.querySelector('#ship-direct-openorders input[type=checkbox]').click(); });
  msgs = [];
  const onDlg2 = async d => { msgs.push(d.message()); await d.accept(); };
  p.on('dialog', onDlg2);
  await p.evaluate(() => shipDirectConfirm()); await p.waitForTimeout(800);
  p.off('dialog', onDlg2);
  ck('確認画面は「注文 ORD-UE の出荷として確定しますか」', /注文 ORD-UE の出荷として確定/.test(msgs[0] || ''), (msgs[0] || '').split('\n')[0]);
  ck('新しい注文は作らない', log.orderPost.length === 0, log.orderPost.length);
  const i1 = items.find(i => i.id === 'oi-1'), i2 = items.find(i => i.id === 'oi-2'), i3 = items.find(i => i.id === 'oi-3');
  ck('依頼行は0円・0kgの「依頼内容」になり、依頼の中身を残す', +i1.subtotal === 0 && +i1.weight_kg === 0 && +i1.requested_kg === 0 && /依頼内容/.test(i1.price_source) && /キョン（一頭分・ご希望） 2kg/.test(i1.price_source), JSON.stringify(i1));
  const back = log.inv.find(x => /id=eq\.inv-pre/.test(x.url));
  ck('スキャンしなかった引当済パックの行は0円にし、パックを在庫に戻す', +i2.subtotal === 0 && i2.inventory_id === null && back && back.body.status === '在庫' && /status=eq\.引当済/.test(back.url), JSON.stringify(back));
  ck('スキャン済みパックが付いている行はそのまま、追加はスキャンした残り1点だけ', +i3.subtotal === 2200 && i3.inventory_id === 'inv-a' && log.itemPost.length === 1 && log.itemPost[0].inventory_id === 'inv-b' && log.itemPost[0].order_id === 'ord-u' && +log.itemPost[0].subtotal === 1100 && log.itemPost[0].pick_method === 'scan', JSON.stringify(log.itemPost));
  const op = log.orderPatch.find(x => /id=eq\.ord-u/.test(x.url));
  ck('注文は発送済・合計は明細の合計（2,200+1,100）', op && op.body.status === '発送済' && op.body.total_amount === 3300 && /出荷画面で納品/.test(op.body.notes || ''), JSON.stringify(op && op.body));
  ck('出荷はその注文に付き、スキャンした2点が出荷済になる', log.ship.length === 1 && log.ship[0].order_id === 'ord-u' && ['inv-a', 'inv-b'].every(id => log.inv.some(x => x.url.includes('id=eq.' + id) && x.body.status === '出荷済')), JSON.stringify(log.ship));
  ck('確定後はパネルが消える', (await p.$eval('#ship-direct-openorders', el => el.innerHTML)) === '', '');

  // 8. 読めないときは赤字
  ordersFail = true;
  await p.evaluate(() => { document.getElementById('ship-direct-cust').value = '植山'; return shipOpenOrdersLoad(); }); await p.waitForTimeout(300);
  ck('注文が読めないときは赤字で理由を出す', /確認できませんでした/.test(await p.$eval('#ship-direct-openorders', el => el.innerText)), '');
  ordersFail = false; openOrders = false;
  await p.evaluate(() => shipOpenOrdersLoad()); await p.waitForTimeout(300);
  ck('未出荷の注文が無ければ何も出さない', (await p.$eval('#ship-direct-openorders', el => el.innerHTML)) === '', '');
  ck('pageerror なし（出荷画面）', errs.length === 0, errs.join(' / '));

  // 9. 請求書の明細に0行を載せない
  const p2 = await b.newPage(); const errs2 = []; p2.on('pageerror', e => errs2.push(String(e)));
  await p2.route('**/rest/v1/**', rt => rt.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p2.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));
  await p2.goto('http://localhost:9134/order-admin.html'); await p2.waitForTimeout(700);
  const lines = await p2.evaluate(() => consolidateItemsForBilling([
    { species: 'イノシシ', part_name: 'カタ', weight_kg: 1.0, unit_price: 2200, subtotal: 2200 },
    { species: 'キョン', part_name: 'キョン（一頭分・ご希望）', weight_kg: 0, requested_kg: 0, unit_price: 3000, subtotal: 0 },
    { species: 'イノシシ', part_name: '毛皮', weight_kg: null, unit_price: 500, subtotal: 2000 }]));
  ck('請求書の明細に重さも金額も0の行を載せない（毛皮など重さの無い有料行は残す）', lines.length === 2 && !lines.some(l => /キョン/.test(l.part_name || '')) && lines.some(l => l.unit === '枚' && l.qty === 4), JSON.stringify(lines));
  ck('pageerror なし（受発注管理）', errs2.length === 0, errs2.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of out) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${out.length} passed`);
  await b.close(); srv.close();
  process.exit(pass === out.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
