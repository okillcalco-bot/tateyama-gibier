// 同じ注文に2枚目の請求書を作らない（2026-11-08）
//
//   きっかけ
//     蔓山の10/22の注文に請求書（INV-202611-049）があるのに、書類発行タブで同じ注文の請求書（INV-202611-051）が
//     もう1枚できた。どの画面も「二重請求になる可能性があります。続けますか？」の確認だけで、押せば作れていた。
//
//   ここで測ること（顧客・注文・請求書はすべて架空）
//     1. invAliveInvoiceConflicts: 取消されていない請求書だけを数える（単独注文の請求書・まとめた請求書の両方）。
//        取消済み・納品書は数えない。編集中の請求書そのものは除ける
//     2. 確かめられなかったら（通信失敗）発行しない・理由を出す
//     3. 請求書作成タブ: 取り込み一覧の請求済みは✓を押せない。万一選ばれていても取り込まずに止める。
//        納品書だけの注文は請求済みにしない（以前は納品書も「請求済」に数えていた。止めるようにしたので、数え違いは請求できない注文を生む）
//     4. 請求書作成タブの発行（invIssue）: 取り込んだ注文にもう請求書があれば保存しない
//     5. 月まとめ（invIssuePayloadNow）: 集計の後に別の画面で請求書ができていたら、その請求先は発行しない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const CUST = { id: 'cust-a', code: 'C0901', name: '架空食堂', address: '架空県架空市', is_active: true };
  const ORD = (id, code, d) => ({ id, customer_id: CUST.id, customer_name: CUST.name, order_code: code, order_date: d, delivery_date: d, status: '発送済', total_amount: 1000,
    order_items: [{ id: 'i' + id, species: 'イノシシ', part_name: 'レバー', weight_kg: 2, unit_price: 500, subtotal: 1000, amount: 1000 }], shipments: [] });
  const ORDERS = [ORD('o1', 'DIR-A001', '2026-10-01'), ORD('o2', 'DIR-A002', '2026-10-02'), ORD('o3', 'DIR-A003', '2026-10-03'), ORD('o4', 'DIR-A004', '2026-10-04')];
  // 架空の書類: o1=単独の請求書（発行済）、o2=まとめた請求書（発行済）、o3=取消した請求書、o4=納品書だけ
  const DOCS = [
    { id: 'd1', order_id: 'o1', doc_type: '請求書', status: '発行済', doc_number: 'INV-TEST-001' },
    { id: 'd2', order_id: null, doc_type: '請求書', status: '発行済', doc_number: 'INV-TEST-002' },
    { id: 'd3', order_id: 'o3', doc_type: '請求書', status: '取消', doc_number: 'INV-TEST-003' },
    { id: 'd4', order_id: 'o4', doc_type: '納品書', status: '発行済', doc_number: 'DLV-TEST-004' },
  ];
  const LINKS = [{ order_id: 'o1', document_id: 'd1' }, { order_id: 'o2', document_id: 'd2' }, { order_id: 'o3', document_id: 'd3' }, { order_id: 'o4', document_id: 'd4' }];
  const net = { posts: [], failDocs: false };
  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = (x, s) => rt.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(x) });
    const inIds = (k) => ((url.match(new RegExp(k + '=in\\.\\(([^)]*)\\)')) || [])[1] || '').split(',').filter(Boolean);
    if (m !== 'GET') { net.posts.push(url.split('/rest/v1/')[1].split('?')[0]); return J([{ id: 'new' }], 201); }
    if (/\/customers\b/.test(url)) return J([CUST]);
    if (/\/orders\b/.test(url) && /order_items/.test(url)) return J(ORDERS);
    if (/\/documents\b/.test(url) && /order_id=in/.test(url)) {
      if (net.failDocs) return J({ message: 'boom' }, 500);
      const ids = inIds('order_id');
      let r = DOCS.filter(d => ids.includes(d.order_id));
      if (/doc_type=eq\.請求書/.test(url)) r = r.filter(d => d.doc_type === '請求書');
      if (/status=neq\.取消/.test(url)) r = r.filter(d => d.status !== '取消');
      return J(r);
    }
    if (/\/documents\b/.test(url) && /[?&]id=in/.test(url)) { const ids = inIds('id'); return J(DOCS.filter(d => ids.includes(d.id))); }
    if (/\/document_orders\b/.test(url)) {
      const ids = inIds('order_id');
      return J(LINKS.filter(l => ids.includes(l.order_id)).map(l => Object.assign({}, l, /documents\(/.test(url) ? { documents: DOCS.find(d => d.id === l.document_id) } : {})));
    }
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));
  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(700);
  await page.evaluate(() => { window.__alerts = []; window.alert = m => window.__alerts.push(String(m)); window.confirm = () => true; window.open = () => null; });
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

  // 1. 数え方
  const c1 = await page.evaluate(async () => (await invAliveInvoiceConflicts(['o1', 'o2', 'o3', 'o4'])).map(c => c.order_id + ':' + c.doc_number).sort());
  T('1. 単独・まとめた請求書（発行済）は数える', c1.join(',') === 'o1:INV-TEST-001,o2:INV-TEST-002', c1.join(','));
  T('1. 取消した請求書・納品書は数えない', !c1.some(x => /^o3|^o4/.test(x)), c1.join(','));
  const c2 = await page.evaluate(async () => (await invAliveInvoiceConflicts(['o1', 'o2'], 'd2')).map(c => c.order_id));
  T('1. 編集中の請求書そのもの（d2）は除ける', c2.join(',') === 'o1', c2.join(','));

  // 2. 確かめられなかったら発行しない
  net.failDocs = true;
  const g2 = await page.evaluate(async () => { window.__alerts = []; const ok = await invGuardNoDoubleInvoice(['o3'], id => id); return { ok, alerts: window.__alerts }; });
  net.failDocs = false;
  T('2. 確かめられないときは発行しない・理由を出す', g2.ok === false && g2.alerts.some(a => /確かめられなかった/.test(a)), JSON.stringify(g2));
  const g2b = await page.evaluate(async () => { window.__alerts = []; return await invGuardNoDoubleInvoice(['o3', 'o4'], id => id); });
  T('2. 請求書が無い注文（取消済み・納品書だけ）は発行してよい', g2b === true, String(g2b));

  // 3. 請求書作成タブの取り込み
  const pull = await page.evaluate(async () => {
    switchTab('invoice'); await new Promise(r => setTimeout(r, 200));
    document.getElementById('invCustomerId').value = 'cust-a';
    const per = document.getElementById('invPullPeriod'); if (per) { per.value = per.options[per.options.length - 1].value; }
    document.getElementById('invPullShowBilled').checked = true;
    await invPullSearch();
    const cbs = [...document.querySelectorAll('.inv-pull-cb')].map(cb => ({ i: cb.dataset.i, code: invPullOrders[+cb.dataset.i].order_code, dis: cb.disabled, on: cb.checked }));
    return cbs;
  });
  const billed = pull.filter(x => x.code === 'DIR-A001' || x.code === 'DIR-A002');
  const unb = pull.filter(x => x.code === 'DIR-A003' || x.code === 'DIR-A004');
  T('3. 請求済み（A001・A002）の✓は押せない', billed.length === 2 && billed.every(x => x.dis && !x.on), JSON.stringify(pull));
  T('3. 未請求（取消済みA003・納品書だけA004）は✓が付く', unb.length === 2 && unb.every(x => !x.dis && x.on), JSON.stringify(pull));
  const before = await page.evaluate(() => invLinkedOrderIds.slice());
  const ap = await page.evaluate(async () => {
    window.__alerts = [];
    document.querySelectorAll('.inv-pull-cb').forEach(cb => { cb.disabled = false; cb.checked = true; });   // 万一選ばれた状態
    await invPullApply();
    return { alerts: window.__alerts, linked: invLinkedOrderIds.slice() };
  });
  T('3. 請求済みが選ばれていても取り込まずに止める（取り込んだ注文は増えない）', ap.alerts.some(a => /もう請求書があります/.test(a) && /INV-TEST-001/.test(a)) && ap.linked.length === before.length, JSON.stringify(ap));
  T('3. 止める理由に納品書は出さない', ap.alerts.length && !ap.alerts.some(a => /DLV-TEST-004/.test(a)), JSON.stringify(ap.alerts));

  // 4. invIssue
  net.posts = [];
  const iss = await page.evaluate(async () => {
    window.__alerts = [];
    const orig = window.invCollect;
    window.invCollect = () => ({ name: '架空食堂', honorific: '様', date: '2026-11-08', due: '2026-12-31', customer_id: 'cust-a', order_ids: ['o2', 'o3'], lines: [{ name: 'レバー', qty: 2, unit: 'kg', price: 463, tax: 8 }], type: '請求書' });
    invType = '請求書'; invEditingId = null;
    try { await invIssue(); } finally { window.invCollect = orig; }
    return window.__alerts;
  });
  T('4. 取り込んだ注文にもう請求書があれば、請求書を保存しない', !net.posts.includes('documents') && iss.some(a => /INV-TEST-002/.test(a)), JSON.stringify([net.posts, iss]));

  // 5. 月まとめ
  net.posts = [];
  const bt = await page.evaluate(async () => {
    try { await invIssuePayloadNow({ type: '請求書', date: '2026-11-08', customer_id: 'cust-a', name: '架空食堂', honorific: '様', order_ids: ['o1', 'o3'], lines: [{ name: 'レバー', qty: 2, unit: 'kg', price: 463, tax: 8 }] }); return 'issued'; }
    catch (e) { return e.message; }
  });
  T('5. 月まとめ: 集計後にできた請求書があれば、その請求先は発行しない', /同じ注文の請求書がもうあります（INV-TEST-001）/.test(bt) && !net.posts.includes('documents'), bt + ' / ' + net.posts.join(','));

  T('ページエラーなし', errors.length === 0, errors.join(' / '));
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 260) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
