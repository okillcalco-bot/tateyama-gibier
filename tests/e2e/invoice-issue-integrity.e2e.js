// 請求書の発行: 途中失敗・二重発行・請求済みの判定・差替えの紐付け（2026-11-03「改善指示案 P1-A／P1-C」）
//
//   実測（本番・読取りのみ）
//     - 9月分で、前の版を取消さずに出し直した請求書が5組（同じ注文が有効な請求書2〜3枚に入っていた・26注文）
//     - 書類発行タブで注文1件から作った書類（order_id を持つ）が、請求書作成の一覧に出ない（発行済の請求書18枚・納品書19枚）
//     - 個別取込は納品書も「請求済み」にしていた（月まとめは請求書だけ）→ 納品書を出した注文が取込み一覧から隠れる
//     - 見出し・明細・紐付けは別々に保存。明細や紐付けが失敗しても警告だけで印刷へ進み、発行済の見出しだけが残りえた
//     - 取消した請求書を複製しても注文の紐付けを引き継がず、出し直した版の注文が「未請求」に見えていた
//
//   ここで測ること（架空データ・中身を持つ模擬DB）
//     受入2: 納品書だけ・下書きのまま・取消の請求書の注文は、個別取込でも月まとめでも未請求に出る（両者の対象が一致）
//     受入3: 明細／紐付け／発行済への更新が失敗したら、印刷に進まず、見出しは取消（下書きから開いたものは下書きに戻す）。
//            成功のときだけ印刷。発行ボタンの連打で2枚目を作らない。月まとめ・書類発行タブも同じ
//     受入6: 取消した請求書を複製→発行すると、注文の紐付けを引き継ぎ、「差替え」の関係が一覧に出る。
//            有効な請求書に入っている注文をもう一度請求しようとすると、確認画面に番号つきで警告が出る
//     受入8: 取消の書類は請求済みに数えない。一覧に order_id つきの書類（書類発行タブで1件から作ったもの）も出る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const CUSTOMERS = [{ id: 'c1', code: 'C9201', name: 'テスト食堂', kana: 'てすとしょくどう', price_rank: 'standard', address: '東京都テスト区1-1', honorific: '様', is_active: true, search_aliases: [], notes: '' }];
const it = (id, part, kg, sub) => ({ id, species: 'イノシシ', part_name: part, weight_kg: kg, weight: kg, subtotal: sub, amount: sub, grade_snapshot: '並', inventory_id: null });
const ORDERS = [
  { id: 'o1', customer_id: 'c1', customer_name: 'テスト食堂', order_code: 'DIR-T-1', order_date: '2026-09-10', delivery_date: '2026-09-10', status: '発送済', total_amount: 7600, memo: null, channel: '直販（注文なし）', order_items: [it('i1', 'ロース', 2, 7600)], shipments: [{ freight: 1020, size_code: 80, is_cool: true }] },
  { id: 'o2', customer_id: 'c1', customer_name: 'テスト食堂', order_code: 'DIR-T-2', order_date: '2026-09-20', delivery_date: '2026-09-20', status: '発送済', total_amount: 6200, memo: null, channel: '直販（注文なし）', order_items: [it('i2', 'バラ', 2, 6200)], shipments: [] },
  { id: 'o3', customer_id: 'c1', customer_name: 'テスト食堂', order_code: 'DIR-T-3', order_date: '2026-09-25', delivery_date: '2026-09-25', status: '発送済', total_amount: 5000, memo: null, channel: '直販（注文なし）', order_items: [it('i3', 'モモ', 2, 5000)], shipments: [] },
];
const snap = (o) => ({ type: '請求書', name: 'テスト食堂', honorific: '様', date: '2026-10-01', lines: [{ name: 'x', qty: 1, unit: '式', price: 100, tax: 8, amount: 100 }], ...o });
function freshDb() {
  return {
    documents: [
      { id: 'd-dlv', doc_type: '納品書', doc_number: 'DLV-T-001', status: '発行済', customer_id: 'c1', order_id: 'o1', issue_date: '2026-09-11', total_amount: 7600, created_at: '2026-09-11T00:00:00Z', snapshot: snap({ type: '納品書', order_ids: ['o1'] }) },
      { id: 'd-draft', doc_type: '請求書', doc_number: 'INV-T-090', status: '下書き', customer_id: 'c1', order_id: null, issue_date: '2026-10-01', total_amount: 6200, created_at: '2026-10-01T00:00:00Z', snapshot: snap({ order_ids: ['o2'] }) },
      { id: 'd-void', doc_type: '請求書', doc_number: 'INV-T-001', status: '取消', customer_id: 'c1', order_id: null, issue_date: '2026-10-01', total_amount: 5000, created_at: '2026-10-01T01:00:00Z', snapshot: snap({ order_ids: ['o3'], customer_id: 'c1' }) },
    ],
    document_orders: [{ document_id: 'd-dlv', order_id: 'o1' }, { document_id: 'd-draft', order_id: 'o2' }, { document_id: 'd-void', order_id: 'o3' }],
    document_items: [],
    log: [], fail: {}, n: 0,
  };
}
const inList = v => (v || '').replace(/^in\.\(|\)$/g, '').split(',').filter(Boolean);

