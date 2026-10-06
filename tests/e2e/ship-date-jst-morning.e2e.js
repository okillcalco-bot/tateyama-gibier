// 朝9時前に登録した出荷の日付が前日になる（2026-10-06）
//
//   きっかけ
//     ジビエファクトリーへ 9/16 朝 8:43 に出した3件が、注文番号 DIR-20260915-084356・出荷日 9/15 で
//     記録されていた。日付を toISOString()（UTC）で作っていたため、日本時間 0:00〜8:59 は前日になる。
//     直販出荷 115件中 13件 が前日付だった（請求・買取・ノブレスさんとの照合で日付がずれる）。
//
//   ここで測ること
//     日本時間 9/16 8:43 に直販出荷を確定すると
//     1. 注文番号が DIR-20260916-…
//     2. orders.order_date / delivery_date が 2026-09-16
//     3. shipments.shipment_date が 2026-09-16
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9133);
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const out = []; const ck = (n, c, e) => out.push([n, !!c, e == null ? '' : String(e)]);
  const ctx = await b.newContext({ timezoneId: 'Asia/Tokyo' });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  // 日本時間 2026-09-16 08:43 ＝ UTC 2026-09-15 23:43
  await p.clock.setFixedTime(new Date('2026-09-15T23:43:00Z'));

  const writes = { orders: [], shipments: [] };
  await p.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = (x, st) => rt.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(x) });
    const body = () => JSON.parse(req.postData() || '{}');
    if (/\/rpc\/staff_lookup_customer_id/.test(url)) return J('cust-a');
    if (m === 'GET' && /\/customers/.test(url)) return J([{ id: 'cust-a', price_rank: 'standard', notes: '' }]);
    if (m === 'GET' && /\/price_master/.test(url)) return J([{ species: 'イノシシ', part_name: 'カタ', grade: '並', price_standard: 2200 }]);
    if (m === 'POST' && /\/orders/.test(url)) { const bd = body(); writes.orders.push(bd); return J([{ id: 'ord-1', ...bd }], 201); }
    if (m === 'POST' && /\/shipments/.test(url)) { const bd = body(); writes.shipments.push(Array.isArray(bd) ? bd[0] : bd); return J([{ id: 'sh-1' }], 201); }
    return J([]);
  });
  await p.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));
  await p.goto('http://localhost:9133/index.html'); await p.waitForTimeout(700);
  await p.evaluate(() => { window.toast = () => {}; });

  await p.evaluate(() => recordDirectShipment([{ id: 'inv-1', ident_code: 'TGC-08-T288-KT', part_name: 'カタ', weight: 0.41, species: 'イノシシ', grade: '並', _via: 'scan' }], 'ジビエファクトリー', {}));
  await p.waitForTimeout(300);
  const o = writes.orders[0] || {}; const s = writes.shipments[0] || {};
  ck('注文番号が日本時間の日付（DIR-20260916-0843…）', /^DIR-20260916-0843/.test(o.order_code || ''), o.order_code);
  ck('order_date / delivery_date が 2026-09-16', o.order_date === '2026-09-16' && o.delivery_date === '2026-09-16', o.order_date + ' / ' + o.delivery_date);
  ck('shipment_date が 2026-09-16', s.shipment_date === '2026-09-16', s.shipment_date);
  ck('ymdLocal は日本時間の今日を返す', (await p.evaluate(() => ymdLocal(new Date()))) === '2026-09-16', await p.evaluate(() => ymdLocal(new Date())));
  ck('pageerror なし', errs.length === 0, errs.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of out) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${out.length} passed`);
  await b.close(); srv.close();
  process.exit(pass === out.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
