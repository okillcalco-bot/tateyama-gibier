// 請求先だけの相手（仲卸業者・運営会社）を選ぶ・検索すると、その相手あての出荷が出ない（2026-10-30 沖
// 「エフユーアイジャパンの納品記録がなくなってるんだけどなんで？」）
//
//   実測（本番・2026-10-30）
//     注文・出荷・請求書は1件も消えていなかった。注文は届け先の店の名義（customer_id＝店）で入り、
//     請求先は注文の備考か顧客の備考の印（wholesalerTagOf）で決まる。仲卸3社（トレタテ・ノブレス・エフユーアイ）は
//     自分名義の注文が0件・印の付いた店名義の注文が53件。そのため
//       - 請求書作成「注文から取り込む」で請求先にこの相手を選ぶ → 「納品済みの注文がありません」
//       - 書類発行の顧客の絞り込みに、この相手が出てこない
//       - 出荷データを「エフユーアイ」で検索 → 0件
//     となり、記録が消えたように見えていた。
//
//   ここで測ること（架空データ）
//     1. 請求書作成: 請求先に仲卸業者を選ぶと、印の付いた店名義の注文（注文の備考・顧客の備考の両方）が出る。
//        注文の備考の印が優先（備考「トレタテ」の店の注文は、顧客の備考がエフユーアイでも出さない）。届け先の店名も出る
//     2. 請求済みで隠れているときは、どの請求書に入っているか（番号）を出す。表示にすると「請求済 番号」
//     3. 取り込むと宛名は仲卸業者のまま・備考に【出荷内訳】
//     4. 普通の顧客は従来どおり customer_id だけで探す（自分の注文だけ）
//     5. 書類発行: 仲卸業者が顧客の候補に出て、選ぶと印の付いた注文が「（請求先: …）」付きで出る
//     6. 出荷データ: 請求先名・備考でも検索でき、店名の下に「請求先: …」が出る
//     7. 出荷データの読込エラーは、顧客を読み込んだ後の描き直しで消さない（サイレント失敗にしない）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const FUI = 'エフユーアイジャパン';
const CUSTOMERS = [
  { id: 'c-fui', code: 'C9003', name: FUI, honorific: '御中', address: '東京都テスト区1-1', is_active: true, notes: '', search_aliases: [] },
  { id: 'c-tt', code: 'C9001', name: 'トレタテ', honorific: '御中', address: '東京都テスト区2-2', is_active: true, notes: '', search_aliases: [] },
  { id: 'c-a', code: 'C9101', name: 'A食堂', honorific: '様', address: '東京都テスト区3-3', is_active: true, notes: `${FUI}（請求先）`, search_aliases: [] },
  { id: 'c-b', code: 'C9102', name: 'B商店', honorific: '様', address: '東京都テスト区4-4', is_active: true, notes: '', search_aliases: [] },
  { id: 'c-c', code: 'C9103', name: 'C亭', honorific: '様', address: '東京都テスト区5-5', is_active: true, notes: `${FUI}`, search_aliases: [] },
  { id: 'c-d', code: 'C9104', name: 'D屋', honorific: '様', address: '千葉県テスト市6-6', is_active: true, notes: '', search_aliases: [] },
];
const item = (id, part, kg, sub) => ({ id, inventory_id: null, species: 'イノシシ', part_name: part, weight_kg: kg, weight: kg, subtotal: sub, amount: sub, grade_snapshot: '並' });
const ORDERS = [
  { id: 'o-a', customer_id: 'c-a', customer_name: 'A食堂', order_code: 'DIR-T-A', order_date: '2026-09-15', delivery_date: '2026-09-15', status: '発送済', total_amount: 7600, memo: null, created_at: '2026-09-15T03:00:00Z', order_items: [item('ia', 'ロース', 2, 7600)], shipments: [{ freight: 1300, size_code: 100, is_cool: true }] },
  { id: 'o-b', customer_id: 'c-b', customer_name: 'B商店', order_code: 'DIR-T-B', order_date: '2026-09-23', delivery_date: '2026-09-23', status: '発送済', total_amount: 6200, memo: FUI, created_at: '2026-09-23T03:00:00Z', order_items: [item('ib', 'バラ', 2, 6200)], shipments: [{ freight: 1740, size_code: 120, is_cool: true }] },
  { id: 'o-c', customer_id: 'c-c', customer_name: 'C亭', order_code: 'DIR-T-C', order_date: '2026-09-20', delivery_date: '2026-09-20', status: '発送済', total_amount: 3800, memo: 'トレタテ', created_at: '2026-09-20T03:00:00Z', order_items: [item('ic', 'ロース', 1, 3800)], shipments: [] },
  { id: 'o-d', customer_id: 'c-d', customer_name: 'D屋', order_code: 'DIR-T-D', order_date: '2026-09-18', delivery_date: '2026-09-18', status: '発送済', total_amount: 5000, memo: null, created_at: '2026-09-18T03:00:00Z', order_items: [item('id', 'モモ', 2, 5000)], shipments: [] },
  { id: 'o-x', customer_id: 'c-b', customer_name: 'B商店', order_code: 'DIR-T-X', order_date: '2026-09-16', delivery_date: '2026-09-16', status: 'キャンセル', total_amount: 9999, memo: FUI, created_at: '2026-09-16T03:00:00Z', order_items: [], shipments: [] },
];
const SHIPMENTS = ORDERS.filter(o => o.status === '発送済').map(o => ({
  id: 's-' + o.id, shipment_date: o.order_date, status: '発送済', freight: (o.shipments[0] || {}).freight ?? null,
  orders: { order_code: o.order_code, customer_name: o.customer_name, customer_id: o.customer_id, order_date: o.order_date, memo: o.memo, order_items: o.order_items.map(i => ({ ...i, inventory: null })) },
}));