async function openPage(browser, db) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date('2026-10-30T03:00:00Z'));
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const dialogs = []; let confirmAnswer = true;
  page.on('dialog', d => { dialogs.push(d.message()); d.type() === 'confirm' ? (confirmAnswer ? d.accept() : d.dismiss()) : d.accept(); });
  await page.addInitScript(() => {
    window.__opened = 0;
    window.open = () => { window.__opened++; return { document: { open() {}, write() {}, close() {} }, close() {}, focus() {} }; };
    try { localStorage.setItem('tg_staff_key', 'TESTKEY'); } catch (e) {}
  });
  await page.route('**/rest/v1/**', async route => {
    const req = route.request(), m = req.method(), u = new URL(req.url()), t = u.pathname.split('/').pop(), q = u.searchParams;
    const J = (b, s) => route.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(b) });
    const F = () => route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"テスト用の保存失敗"}' });
    const body = () => { try { return JSON.parse(req.postData() || 'null'); } catch (e) { return null; } };
    if (m !== 'GET') db.log.push({ m, t, q: decodeURIComponent(u.search), b: body() });
    if (t === 'customers') return J(CUSTOMERS);
    if (t === 'orders') {
      if (m !== 'GET') return J([]);
      let rows = ORDERS.slice();
      const cid = (q.get('customer_id') || '').replace(/^eq\./, ''); if (cid) rows = rows.filter(o => o.customer_id === cid);
      const st = q.get('status'); if (st) rows = rows.filter(o => inList(st).includes(o.status));
      for (const d of q.getAll('order_date')) { const [op, v] = d.split('.'); rows = rows.filter(o => op === 'gte' ? o.order_date >= v : o.order_date <= v); }
      const ids = q.get('id'); if (ids) rows = rows.filter(o => inList(ids).includes(o.id));
      return J(rows);
    }
    if (t === 'documents') {
      if (m === 'POST') {
        if (db.fail.header) return F();
        const arr = [].concat(body()); const out = arr.map(h => { const row = { id: 'd' + (++db.n), created_at: new Date().toISOString(), order_id: null, ...h }; db.documents.push(row); return row; });
        return J(out, 201);
      }
      if (m === 'PATCH') {
        const id = (q.get('id') || '').replace(/^eq\./, ''); const b = body() || {};
        if (db.fail.patchIssued && b.status === '発行済') return F();
        const row = db.documents.find(d => d.id === id); if (row) Object.assign(row, b);
        return J(row ? [row] : []);
      }
      if (m === 'DELETE') return J([]);
      let rows = db.documents.slice();
      const id = q.get('id'); if (id) rows = id.startsWith('in.') ? rows.filter(d => inList(id).includes(d.id)) : rows.filter(d => d.id === id.replace(/^eq\./, ''));
      const ty = q.get('doc_type'); if (ty) rows = rows.filter(d => d.doc_type === ty.replace(/^eq\./, ''));
      const oi = q.get('order_id'); if (oi === 'is.null') rows = rows.filter(d => !d.order_id); else if (oi) rows = rows.filter(d => inList(oi).includes(d.order_id));
      const st = q.get('status'); if (st) rows = st.startsWith('neq.') ? rows.filter(d => d.status !== st.slice(4)) : rows.filter(d => d.status === st.replace(/^eq\./, ''));
      const dn = q.get('doc_number'); if (dn) { const pre = dn.replace(/^like\./, '').replace(/\*$/, ''); rows = rows.filter(d => (d.doc_number || '').startsWith(pre)); }
      return J(rows);
    }
    if (t === 'document_orders') {
      if (m === 'POST') { if (db.fail.links) return F(); db.document_orders.push(...[].concat(body())); return J([], 201); }
      if (m === 'DELETE') { const id = (q.get('document_id') || '').replace(/^eq\./, ''); db.document_orders = db.document_orders.filter(l => l.document_id !== id); return J([]); }
      let rows = db.document_orders.slice();
      const oi = q.get('order_id'); if (oi) rows = rows.filter(l => inList(oi).includes(l.order_id));
      const sel = q.get('select') || '';
      return J(rows.map(l => /documents\(/.test(sel) ? { ...l, documents: db.documents.find(d => d.id === l.document_id) || null } : l));
    }
    if (t === 'document_items') {
      if (m === 'POST') { if (db.fail.items) return F(); db.document_items.push(...[].concat(body())); return J([], 201); }
      if (m === 'DELETE') { const id = (q.get('document_id') || '').replace(/^eq\./, ''); db.document_items = db.document_items.filter(l => l.document_id !== id); return J([]); }
      return J(db.document_items);
    }
    if (t === 'app_settings') return J([{ value: { issuer_name: 'テスト発行元', bank: 'テスト銀行 普通 0000000' } }]);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(700);
  await page.evaluate(() => switchTab('invoice'));
  await page.waitForTimeout(400);
  return { ctx, page, errors, dialogs, setConfirm: v => { confirmAnswer = v; } };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const out = []; const ck = (n, c, e) => out.push([n, !!c, e == null ? '' : String(e)]);
  const db = freshDb();
  const { ctx, page, errors, dialogs, setConfirm } = await openPage(browser, db);
  const pickCustomer = async () => { await page.fill('#invCustomerInput', 'C9201 テスト食堂'); await page.dispatchEvent('#invCustomerInput', 'input'); await page.waitForTimeout(700); };

  // ── 受入2・8: 請求済みの判定（個別取込と月まとめ） ──
  await pickCustomer();
  const pull = await page.evaluate(() => invPullOrders.map(o => ({ c: o.order_code, b: o._billed })));
  ck('受入2: 納品書だけ（o1）・下書きのまま（o2）・取消の請求書（o3）の注文は、個別取込で未請求に出る', pull.length === 3 && pull.every(x => !x.b), JSON.stringify(pull));
  await page.evaluate(() => { document.getElementById('invBatchPeriod').value = '1'; return invBatchSearch(); }); await page.waitForTimeout(500);
  const batch = await page.evaluate(() => invBatchGroups.map(g => ({ n: g.cust.name, codes: g.orders.map(o => o.order_code).sort() })));
  ck('受入2: 月まとめ（9月分）でも同じ3件が対象（個別取込と一致）', batch.length === 1 && JSON.stringify(batch[0].codes) === JSON.stringify(['DIR-T-1', 'DIR-T-2', 'DIR-T-3']), JSON.stringify(batch));
  await page.click('#invModeTabs button[data-mode="single"]');

  // ── 受入8: 一覧に order_id つきの書類も出る ──
  await page.evaluate(() => invSetListType('納品書')); await page.waitForTimeout(400);
  const dlvList = await page.innerText('#invListBody');
  ck('受入8: 書類発行タブで注文1件から作った書類（order_id つき）も一覧に出る（納品書 DLV-T-001）', /DLV-T-001/.test(dlvList), dlvList.slice(0, 200));
  await page.evaluate(() => invSetListType('請求書')); await page.waitForTimeout(400);

  // ── 受入3: 1枚発行の途中失敗 ──
  const applyPull = async () => { await page.evaluate(() => { invPullToggleAll(true); return invPullApply(); }); await page.waitForTimeout(300); };
  const tryIssue = async (fail) => {
    db.fail = fail; db.log.length = 0; dialogs.length = 0;
    const before = await page.evaluate(() => window.__opened);
    await page.evaluate(() => invIssue()); await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({ opened: window.__opened, lines: invLines.filter(l => l.name).length }));
    const posted = db.log.find(x => x.m === 'POST' && x.t === 'documents');
    const docId = posted ? db.documents[db.documents.length - 1].id : null;
    const doc = docId ? db.documents.find(d => d.id === docId) : null;
    return { printed: after.opened - before, lines: after.lines, status: doc && doc.status, number: doc && doc.doc_number, headerStatus: posted && [].concat(posted.b)[0].status, alerts: dialogs.slice(), docId };
  };
  await applyPull();
  let r = await tryIssue({ items: true });
  ck('受入3: 明細の保存に失敗 → 印刷しない・見出しは取消・入力は残る・理由を画面に出す', r.printed === 0 && r.status === '取消' && r.headerStatus === '下書き' && r.lines > 0 && r.alerts.some(a => /発行できませんでした/.test(a) && /印刷はしていません/.test(a)), JSON.stringify(r));
  r = await tryIssue({ links: true });
  ck('受入3: 注文の紐付けの保存に失敗 → 同じく印刷しない・取消・二重請求防止の記録は残らない', r.printed === 0 && r.status === '取消' && !db.document_orders.some(l => l.document_id === r.docId) && r.alerts.some(a => /発行できませんでした/.test(a)), JSON.stringify(r));
  r = await tryIssue({ patchIssued: true });
  ck('受入3: 「発行済」への更新に失敗 → 印刷しない・発行済にならない', r.printed === 0 && r.status !== '発行済', JSON.stringify(r));
  // 失敗した書類は請求済みに数えない（もう一度取り込める）
  await page.evaluate(() => invPullSearch()); await page.waitForTimeout(400);
  ck('受入8: 途中で失敗して取消になった書類は請求済みに数えない（3件とも未請求のまま）', await page.evaluate(() => invPullOrders.filter(o => !o._billed).length) === 3, '');

  // ── 受入3: 成功のときだけ印刷・順番 ──
  r = await tryIssue({});
  const seq = db.log.filter(x => x.t !== 'orders').map(x => x.m + ' ' + x.t + (x.t === 'documents' && x.m === 'PATCH' ? ':' + (x.b || {}).status : ''));
  ck('受入3: 成功 → 見出し（下書き）→ 明細 → 紐付け → 発行済 の順に保存し、そのあと1回だけ印刷', r.printed === 1 && r.status === '発行済' && r.headerStatus === '下書き'
    && seq.indexOf('POST document_items') > seq.indexOf('POST documents') && seq.indexOf('POST document_orders') > seq.indexOf('POST document_items') && seq.indexOf('PATCH documents:発行済') > seq.indexOf('POST document_orders'), JSON.stringify(seq));
  const issuedA = r.number;

  // ── 受入6: 有効な請求書に入っている注文をもう一度請求しようとすると警告 ──
  await pickCustomer();
  await page.evaluate(() => invPullSearch()); await page.waitForTimeout(400);
  ck('受入2/6: 発行した注文は請求済みになり、取込み一覧では✓が外れる（請求済 番号つき）', await page.evaluate(n => invPullOrders.filter(o => o._billed && o._doc === n).length, issuedA) === 3, issuedA);
  await page.evaluate(() => { document.querySelectorAll('.inv-pull-cb').forEach(cb => { cb.checked = true; }); return invPullApply(); }); await page.waitForTimeout(300);
  setConfirm(false); dialogs.length = 0; db.log.length = 0;
  await page.evaluate(() => invIssue()); await page.waitForTimeout(400);
  setConfirm(true);
  ck('受入6: 同じ注文をもう一度請求しようとすると、確認画面の先頭に番号つきで二重請求の警告（キャンセルで何も保存しない）',
    dialogs.some(d => new RegExp('すでに有効な請求書（' + issuedA + '）').test(d)) && !db.log.some(x => x.m === 'POST' && x.t === 'documents'), JSON.stringify(dialogs.slice(-1)).slice(0, 300));
  await page.evaluate(() => invResetForm());

  // ── 受入3: 連打で2枚目を作らない ──
  await page.evaluate(() => { invLines = [{ name: '連打テスト', qty: 1, unit: '式', price: 1000, tax: 8 }]; document.getElementById('invName').value = '連打テスト店'; renderInvLines(); });
  db.log.length = 0;
  await page.evaluate(() => Promise.all([invIssue(), invIssue(), invIssue()])); await page.waitForTimeout(400);
  ck('受入3: 発行ボタンを3回続けて押しても、書類は1枚だけ', db.log.filter(x => x.m === 'POST' && x.t === 'documents').length === 1, db.log.filter(x => x.t === 'documents').length);

  // ── 受入6: 取消した請求書を複製→発行 → 紐付けを引き継ぎ、差替えの関係が一覧に出る ──
  db.document_orders = db.document_orders.filter(l => l.order_id !== 'o3');   // o3 は取消の INV-T-001 だけ（上の発行分の紐付けを外して、出し直しの場面を作る）
  db.documents.forEach(d => { if (d.id === 'd-void') d.status = '取消'; });
  db.document_orders.push({ document_id: 'd-void', order_id: 'o3' });
  await page.evaluate(() => loadInvoiceList()); await page.waitForTimeout(400);
  dialogs.length = 0;
  await page.evaluate(() => invCopy('d-void')); await page.waitForTimeout(300);
  const cp = await page.evaluate(() => ({ links: invLinkedOrderIds.slice(), rep: invCollect().replaces }));
  ck('受入6: 取消した請求書を複製すると、注文の紐付け（o3）を引き継ぎ、差替え元（INV-T-001）を記録する', JSON.stringify(cp.links) === '["o3"]' && cp.rep && cp.rep.doc_number === 'INV-T-001' && dialogs.some(d => /差替え/.test(d)), JSON.stringify(cp));
  r = await tryIssue({});
  const newDoc = db.documents.find(d => d.id === r.docId);
  ck('受入6: 出し直した請求書は発行済・注文 o3 に紐付き・スナップショットに差替え元が残る', r.status === '発行済' && db.document_orders.some(l => l.document_id === r.docId && l.order_id === 'o3') && newDoc.snapshot.replaces && newDoc.snapshot.replaces.doc_id === 'd-void', JSON.stringify({ r, rep: newDoc && newDoc.snapshot.replaces }));
  await page.evaluate(() => loadInvoiceList()); await page.waitForTimeout(400);
  const listTxt = await page.innerText('#invListBody');
  ck('受入6: 一覧で「← INV-T-001 の差替え」「→ 新番号 に差替え」が分かる', new RegExp('INV-T-001 の差替え').test(listTxt) && new RegExp('→ ' + r.number + ' に差替え').test(listTxt), listTxt.replace(/\s+/g, ' ').slice(0, 400));
  dialogs.length = 0;
  await page.evaluate(n => invCopy(invListRows.find(x => x.doc_number === n).id), r.number); await page.waitForTimeout(300);
  ck('受入6: 有効な請求書を複製したときは紐付けを引き継がず、元が有効なままだと知らせる', await page.evaluate(() => invLinkedOrderIds.length) === 0 && dialogs.some(d => /有効なまま/.test(d)), JSON.stringify(dialogs.slice(-1)).slice(0, 200));
  await page.evaluate(() => invResetForm());

  // ── 受入3: 月まとめの途中失敗 ──
  const db2 = freshDb();
  const p2 = await openPage(browser, db2);
  await p2.page.evaluate(() => { document.getElementById('invBatchPeriod').value = '1'; return invBatchSearch(); }); await p2.page.waitForTimeout(500);
  db2.fail = { items: true }; p2.dialogs.length = 0;
  await p2.page.evaluate(() => invBatchIssue()); await p2.page.waitForTimeout(600);
  const bd = db2.documents.filter(d => /^d\d+$/.test(d.id));
  ck('受入3: 月まとめで明細の保存に失敗 → その請求先は取消・発行できなかったと番号つきで出す・紐付けは残らない',
    bd.length === 1 && bd[0].status === '取消' && !db2.document_orders.some(l => l.document_id === bd[0].id) && p2.dialogs.some(d => /発行できませんでした/.test(d)), JSON.stringify({ bd: bd.map(d => d.status), dl: p2.dialogs.slice(-1) }).slice(0, 300));
  await p2.ctx.close();

  // ── 受入3: 書類発行タブの途中失敗 ──
  const db3 = freshDb();
  const p3 = await openPage(browser, db3);
  await p3.page.evaluate(() => switchTab('documents')); await p3.page.waitForTimeout(300);
  await p3.page.selectOption('#docPeriod', 'lastMonth'); await p3.page.waitForTimeout(500);
  db3.fail = { links: true }; p3.dialogs.length = 0;
  const before3 = await p3.page.evaluate(() => window.__opened);
  const ok3 = await p3.page.evaluate(() => generateDoc('請求書', docOrders.filter(o => o.order_code === 'DIR-T-2')));
  const nd = db3.documents.filter(d => /^d\d+$/.test(d.id));
  ck('受入3: 書類発行タブで紐付けの保存に失敗 → 印刷しない・取消・失敗を返す', ok3 === false && nd.length === 1 && nd[0].status === '取消' && (await p3.page.evaluate(() => window.__opened)) === before3, JSON.stringify({ ok3, nd: nd.map(d => d.status) }));
  db3.fail = {};
  const ok3b = await p3.page.evaluate(() => generateDoc('請求書', docOrders.filter(o => o.order_code === 'DIR-T-2')));
  const nd2 = db3.documents.filter(d => /^d\d+$/.test(d.id)).pop();
  ck('受入3: やり直すと発行済・紐付けあり・印刷1回', ok3b === true && nd2.status === '発行済' && db3.document_orders.some(l => l.document_id === nd2.id && l.order_id === 'o2'), JSON.stringify({ ok3b, st: nd2.status }));
  await p3.ctx.close();

  ck('JSエラーなし', errors.length === 0, errors.join(' / '));
  await ctx.close();
  await browser.close();
  out.forEach(([n, ok, e]) => console.log(`${ok ? 'PASS' : 'FAIL'} : ${n}${ok || !e ? '' : '  [' + e.slice(0, 400) + ']'}`));
  console.log(`\n${out.filter(x => x[1]).length}/${out.length} passed`);
  process.exit(out.every(x => x[1]) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
