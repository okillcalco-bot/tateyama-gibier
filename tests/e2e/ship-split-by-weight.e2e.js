// 出荷処理: 重量で頼まれた行に複数パックを割り当てる（2026-10-06）
//
//   きっかけ
//     ジビエファクトリー「モモ 25kg」に1パック（T333-MOS 0.66kg）を割り当てたら行が割当済になり、
//     重量が足りないのに次のパックが登録できなくなった（1行＝1パックの作りだったため）。
//
//   ここで測ること
//     1. 必要重量よりパックが軽ければ、行を「このパック（実重量×単価）」と「残り（未割当）」に分ける
//     2. 残りの行にさらにパックを当てると、また分かれる。足りた（残り0.05kg未満）ら分けずに実重量で確定
//     3. 重量の無い行（本数など）は今までどおり1行1パック（分けない）
//     4. 注文の合計金額を明細の合計に合わせる
//     5. 画面: 割当済の重さ／必要重量・「残り」・割当したパックの番号を出す。ドロップダウンにはサブ部位も出る
//     6. 在庫が足りず残りだけが未割当なら、確認のうえ残りを0kg・0円にして出荷確定へ進める
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9132);
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const out = []; const ck = (n, c, e) => out.push([n, !!c, e == null ? '' : String(e)]);
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));

  // DBのかわり
  const ORDER = { id: 'o1', order_code: 'ORD-GF', customer_name: 'ジビエファクトリー', status: '確認済', channel: 'Messenger', delivery_date: null };
  let items = [
    { id: 'i-kata', order_id: 'o1', species: 'イノシシ', part_name: 'カタ', weight: 25, weight_kg: 25, requested_kg: 25, unit_price: 2200, subtotal: 55000, inventory_id: null, grade_snapshot: '並', price_rank_applied: 'standard', price_source: 'price_master' },
    { id: 'i-momo', order_id: 'o1', species: 'イノシシ', part_name: 'モモ', weight: 25, weight_kg: 25, requested_kg: 25, unit_price: 2600, subtotal: 65000, inventory_id: null, grade_snapshot: '並' },
    { id: 'i-toma', order_id: 'o1', species: 'イノシシ', part_name: 'トマホーク', weight: null, weight_kg: null, requested_kg: null, unit_price: null, subtotal: 0, inventory_id: null },
  ];
  const INV = [
    { id: 'p1', ident_code: 'TGC-08-T333-MOS', part_name: 'モモ（シンタマ）', weight: 0.66, weight_kg: 0.66, individual_id: 'TGC-08-T333' },
    { id: 'p2', ident_code: 'TGC-08-T340-MO', part_name: 'モモ', weight: 1.2, weight_kg: 1.2, individual_id: 'TGC-08-T340' },
    { id: 'p3', ident_code: 'TGC-08-T341-TH', part_name: 'トマホーク', weight: 0.8, weight_kg: 0.8, individual_id: 'TGC-08-T341' },
  ];
  let seq = 0; const log = [];
  await p.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = (x, st) => rt.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(x) });
    const body = () => JSON.parse(req.postData() || '{}');
    if (/\/order_items/.test(url)) {
      if (m === 'GET') {
        if (/order_id=eq\.o1/.test(url)) return J(items.map(i => ({ ...i })));
        return J([]);
      }
      if (m === 'PATCH') { const id = url.match(/id=eq\.([^&]+)/)[1]; const bd = body(); log.push(['PATCH', id, bd]); items = items.map(i => i.id === id ? { ...i, ...bd } : i); return J([]); }
      if (m === 'POST') { const bd = body(); const row = { id: 'n' + (++seq), ...bd }; log.push(['POST', row.id, bd]); items.push(row); return J([row], 201); }
    }
    if (/\/orders/.test(url)) {
      if (m === 'GET') return J([ORDER]);
      if (m === 'PATCH') { const bd = body(); log.push(['ORDER', 'o1', bd]); Object.assign(ORDER, bd); return J([]); }
    }
    if (/\/inventory/.test(url) && m === 'GET') {
      const ids = (url.match(/id=in\.\(([^)]+)\)/) || [])[1];
      if (ids) return J(INV.filter(x => ids.split(',').includes(x.id)).map(x => ({ id: x.id, ident_code: x.ident_code })));
      return J(INV);
    }
    if (/\/individuals/.test(url)) return J(INV.map(x => ({ label_id: x.individual_id, species: 'イノシシ' })));
    return J([]);
  });
  await p.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));
  await p.goto('http://localhost:9132/index.html'); await p.waitForTimeout(700);
  await p.evaluate(() => { window.__toasts = []; window.toast = (msg, type) => window.__toasts.push({ msg, type }); });

  const mom = () => items.filter(i => i.part_name === 'モモ');
  // 1. 0.66kg を 25kg の行に
  let r = await p.evaluate(([it, inv]) => shipAssignPackToItem('o1', it, inv, 'scan'), [items[1], INV[0]]);
  ck('25kgの行に0.66kgを当てると、残り24.34kgの未割当行ができる', r.remaining === 24.34 && mom().length === 2
    && mom().some(i => i.inventory_id === 'p1' && i.weight_kg === 0.66 && i.subtotal === 1716)
    && mom().some(i => !i.inventory_id && i.requested_kg === 24.34 && i.subtotal === 63284), JSON.stringify(mom()));
  ck('分けた残りの行は 単価・部位・等級 を引き継ぐ', mom().find(i => !i.inventory_id)?.unit_price === 2600 && mom().find(i => !i.inventory_id)?.grade_snapshot === '並', '');
  ck('注文の合計を明細の合計に合わせる（55,000+1,716+63,284）', ORDER.total_amount === 120000, ORDER.total_amount);

  // 2. 残りの行にさらに1.2kg → 残り23.14
  const rest = mom().find(i => !i.inventory_id);
  r = await p.evaluate(([it, inv]) => shipAssignPackToItem('o1', it, inv, 'scan'), [rest, INV[1]]);
  ck('残りの行にさらに1.2kg → 残り23.14kg（行は3つに）', r.remaining === 23.14 && mom().length === 3, JSON.stringify(mom().map(i => [i.inventory_id, i.requested_kg])));
  // 足りる場合: 必要0.7に0.66 → 残り0.04は分けない
  const small = { id: 'i-small', order_id: 'o1', species: 'イノシシ', part_name: 'ヒレ', weight: 0.7, weight_kg: 0.7, requested_kg: 0.7, unit_price: 3800, subtotal: 2660, inventory_id: null };
  items.push(small);
  r = await p.evaluate(([it, inv]) => shipAssignPackToItem('o1', it, inv, 'scan'), [small, { id: 'p9', weight: 0.66, weight_kg: 0.66 }]);
  const sm = items.filter(i => i.part_name === 'ヒレ');
  ck('残りが0.05kg未満なら分けず、実重量（0.66kg×単価）で確定', r.remaining === 0 && sm.length === 1 && sm[0].weight_kg === 0.66 && sm[0].subtotal === 2508, JSON.stringify(sm));
  items = items.filter(i => i.id !== 'i-small');

  // 3. 重量の無い行は分けない
  r = await p.evaluate(([it, inv]) => shipAssignPackToItem('o1', it, inv, 'scan'), [items[2], INV[2]]);
  const tm = items.filter(i => i.part_name === 'トマホーク');
  ck('重量の無い行（トマホーク）は1行1パックのまま', r.remaining === 0 && tm.length === 1 && tm[0].inventory_id === 'p3', JSON.stringify(tm));

  // 5. 画面
  await p.evaluate(() => loadShipping()); await p.waitForTimeout(600);
  const card = await p.$eval('#order-o1', el => el.innerText.replace(/\s+/g, ' '));
  ck('画面: 割当済の重さ／必要重量・「残り」・割当したパック番号を出す', /割当済 1\.86kg/.test(card) && /残り/.test(card) && /TGC-08-T333-MOS/.test(card), card.slice(0, 300));
  const opts = await p.$$eval('#order-o1 select.assign-select', ss => ss.map(s => [s.dataset.part, [...s.options].map(o => o.textContent).join('|')]));
  ck('ドロップダウン: モモの行に モモ（シンタマ）等のサブ部位も出る', opts.some(([part, o]) => part === 'モモ' && /TGC-08-T333-MOS|TGC-08-T340-MO/.test(o)), JSON.stringify(opts));

  // 6. 在庫不足: カタを1パック当ててから、残り（カタ・モモ）だけ未割当で出荷確定
  r = await p.evaluate(([it, inv]) => shipAssignPackToItem('o1', it, inv, 'scan'), [items[0], { id: 'k1', weight: 1.0, weight_kg: 1.0 }]);
  await p.evaluate(() => loadShipping()); await p.waitForTimeout(600);
  let asked = '', nDlg = 0;
  p.on('dialog', async d => { nDlg++; if (nDlg === 1) { asked = d.message(); await d.accept(); } else await d.dismiss(); });   // 2回目（出荷確定の最終確認）は閉じる
  await p.evaluate(() => shipOrder('o1')); await p.waitForTimeout(800);
  const zeroed = items.filter(i => !i.inventory_id);
  ck('残りだけ未割当なら「残りは出さずに確定しますか」と聞く', /残りは出さずに/.test(asked) && /カタ 残り 24\.00kg/.test(asked) && /モモ 残り 23\.14kg/.test(asked), asked.replace(/\n/g, ' / '));
  ck('はいで残りの行を0kg・0円にする', zeroed.length === 2 && zeroed.every(i => +i.requested_kg === 0 && +i.subtotal === 0), JSON.stringify(zeroed.map(i => [i.part_name, i.requested_kg, i.subtotal])));
  const card2 = await p.$eval('#order-o1', el => el.innerText.replace(/\s+/g, ' '));
  ck('0kgにした残りは「不足分・出さない」と出て、選択欄は無い', /不足分・出さない/.test(card2) && (await p.$$('#order-o1 select.assign-select')).length === 0, card2.slice(0, 200));
  ck('pageerror なし', errs.length === 0, errs.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of out) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 260) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${out.length} passed`);
  await b.close(); srv.close();
  process.exit(pass === out.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