// PostgREST の絞り込みを最小限まねる（画面が組んだ条件が正しいかも一緒に測るため、条件は無視しない）
function splitTop(s) { const out = []; let d = 0, cur = ''; for (const ch of s) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { out.push(cur); cur = ''; } else cur += ch; } if (cur) out.push(cur); return out; }
function cond(o, c) {
  const m = /^(\w+)\.(eq|in|like)\.(.*)$/.exec(c); if (!m) throw new Error('未対応の条件: ' + c);
  const [, col, op, val] = m; const v = o[col] == null ? '' : String(o[col]);
  if (op === 'eq') return v === val;
  if (op === 'in') return val.replace(/^\(|\)$/g, '').split(',').includes(v);
  return new RegExp('^' + val.split('*').map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(v);
}
function filterOrders(url) {
  const p = url.searchParams; let rows = ORDERS.slice();
  const st = p.get('status'); if (st) { const ss = st.replace(/^in\.\(|\)$/g, '').split(','); rows = rows.filter(o => ss.includes(o.status)); }
  for (const d of p.getAll('order_date')) { const [op, v] = d.split('.'); rows = rows.filter(o => op === 'gte' ? o.order_date >= v : o.order_date <= v); }
  const cid = p.get('customer_id'); if (cid) rows = rows.filter(o => cond(o, 'customer_id.' + cid));
  const or = p.get('or'); if (or) { const cs = splitTop(or.replace(/^\(|\)$/g, '')); rows = rows.filter(o => cs.some(c => cond(o, c))); }
  return rows;
}

async function openPage(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date('2026-10-30T03:00:00Z'));
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.dismiss());
  const state = { links: [], orderUrls: [] };
  await page.route('**/rest/v1/**', route => {
    const u = new URL(route.request().url()), m = route.request().method();
    const J = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (m !== 'GET') return J([]);
    const t = u.pathname.split('/').pop();
    if (t === 'customers') return J(CUSTOMERS);
    if (t === 'shipments') return opts.shipFail ? route.fulfill({ status: 500, body: 'boom' }) : J(SHIPMENTS);
    if (t === 'orders') { state.orderUrls.push(decodeURIComponent(u.search)); return J(filterOrders(u)); }
    if (t === 'document_orders') { const ids = (u.searchParams.get('order_id') || '').replace(/^in\.\(|\)$/g, '').split(','); return J(state.links.filter(l => ids.includes(l.order_id))); }
    if (t === 'documents') { const ids = (u.searchParams.get('id') || '').replace(/^in\.\(|\)$/g, '').split(','); return J([{ id: 'd1', status: '発行済', doc_number: 'INV-TEST-016', doc_type: '請求書' }].filter(d => ids.includes(d.id))); }
    return J([]);
  });
  await page.addInitScript(() => { try { localStorage.setItem('tg_staff_key', 'TESTKEY'); } catch (e) {} });
  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(700);
  return { ctx, page, errors, state };
}
async function typeIn(page, sel, v) { await page.fill(sel, v); await page.dispatchEvent(sel, 'input'); }

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const out = []; const ck = (n, c, e) => out.push([n, !!c, e == null ? '' : String(e)]);
  const { ctx, page, errors, state } = await openPage(browser);

  // 6. 出荷データ（最初に開くタブ）
  const shipRows = async q => { await typeIn(page, '#shipDataSearch', q); return page.$$eval('#shipDataBody tr', trs => trs.map(tr => tr.children[1] ? tr.children[1].innerText.replace(/\s+/g, ' ').trim() : tr.innerText.trim())); };
  const s1 = await shipRows('エフユーアイ');
  ck('出荷データ: 「エフユーアイ」で、印の付いた店の出荷（注文の備考・顧客の備考の両方）が出る', s1.length === 2 && s1.some(t => /A食堂/.test(t)) && s1.some(t => /B商店/.test(t)), JSON.stringify(s1));
  ck('出荷データ: 店名の下に「請求先: エフユーアイジャパン」', s1.every(t => /請求先: エフユーアイジャパン/.test(t)), JSON.stringify(s1));
  const s2 = await shipRows('トレタテ');
  ck('出荷データ: 注文の備考の印が優先（C亭は顧客の備考がエフユーアイでもトレタテあて）', s2.length === 1 && /C亭/.test(s2[0]) && /請求先: トレタテ/.test(s2[0]), JSON.stringify(s2));
  const s3 = await shipRows('D屋');
  ck('出荷データ: 印の無い店は従来どおり（請求先の行なし）', s3.length === 1 && !/請求先/.test(s3[0]), JSON.stringify(s3));
  const s4 = await shipRows('DIR-T-B');
  ck('出荷データ: 注文番号の検索も従来どおり', s4.length === 1 && /B商店/.test(s4[0]), JSON.stringify(s4));
  await typeIn(page, '#shipDataSearch', '');

  // 1. 請求書作成 → 注文から取り込む（請求先に仲卸業者）
  await page.evaluate(() => switchTab('invoice')); await page.waitForTimeout(300);
  await typeIn(page, '#invCustomerInput', `C9003 ${FUI}`);
  await page.evaluate(() => { document.getElementById('invPullBox').open = true; });
  await page.selectOption('#invPullPeriod', 'all');
  state.orderUrls.length = 0;
  await page.evaluate(() => invPullSearch()); await page.waitForTimeout(300);
  const pull = await page.evaluate(() => ({ codes: invPullOrders.map(o => o.order_code), res: document.getElementById('invPullResult').textContent, list: document.getElementById('invPullList').innerText }));
  const q1 = state.orderUrls[0] || '';
  ck('取り込み: 仲卸業者を選ぶと、印の付いた店名義の注文が出る（A食堂＝顧客の備考・B商店＝注文の備考）', JSON.stringify(pull.codes) === JSON.stringify(['DIR-T-A', 'DIR-T-B']), JSON.stringify(pull));
  ck('取り込み: 備考「トレタテ」の店の注文・キャンセル・印の無い店は出ない', !pull.codes.includes('DIR-T-C') && !pull.codes.includes('DIR-T-X') && !pull.codes.includes('DIR-T-D'), JSON.stringify(pull.codes));
  ck('取り込み: DBへの条件は 自分名義 or 備考の印 or 印のある店（or=）', /or=\(customer_id\.eq\.c-fui,memo\.like\.\*エフユーアイジャパン\*,customer_id\.in\.\(c-a,c-c\)\)/.test(q1), q1);
  ck('取り込み: 届け先の店名が行に出る', /届け先 A食堂/.test(pull.list) && /届け先 B商店/.test(pull.list), pull.list);
  ck('取り込み: 件数の表示（未請求2件・合計13,800円）', /未請求 2件/.test(pull.res) && /13,800/.test(pull.res), pull.res);

  // 3. 取り込むと宛名は仲卸業者のまま・備考に出荷内訳
  await page.evaluate(() => invPullApply()); await page.waitForTimeout(300);
  const ap = await page.evaluate(() => ({ id: invGv('invCustomerId'), name: invGv('invName'), memo: document.getElementById('invMemo').value, lines: invLines.map(l => l.name) }));
  ck('取り込み後: 宛名はエフユーアイジャパンのまま・備考に【出荷内訳】（A食堂・B商店）', ap.id === 'c-fui' && ap.name === FUI && /【出荷内訳】/.test(ap.memo) && /A食堂/.test(ap.memo) && /B商店/.test(ap.memo), JSON.stringify(ap));
  ck('取り込み後: 明細に2件分の部位と送料', ap.lines.some(n => /ロース/.test(n)) && ap.lines.some(n => /バラ/.test(n)) && ap.lines.filter(n => /送料/.test(n)).length === 2, JSON.stringify(ap.lines));

  // 2. 請求済みで隠れているとき
  state.links = [{ order_id: 'o-a', document_id: 'd1' }, { order_id: 'o-b', document_id: 'd1' }];
  await page.evaluate(() => invPullSearch()); await page.waitForTimeout(300);
  const billed = await page.evaluate(() => ({ n: invPullOrders.length, res: document.getElementById('invPullResult').textContent }));
  ck('請求済みで隠れているときは、何件がどの請求書に入っているかを出す', billed.n === 0 && /請求済み 2件/.test(billed.res) && /INV-TEST-016/.test(billed.res), JSON.stringify(billed));
  await page.check('#invPullShowBilled'); await page.waitForTimeout(300);
  const shown = await page.evaluate(() => ({ codes: invPullOrders.map(o => o.order_code), list: document.getElementById('invPullList').innerText }));
  ck('「請求済みも表示」で2件が「請求済 INV-TEST-016」付きで出る', shown.codes.length === 2 && (shown.list.match(/請求済 INV-TEST-016/g) || []).length === 2, JSON.stringify(shown));
  await page.uncheck('#invPullShowBilled');
  state.links = [];

  // 4. 普通の顧客は従来どおり
  await page.evaluate(() => invResetForm && invResetForm());
  await typeIn(page, '#invCustomerInput', 'C9104 D屋');
  state.orderUrls.length = 0;
  await page.evaluate(() => invPullSearch()); await page.waitForTimeout(300);
  const dq = state.orderUrls[0] || '';
  const dres = await page.evaluate(() => invPullOrders.map(o => o.order_code));
  ck('普通の顧客: customer_id だけで探し（or= を使わない）、自分の注文だけ', /customer_id=eq\.c-d/.test(dq) && !/or=/.test(dq) && JSON.stringify(dres) === JSON.stringify(['DIR-T-D']), dq + ' ' + JSON.stringify(dres));
  await typeIn(page, '#invCustomerInput', 'C9101 A食堂');
  await page.evaluate(() => invPullSearch()); await page.waitForTimeout(300);
  ck('店を選んだときも従来どおり、その店の注文が出る（エフユーアイあてでも）', JSON.stringify(await page.evaluate(() => invPullOrders.map(o => o.order_code))) === JSON.stringify(['DIR-T-A']), '');

  // 5. 書類発行
  await page.evaluate(() => switchTab('documents')); await page.waitForTimeout(300);
  await page.selectOption('#docPeriod', 'lastMonth'); await page.waitForTimeout(400);
  const opts = await page.$$eval('#docCustomer option', os => os.map(o => o.textContent.trim()));
  ck('書類発行: 先月の顧客の候補にエフユーアイジャパン・トレタテ（印の付いた注文がある）が出る', opts.includes(`C9003 ${FUI}`) && opts.includes('C9001 トレタテ'), JSON.stringify(opts));
  state.orderUrls.length = 0;
  await page.evaluate(() => { const s = document.getElementById('docCustomer'); [...s.options].forEach(o => { o.selected = o.value === 'c-fui'; }); return loadDocOrders(); });
  await page.waitForTimeout(300);
  const docTxt = await page.innerText('#docOrderList');
  ck('書類発行: エフユーアイジャパンを選ぶと A食堂・B商店 の注文が「（請求先: エフユーアイジャパン）」付きで出る',
    /A食堂（請求先: エフユーアイジャパン）/.test(docTxt) && /B商店（請求先: エフユーアイジャパン）/.test(docTxt) && !/C亭/.test(docTxt) && !/D屋/.test(docTxt), docTxt);
  ck('書類発行: 仲卸業者を選んだときは期間で読んでから絞る（customer_id=eq.c-fui で0件にしない）', !/customer_id=eq\.c-fui/.test(state.orderUrls[0] || ''), state.orderUrls[0]);
  await page.evaluate(() => { const s = document.getElementById('docCustomer'); [...s.options].forEach(o => { o.selected = o.value === 'c-d'; }); return loadDocOrders(); });
  await page.waitForTimeout(300);
  const docD = await page.innerText('#docOrderList');
  ck('書類発行: 普通の顧客は従来どおり自分の注文だけ', /D屋/.test(docD) && !/A食堂|B商店|C亭/.test(docD), docD);
  ck('ページのエラーなし', errors.length === 0, errors.join(' / '));
  await ctx.close();

  // 7. 出荷データの読込エラーを消さない
  const f = await openPage(browser, { shipFail: true });
  const errTxt = await f.page.innerText('#shipDataBody');
  ck('出荷データ: 読込エラーは顧客の読み込み後も「読み込みエラー」のまま（該当なしに化けない）', /読み込みエラー/.test(errTxt), errTxt);
  await f.ctx.close();

  await browser.close();
  let pass = 0; for (const [n, ok, e] of out) { console.log(`${ok ? '✅' : '❌'} ${n}${ok ? '' : '  → ' + e}`); if (ok) pass++; }
  console.log(`\n${pass}/${out.length} passed`);
  process.exit(pass === out.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
