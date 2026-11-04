// 請求書の送料: 同じ日に2個以上送っても「いちばん高い1個分」だけを請求する顧客
//
//   きっかけ（2026-11-04 沖）
//     「大和工務店は同日に2個以上送っているときは、一番高い送料のみ1個だけの請求にして」。
//     顧客台帳の備考に 【送料】同日は最高1個 と書いた請求先だけに効く決まりにした。
//     運送会社に払った送料（shipments.freight）は変えず、請求書の明細だけを1行にする。
//
//   ここで測ること（顧客・金額はすべて架空）
//     1. 印のある顧客: 同じ日の2件の出荷（1,450円・980円）→ 送料は 1,450円×1個 の1行だけ
//     2. 1件で2個口（2,430円・2個）→ 1,215円×1個
//     3. 箱ごとの金額が備考にある日（100・1,300円＋120・1,740円）→ 1,740円×1個
//     4. 1個だけの日・別の日はそのまま
//     5. 箱ごとの金額が分からない日（サイズ違いの「1式」）は勝手に決めずそのまま
//     6. 印の無い顧客は今までどおり全部の箱を請求する
//     7. 請求書作成の「注文から取り込む」と、書類発行の両方で同じ決まりが効く
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { await d.dismiss(); });

  const MARK = '【送料】同日は最高1個';
  const CUST_R = { id: 'cust-r', code: 'C9001', name: '架空工務店', address: '千葉県架空市1', is_active: true, price_rank: 'local', notes: MARK + '\n依頼主コード:test' };
  const CUST_N = { id: 'cust-n', code: 'C9002', name: '架空食堂', address: '千葉県架空市2', is_active: true, price_rank: 'local', notes: '' };
  const item = (id, kg, amt) => ({ id, species: 'イノシシ', part_name: 'ペットフード用（あり）', weight_kg: kg, weight: kg, unit_price: 700, amount: amt, subtotal: amt, grade_snapshot: '並' });
  const ord = (id, cust, date, ship) => ({ id, customer_id: cust.id, customer_name: cust.name, order_code: 'TEST-' + id, order_date: date, delivery_date: date, status: '発送済', total_amount: 7000, order_items: [item(id + '-i', 10, 7000)], shipments: [ship] });
  const ORDERS = [
    // 10/1: 同じ日に2件（1個ずつ）
    ord('r1', CUST_R, '2026-10-01', { freight: 1450, size_code: 140, is_cool: true, package_count: 1 }),
    ord('r2', CUST_R, '2026-10-01', { freight: 980, size_code: 100, is_cool: true, package_count: 1 }),
    // 10/2: 1件で2個口
    ord('r3', CUST_R, '2026-10-02', { freight: 2430, size_code: 140, is_cool: true, package_count: 2 }),
    // 10/3: 箱ごとの金額が備考にある
    ord('r4', CUST_R, '2026-10-03', { freight: 3040, size_code: 120, is_cool: true, package_count: 2, notes: '（100・1,300円）＋（120・1,740円）' }),
    // 10/4: 1個だけ
    ord('r5', CUST_R, '2026-10-04', { freight: 1450, size_code: 140, is_cool: true, package_count: 1 }),
    // 10/5: サイズ違いで箱ごとの金額が分からない（1式）
    ord('r6', CUST_R, '2026-10-05', { freight: 2777, size_code: 140, is_cool: true, package_count: 2, notes: '100×1、140×1' }),
    // 印の無い顧客: 同じ日に2件
    ord('n1', CUST_N, '2026-10-01', { freight: 1450, size_code: 140, is_cool: true, package_count: 1 }),
    ord('n2', CUST_N, '2026-10-01', { freight: 980, size_code: 100, is_cool: true, package_count: 1 }),
  ];

  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = x => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m === 'POST' && /\/documents\b/.test(url)) { const b = JSON.parse(req.postData() || '{}'); return J([{ ...b, id: 'doc-1' }]); }
    if (m !== 'GET') return J([]);
    if (/\/customers\b/.test(url)) return J([CUST_R, CUST_N]);
    if (/\/documents\b/.test(url)) return J([]);
    if (/\/document_orders\b/.test(url)) return J([]);
    if (/\/orders\b/.test(url) && /order_items/.test(url)) return J(ORDERS);
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));
  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(700);

  const results = [];
  const ck = (name, cond, got) => results.push([name, !!cond, got == null ? '' : String(got)]);

  // ── 関数そのもの ──
  const r = await page.evaluate(({ ORDERS, CUST_R, CUST_N }) => {
    const fr = (os, c) => invBuildLinesFromOrders(os, {}, 'local', c).filter(l => /送料/.test(l.name));
    return {
      flagR: custFreightOnePerDay(CUST_R), flagN: custFreightOnePerDay(CUST_N), flagNull: custFreightOnePerDay(null),
      d1: fr(ORDERS.filter(o => o.id === 'r1' || o.id === 'r2'), CUST_R),
      d2: fr(ORDERS.filter(o => o.id === 'r3'), CUST_R),
      d3: fr(ORDERS.filter(o => o.id === 'r4'), CUST_R),
      d4: fr(ORDERS.filter(o => o.id === 'r5'), CUST_R),
      d5: fr(ORDERS.filter(o => o.id === 'r6'), CUST_R),
      all: fr(ORDERS.filter(o => o.customer_id === 'cust-r'), CUST_R),
      plain: fr(ORDERS.filter(o => o.customer_id === 'cust-n'), CUST_N),
      noCust: fr(ORDERS.filter(o => o.id === 'r1' || o.id === 'r2')),
    };
  }, { ORDERS, CUST_R, CUST_N });
  const one = ls => ls.length === 1 ? ls[0] : null;
  ck('備考の印で顧客を見分ける（印あり true・印なし false・顧客なし false）', r.flagR && !r.flagN && !r.flagNull, [r.flagR, r.flagN, r.flagNull].join(','));
  const a = one(r.d1);
  ck('1. 同じ日の2件（1,450円・980円）→ 1,450円×1個の1行だけ', a && a.price === 1450 && a.qty === 1 && a.unit === '個', JSON.stringify(r.d1));
  ck('1. 品名に「同日2個のうち1個分」と納品日が入る', a && /^10\/1納品/.test(a.name) && /（同日2個のうち1個分）/.test(a.name) && /クール140/.test(a.name), a && a.name);
  ck('1. 送料の税率は10%のまま', a && a.tax === 10, a && a.tax);
  const b = one(r.d2);
  ck('2. 1件で2個口（2,430円）→ 1,215円×1個', b && b.price === 1215 && b.qty === 1, JSON.stringify(r.d2));
  const c = one(r.d3);
  ck('3. 箱ごとの金額がある日（1,300円＋1,740円）→ 高い方の1,740円×1個（120サイズ）', c && c.price === 1740 && c.qty === 1 && /クール120/.test(c.name), JSON.stringify(r.d3));
  const d = one(r.d4);
  ck('4. 1個だけの日はそのまま（注記も付けない）', d && d.price === 1450 && d.qty === 1 && !/同日/.test(d.name), JSON.stringify(r.d4));
  const e = one(r.d5);
  ck('5. 箱ごとの金額が分からない日（1式）は勝手に決めずそのまま 2,777円', e && e.price === 2777 && e.unit === '式', JSON.stringify(r.d5));
  ck('4. 日ごとに別々に数える（5日分で送料5行）', r.all.length === 5, JSON.stringify(r.all.map(l => l.name + ' ' + l.qty + '×' + l.price)));
  ck('6. 印の無い顧客は今までどおり2行（1,450円・980円）', r.plain.length === 2 && r.plain.map(l => l.price).sort().join(',') === '1450,980', JSON.stringify(r.plain));
  ck('6. 顧客を渡さない呼び出しも今までどおり2行', r.noCust.length === 2, JSON.stringify(r.noCust));

  // ── 7a. 請求書作成の「注文から取り込む」 ──
  await page.evaluate(() => switchTab('invoice'));
  await page.waitForTimeout(150);
  await page.evaluate(() => { document.getElementById('invCustomerId').value = 'cust-r'; });
  await page.evaluate(() => { const p = document.getElementById('invPullPeriod'); if (p) p.value = 'all'; });
  await page.evaluate(() => invPullSearch());
  await page.waitForTimeout(300);
  await page.evaluate(() => invPullToggleAll(true));
  await page.evaluate(() => invPullApply());
  await page.waitForTimeout(300);
  const pulled = await page.evaluate(() => invLines.filter(l => /送料/.test(l.name || '')).map(l => ({ name: l.name, qty: Number(l.qty), price: Number(l.price) })));
  const p1 = pulled.find(l => /^10\/1納品/.test(l.name));
  ck('7a. 注文から取り込む: 10/1の送料は 1,450円×1個の1行', pulled.filter(l => /^10\/1納品/.test(l.name)).length === 1 && p1 && p1.price === 1450 && p1.qty === 1, JSON.stringify(pulled));
  ck('7a. 注文から取り込む: 送料は5行（日ごと）', pulled.length === 5, JSON.stringify(pulled));

  // ── 7b. 書類発行 ──
  await page.evaluate(() => switchTab('documents'));
  await page.waitForTimeout(400);
  await page.evaluate(() => { document.querySelectorAll('#docOrderList input[type=checkbox]').forEach(cb => cb.checked = (cb.dataset.oid === 'r1' || cb.dataset.oid === 'r2')); });
  const [popup] = await Promise.all([page.waitForEvent('popup', { timeout: 8000 }), page.evaluate(() => generateDoc('請求書'))]);
  await popup.waitForLoadState();
  const html = await popup.content();
  const freightRows = (html.match(/送料（クール\d+）/g) || []);
  ck('7b. 書類発行: 送料は1行だけ（クール140）', freightRows.length === 1 && freightRows[0] === '送料（クール140）', freightRows.join(','));
  ck('7b. 書類発行: 「同日2個のうち1個分」と出る', /同日2個のうち1個分/.test(html), '');
  ck('7b. 書類発行: 980円の送料行は出ない', !/送料（クール100）/.test(html), '');
  await popup.close();

  ck('pageerrorなし', errors.length === 0, errors.join(' / '));
  await browser.close();
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + got.slice(0, 300) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
