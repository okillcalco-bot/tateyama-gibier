// 直販出荷（recordDirectShipment）: 送料しか乗らない0円請求書になっていた問題の修正
//
//   きっかけ（2026-09-10）
//     「請求書発行しようとしたら、価格の設定している顧客もゼロになってる」との指摘。
//     実測: レストランバーDeals・小沢ミートなど直販（在庫画面からの出荷確定）で
//     作られたDIR-注文は、注文なし出荷を記録するrecordDirectShipment()が
//     order_items.unit_price/amountを一切設定しておらず、常に0円だった
//     （システム全体で24件・178明細・約211kgが未反映のまま残っていた）。
//     価格マスタ×顧客の価格ランク×肉ランクで単価を引いて保存するようにした。
//     また、価格マスタの「カタ（ウデ）」が実データの「カタ」と表記が違い
//     一致しなかった問題も、価格マスタ側を「カタ」に統一して修正した。
//
//   ここで測ること
//     1. 価格マスタに完全一致する部位・肉ランクがあれば単価・金額が入る
//     2. 部位名の末尾の（全体）等を丸めた基本部位名でも価格マスタと一致する
//     3. 顧客の価格ランク（standard以外）で単価が変わる
//     4. 注文のtotal_amountが明細の合計になる
//     5. 価格マスタに無い部位は単価0円のまま気付かず終わらず、警告が出る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');

(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9104);
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));

  const PRICE_MASTER = [
    { id: 'pm1', species: 'イノシシ', part_name: 'モモ', grade: '並', price_standard: 3250, price_local: 2800 },
    { id: 'pm2', species: 'イノシシ', part_name: 'モモ', grade: '極上', price_standard: 3900, price_local: 3500 },
    { id: 'pm3', species: 'イノシシ', part_name: 'カタ', grade: '並', price_standard: 2200, price_local: 2000 },
  ];
  const CUSTOMERS = { 'cust-a': { id: 'cust-a', price_rank: 'standard' }, 'cust-b': { id: 'cust-b', price_rank: 'local' } };
  const writes = { orders: [], order_items: [] };
  let lookupCustomerId = null;

  await p.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = (x, st) => rt.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (/\/rpc\/staff_lookup_customer_id/.test(url)) return J(lookupCustomerId);
    if (m === 'GET' && /\/price_master/.test(url)) return J(PRICE_MASTER);
    if (m === 'GET' && /\/customers/.test(url)) {
      const idMatch = url.match(/id=eq\.([^&]+)/);
      const cust = idMatch && CUSTOMERS[idMatch[1]];
      return J(cust ? [cust] : []);
    }
    if (m === 'POST' && /\/orders/.test(url)) { const body = JSON.parse(req.postData() || '{}'); writes.orders.push(body); return J([{ id: 'ord-' + writes.orders.length, ...body }], 201); }
    if (m === 'POST' && /\/order_items/.test(url)) { const body = JSON.parse(req.postData() || '[]'); writes.order_items.push(...(Array.isArray(body) ? body : [body])); return J([], 201); }
    if (m === 'POST' && /\/shipments/.test(url)) return J([{ id: 'sh-1' }], 201);
    if (m === 'PATCH' && /\/inventory/.test(url)) return J([]);
    return J([]);
  });
  await p.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));
  await p.goto('http://localhost:9104/index.html'); await p.waitForTimeout(600);

  const toasts = [];
  await p.evaluate(() => { window.__toasts = []; window.toast = (msg, type) => window.__toasts.push({ msg, type }); });

  // ── ① 完全一致（品種・部位・肉ランク） ──
  lookupCustomerId = 'cust-a';
  let r1 = await p.evaluate(() => recordDirectShipment(
    [{ id: 'inv-1', part_name: 'カタ', species: 'イノシシ', grade: '並', weight: 0.5 }],
    'A店', {}
  ));
  ck('完全一致の単価(2200)×0.5kg=1100円になる', writes.order_items[0].unit_price === 2200 && writes.order_items[0].amount === 1100, JSON.stringify(writes.order_items[0]));
  ck('注文のtotal_amountも1100円になる', writes.orders[0].total_amount === 1100, JSON.stringify(writes.orders[0]));

  // ── ② 部位名の末尾（全体）等を丸めた基本部位名でも一致する ──
  writes.orders.length = 0; writes.order_items.length = 0;
  await p.evaluate(() => recordDirectShipment(
    [{ id: 'inv-2', part_name: 'モモ（全体）', species: 'イノシシ', grade: '並', weight: 2 }],
    'A店', {}
  ));
  ck('モモ（全体）でも基本部位名「モモ」の単価(3250)で計算される', writes.order_items[0].unit_price === 3250 && writes.order_items[0].amount === 6500, JSON.stringify(writes.order_items[0]));

  // ── ③ 顧客の価格ランク（local）で単価が変わる ──
  writes.orders.length = 0; writes.order_items.length = 0;
  lookupCustomerId = 'cust-b';
  await p.evaluate(() => recordDirectShipment(
    [{ id: 'inv-3', part_name: 'モモ（全体）', species: 'イノシシ', grade: '並', weight: 2 }],
    'B店', {}
  ));
  ck('価格ランクlocalなら単価2800円になる（standardの3250円ではない）', writes.order_items[0].unit_price === 2800 && writes.order_items[0].amount === 5600, JSON.stringify(writes.order_items[0]));

  // ── ④ 肉ランク違いでも正しく引ける ──
  writes.orders.length = 0; writes.order_items.length = 0;
  lookupCustomerId = 'cust-a';
  await p.evaluate(() => recordDirectShipment(
    [{ id: 'inv-4', part_name: 'モモ（全体）', species: 'イノシシ', grade: '極上', weight: 1 }],
    'A店', {}
  ));
  ck('肉ランク極上なら単価3900円になる', writes.order_items[0].unit_price === 3900, JSON.stringify(writes.order_items[0]));

  // ── ⑤ 価格マスタに無い部位は0円のまま気付かず終わらず、警告が出る ──
  writes.orders.length = 0; writes.order_items.length = 0;
  await p.evaluate(() => { window.__toasts.length = 0; });
  await p.evaluate(() => recordDirectShipment(
    [{ id: 'inv-5', part_name: 'シンタマ', species: 'イノシシ', grade: '並', weight: 1 }],
    'A店', {}
  ));
  ck('価格マスタに無い部位は単価null（0円で確定しない）', writes.order_items[0].unit_price == null, JSON.stringify(writes.order_items[0]));
  const toastsSeen = await p.evaluate(() => window.__toasts);
  ck('単価が見つからないと警告トーストが出る', toastsSeen.some(t => t.type === 'error' && /単価/.test(t.msg) && /シンタマ/.test(t.msg)), JSON.stringify(toastsSeen));

  ck('JSエラーなし', !errs.some(e => /recordDirectShipment|directShipPrice/.test(e)), errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
