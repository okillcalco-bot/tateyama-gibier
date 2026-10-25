// 会計画面（finance.html）の通し：DB関数はすべてモック（架空データ）。本番にはつながない。
//   1. キー: 無ければ入力を求める／違うキーは理由を出す／スタッフと税理士（閲覧専用）で画面が変わる
//   2. ダッシュボード: 口座ごとの残高・未入金・やること（未消込・未分類・未確認）の件数
//   3. 銀行: CSV 取込（列の当たり→確認→件数→取込）、PDF 取込（未登録の口座はその場で登録。検算OKのときだけ取り込める）、出金の科目付け・候補
//   4. 部門: 右上で絞ると一覧・ダッシュボードが変わる。明細1件ずつ別の部門に付け替えられる
//   5. 入金消込: 自動をまとめて確定／候補から選んで確定（名義が登録される）／請求書でない入金に科目
//   6. 未入金・督促: 取引先ごとの一覧→文面→送った記録
//   7. カード: CSV 取込（部門つき）→科目付け
//   8. 領収書: 写真つき登録（縮小して base64 で送る）→確認済に
//   9. 月次: 集計・仕訳（部門列つき）・CSV（5つ）
//  10. 設定: 部門・口座・カードの一覧、勘定科目の追加・保存、閲覧専用キーの発行は管理者だけ
//  11. 失敗は画面に出る（黙って成功にしない）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const FC = require(path.resolve(__dirname, '../../finance-core.js'));

(async () => {
  const root = path.resolve(__dirname, '../..');
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/finance.html';
    r.setHeader('content-type', p.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9151);
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const out = []; const ck = (n, c, e) => out.push([n, !!c, e == null ? '' : String(e)]);
  const ctx = await b.newContext({ viewport: { width: 1200, height: 900 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  p.on('dialog', d => d.accept());

  // ── 架空のDB ──
  const S = {
    departments: [{ code: 'gibier', name: '館山ジビエセンター', short_name: 'ジビエ', mark: 'T', sort: 10, is_active: true, report_to: '館山市（通帳の報告義務）' }, { code: 'arco', name: '合同会社アルコ（本体）', short_name: 'アルコ', mark: 'ア', sort: 20, is_active: true, report_to: null }],
    accounts: [{ id: 'acc1', bank_name: '千葉銀行', branch: '館山支店', account_type: '普通', account_no: '0000001', label: 'ジビエ口座', department: 'gibier', is_active: true }],
    cards: [{ card_name: 'テストカード', label: null, department: 'gibier', is_active: true }],
    titles: FC.DEFAULT_TITLES.map(t => Object.assign({ is_active: true }, t)),
    bank: [
      { id: 'b1', account_id: 'acc1', txn_date: '2026-10-01', description: 'カ）テストショウテン', amount_in: 12000, amount_out: 0, balance: 1012000, matched_docs: [], category_code: null, memo: null, department_override: null },
      { id: 'b2', account_id: 'acc1', txn_date: '2026-10-02', description: 'テストガス', amount_in: 0, amount_out: 3000, balance: 1009000, matched_docs: [], category_code: null, memo: null, department_override: null },
      { id: 'b3', account_id: 'acc1', txn_date: '2026-10-03', description: 'ホジヨキン', amount_in: 50000, amount_out: 0, balance: 1059000, matched_docs: [], category_code: null, memo: null, department_override: null },
      { id: 'b4', account_id: 'acc1', txn_date: '2026-10-04', description: 'ヤマキ　タロウ', amount_in: 4869, amount_out: 0, balance: 1063869, matched_docs: [], category_code: null, memo: null, department_override: null },
      { id: 'b5', account_id: 'acc1', txn_date: '2026-10-05', description: 'テストシヨクドウ', amount_in: 8000, amount_out: 0, balance: 1071869, matched_docs: [{ doc_number: 'INV-T-0', customer_name: '架空食堂', amount: 8000, fee: 0, method: 'auto' }], category_code: null, memo: null, department_override: null },
    ],
    card: [{ id: 'c1', txn_date: '2026-10-03', description: 'ガソリン', amount: 5500, card_name: 'テストカード', category_code: null, memo: null, department_override: null }],
    receipts: [], files: {}, payments: [],
    invoices: [
      { id: 'd1', doc_number: 'INV-T-1', customer_id: 'cu1', partner_name: '架空商店', issue_date: '2026-10-06', due_date: '2026-11-30', total_amount: 12000, paid: 0, department: 'gibier' },
      { id: 'd2', doc_number: 'INV-T-2', customer_id: 'cu2', partner_name: 'ビストロ架空', issue_date: '2026-09-06', due_date: '2026-10-10', total_amount: 4869, paid: 0, department: 'gibier' },
      { id: 'd3', doc_number: 'INV-T-3', customer_id: 'cu2', partner_name: 'ビストロ架空', issue_date: '2026-10-06', due_date: '2026-11-30', total_amount: 20000, paid: 0, department: 'gibier' },
    ],
    customers: [{ id: 'cu1', name: '架空商店', kana: 'ｶ)ﾃｽﾄｼｮｳﾃﾝ', aliases: [] }, { id: 'cu2', name: 'ビストロ架空', kana: null, aliases: [] }],
    aliases: [], events: [], viewerKey: null, failNext: null,
  };
  const calls = [];
  const role = k => (k === 'STAFF' ? 'staff' : k === 'VIEW' ? 'viewer' : null);
  const needStaff = k => { if (k !== 'STAFF') throw new Error('スタッフキーが違います'); };
  const needAny = k => { if (!role(k)) throw new Error('キーが違います'); return role(k); };
  const acc = id => S.accounts.find(a => a.id === id);
  const bankDept = x => x.department_override || (acc(x.account_id) || {}).department || 'gibier';
  const cardDept = x => x.department_override || (S.cards.find(c => c.card_name === x.card_name) || {}).department;
  const bankRow = x => Object.assign({}, x, { account_label: (acc(x.account_id) || {}).label, account_department: (acc(x.account_id) || {}).department, department: bankDept(x), receipt_id: (S.receipts.find(r => r.bank_transaction_id === x.id && r.status !== 'rejected') || {}).id || null });
  const cardRow = x => Object.assign({}, x, { department: cardDept(x), receipt_id: (S.receipts.find(r => r.card_transaction_id === x.id && r.status !== 'rejected') || {}).id || null });
  const unpaid = (dep) => S.invoices.filter(v => v.total_amount - v.paid > 0 && (!dep || v.department === dep)).map(v => ({ document_id: v.id, doc_number: v.doc_number, customer_id: v.customer_id, customer_code: 'C' + v.customer_id, customer_name: v.partner_name, issue_date: v.issue_date, due_date: v.due_date, total: v.total_amount, paid: v.paid, remain: v.total_amount - v.paid, days_overdue: v.due_date < '2026-10-23' ? 13 : 0, dunning_count: S.events.filter(e => e.kind === 'dunning' && e.docs.includes(v.id)).length, department: v.department }));
  const H = {
    finance_role: a => needAny(a.p_key),
    finance_setup: a => ({ role: needAny(a.p_key), departments: S.departments, accounts: S.accounts, cards: S.cards, titles: S.titles }),
    finance_titles: a => { needAny(a.p_key); return S.titles; },
    finance_overview: a => { const r = needAny(a.p_key); const dep = a.p_department || null; const u = unpaid(dep);
      const accs = S.accounts.filter(x => !dep || x.department === dep).map(x => { const bs = S.bank.filter(y => y.account_id === x.id); const l = bs[bs.length - 1]; return { id: x.id, label: x.label, bank_name: x.bank_name, department: x.department, latest: l ? { date: l.txn_date, balance: l.balance } : null }; });
      const bk = S.bank.filter(x => !dep || bankDept(x) === dep);
      return { role: r, department: dep, accounts: accs, months: [{ month: '2026-09', amount_in: 100000, amount_out: 80000 }, { month: '2026-10', amount_in: bk.reduce((s, x) => s + x.amount_in, 0), amount_out: bk.reduce((s, x) => s + x.amount_out, 0) }],
        unpaid: { count: u.length, total: u.reduce((s, x) => s + x.remain, 0), overdue_count: u.filter(x => x.days_overdue > 0).length, overdue_total: u.filter(x => x.days_overdue > 0).reduce((s, x) => s + x.remain, 0) },
        pending: { bank_in_unmatched: bk.filter(x => x.amount_in > 0 && !x.matched_docs.length && !x.category_code).length, bank_out_unclassified: bk.filter(x => x.amount_out > 0 && !x.category_code).length, card_unclassified: S.card.filter(x => !x.category_code && (!dep || cardDept(x) === dep)).length, receipts_pending: S.receipts.filter(x => x.status === 'pending' && (!dep || (x.department || 'gibier') === dep)).length }, last_import: null }; },
    finance_bank_list: a => { needAny(a.p_key); if (S.failNext === 'bank') { S.failNext = null; throw new Error('わざと失敗'); } return S.bank.filter(x => x.txn_date >= a.p_from && x.txn_date <= a.p_to && (!a.p_department || bankDept(x) === a.p_department) && (!a.p_account || x.account_id === a.p_account)).map(bankRow); },
    finance_card_list: a => { needAny(a.p_key); return S.card.filter(x => x.txn_date >= a.p_from && x.txn_date <= a.p_to && (!a.p_department || cardDept(x) === a.p_department)).map(cardRow); },
    finance_receipts_list: a => { needAny(a.p_key); return S.receipts.filter(r => (!a.p_status || r.status === a.p_status) && (!a.p_from || r.receipt_date >= a.p_from) && (!a.p_to || r.receipt_date <= a.p_to) && (!a.p_department || (r.department || 'gibier') === a.p_department)); },
    finance_receipt_file: a => { needAny(a.p_key); const f = S.files[a.p_receipt]; return f ? { ok: true, mime: f.mime, base64: f.base64, size_bytes: f.size } : { ok: false, reason: 'ファイルがありません' }; },
    finance_month: a => { needAny(a.p_key); return { month: a.p_month, department: a.p_department || null, bank: H.finance_bank_list({ p_key: a.p_key, p_from: a.p_month + '-01', p_to: a.p_month + '-31', p_department: a.p_department }), card: H.finance_card_list({ p_key: a.p_key, p_from: a.p_month + '-01', p_to: a.p_month + '-31', p_department: a.p_department }), receipts: H.finance_receipts_list({ p_key: a.p_key, p_department: a.p_department }), titles: S.titles, invoices: S.invoices.filter(v => v.issue_date.startsWith(a.p_month) && (!a.p_department || v.department === a.p_department)).map(v => ({ doc_number: v.doc_number, customer_name: v.partner_name, total: v.total_amount, tax: 0, department: v.department })) }; },
    staff_unpaid_list_any: a => { needAny(a.p_key); return unpaid(a.p_department || null); },
    staff_department_set: a => { needStaff(a.p_staff_key); let n = 0; a.p_rows.forEach(x => { if (!/^[a-z][a-z0-9_]*$/.test(x.code) || !x.name) return; const d = S.departments.find(y => y.code === x.code); if (d) Object.assign(d, x); else S.departments.push(Object.assign({ is_active: true }, x)); n++; }); return { ok: true, count: n }; },
    staff_account_set: a => { needStaff(a.p_staff_key); const x = a.p_account; if (!x.bank_name || !x.account_no) throw new Error('銀行名と口座番号は必要です'); if (!x.label) throw new Error('口座の呼び名を入れてください'); if (!S.departments.some(d => d.code === x.department)) throw new Error('部門を選んでください');
      let e = S.accounts.find(y => y.bank_name === x.bank_name && y.account_no === x.account_no); if (e) Object.assign(e, x); else { e = Object.assign({ id: 'acc' + (S.accounts.length + 1), is_active: true }, x); S.accounts.push(e); } return { ok: true, id: e.id }; },
    staff_card_set: a => { needStaff(a.p_staff_key); let c = S.cards.find(y => y.card_name === a.p_card_name); if (c) Object.assign(c, { label: a.p_label, department: a.p_department, is_active: a.p_is_active !== false }); else S.cards.push({ card_name: a.p_card_name, label: a.p_label, department: a.p_department, is_active: true }); return { ok: true }; },
    staff_bank_import: a => { needStaff(a.p_staff_key); const ac = acc(a.p_account); if (!ac) throw new Error('口座を選んでください（設定で登録できます）'); const bad = a.p_rows.filter(r => !/^\d{4}-\d{2}-\d{2}$/.test(r.txn_date)); if (bad.length) return { ok: false, invalid_rows: bad.map(r => r.row_no), row_count: a.p_rows.length };
      const same = r => x => x.account_id === ac.id && x.txn_date === r.txn_date && x.amount_in === r.amount_in && x.amount_out === r.amount_out && x.description === r.description;
      const dup = a.p_rows.filter(r => S.bank.some(same(r))).length;
      if (!a.p_commit) return { ok: true, preview: true, row_count: a.p_rows.length, new_count: a.p_rows.length - dup, dup_count: dup, account: ac.label };
      a.p_rows.forEach(r => { if (!S.bank.some(same(r))) S.bank.push({ id: 'bi' + S.bank.length, account_id: ac.id, txn_date: r.txn_date, description: r.description, amount_in: r.amount_in, amount_out: r.amount_out, balance: r.balance, matched_docs: [], category_code: null, memo: null, department_override: null }); });
      return { ok: true, preview: false, row_count: a.p_rows.length, new_count: a.p_rows.length - dup, dup_count: dup, account: ac.label }; },
    staff_card_import: a => { needStaff(a.p_staff_key); if (!S.cards.some(c => c.card_name === a.p_card_name)) { if (!a.p_department) throw new Error('このカードの部門を選んでください（はじめての取込）'); S.cards.push({ card_name: a.p_card_name, label: null, department: a.p_department, is_active: true }); }
      if (!a.p_commit) return { ok: true, preview: true, row_count: a.p_rows.length, new_count: a.p_rows.length, dup_count: 0 }; a.p_rows.forEach(r => S.card.push({ id: 'ci' + S.card.length, txn_date: r.txn_date, description: r.description, amount: r.amount, card_name: a.p_card_name, category_code: null, memo: null, department_override: null })); return { ok: true, preview: false, row_count: a.p_rows.length, new_count: a.p_rows.length, dup_count: 0 }; },
    staff_classify: a => { needStaff(a.p_staff_key); const list = a.p_kind === 'bank' ? S.bank : S.card; const x = list.find(r => r.id === a.p_txn); if (!x) throw new Error('明細が見つかりません'); if (a.p_department && !S.departments.some(d => d.code === a.p_department)) throw new Error('部門がありません'); x.category_code = a.p_category; x.memo = a.p_memo; x.department_override = a.p_department || null; return { ok: true }; },
    staff_receipt_add: a => { needStaff(a.p_staff_key); const id = 'r' + (S.receipts.length + 1); S.receipts.push(Object.assign({ id, status: 'pending', storage_path: null, uploaded_by: a.p_by, created_at: '2026-10-23' }, a.p_receipt)); return { ok: true, id }; },
    staff_receipt_file_put: a => { needStaff(a.p_staff_key); if (!a.p_base64) throw new Error('ファイルが空です'); S.files[a.p_receipt] = { mime: a.p_mime, base64: a.p_base64, size: Math.round(a.p_base64.length * 3 / 4) }; const r = S.receipts.find(x => x.id === a.p_receipt); r.storage_path = 'db:receipt_files/' + a.p_receipt; r.mime = a.p_mime; return { ok: true, size_bytes: S.files[a.p_receipt].size }; },
    staff_receipt_update: a => { needStaff(a.p_staff_key); const r = S.receipts.find(x => x.id === a.p_id); if (!r) throw new Error('領収書が見つかりません'); Object.assign(r, a.p_patch); return { ok: true }; },
    staff_titles_set: a => { needStaff(a.p_staff_key); let n = 0; a.p_rows.forEach(x => { if (!/^[a-z_]+\.[a-z0-9_]+$/.test(x.code) || !x.name) return; const t = S.titles.find(y => y.code === x.code); if (t) Object.assign(t, x); else S.titles.push(x); n++; }); return { ok: true, count: n }; },
    staff_recon_snapshot: a => { needStaff(a.p_staff_key); return { invoices: S.invoices.filter(v => v.total_amount - v.paid > 0), customers: S.customers, aliases: S.aliases, txns: S.bank.filter(x => x.amount_in > 0 && !x.matched_docs.length && !x.category_code).map(x => ({ id: x.id, txn_date: x.txn_date, description: x.description, amount_in: x.amount_in })), fee_tolerance: 1000 }; },
    staff_recon_confirm: a => { needStaff(a.p_staff_key); const x = S.bank.find(r => r.id === a.p_txn); const sum = a.p_allocs.reduce((s, al) => s + al.amount, 0); if (sum !== x.amount_in) throw new Error('入金額と充てた額が一致しません'); a.p_allocs.forEach(al => { const v = S.invoices.find(i => i.id === al.document_id); v.paid += al.amount + (al.fee || 0); x.matched_docs.push({ doc_number: v.doc_number, customer_name: v.partner_name, amount: al.amount, fee: al.fee || 0, method: a.p_method }); }); if (a.p_alias) S.aliases.push({ customer_id: S.invoices.find(i => i.id === a.p_allocs[0].document_id).customer_id, name: a.p_alias }); return { ok: true }; },
    staff_recon_undo: a => { needStaff(a.p_staff_key); const x = S.bank.find(r => r.id === a.p_txn); x.matched_docs.forEach(d => { const v = S.invoices.find(i => i.doc_number === d.doc_number); if (v) v.paid -= d.amount + d.fee; }); x.matched_docs = []; return { ok: true }; },
    staff_dunning_record: a => { needStaff(a.p_staff_key); S.events.push({ kind: 'dunning', docs: a.p_docs, channel: a.p_channel }); return { ok: true, round: S.events.filter(e => e.kind === 'dunning').length }; },
    staff_alias_set: a => { needStaff(a.p_staff_key); if (a.p_remove) S.aliases = S.aliases.filter(x => !(x.customer_id === a.p_customer && x.name === a.p_name)); else S.aliases.push({ customer_id: a.p_customer, name: a.p_name }); return { ok: true }; },
    admin_set_finance_viewer_key: a => { if (a.p_recovery_code !== 'RECOV') return false; S.viewerKey = a.p_new_key; return true; },
  };
  await p.route('**/rest/v1/rpc/**', rt => {
    const fn = rt.request().url().split('/rpc/')[1].split('?')[0]; const args = JSON.parse(rt.request().postData() || '{}'); calls.push([fn, args]);
    try { if (!H[fn]) throw new Error('unknown rpc ' + fn); const r = H[fn](args); rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(r === undefined ? null : r) }); }
    catch (e) { rt.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: e.message }) }); }
  });
  // pdf.js は CDN から取れないので、合成ページを返す偽物を差し込む（items は本物と同じ transform 形）
  await p.route('**/pdf.min.js', rt => rt.fulfill({ status: 200, contentType: 'application/javascript', body: `window.pdfjsLib={GlobalWorkerOptions:{},getDocument:function(){return {promise:Promise.resolve({numPages:1,getPage:function(){return Promise.resolve({getViewport:function(){return {width:595,height:842}},getTextContent:function(){return Promise.resolve({items:(window.__pdfItems||[]).map(function(i){return {str:i.str,transform:[1,0,0,1,i.x,i.y]}})})}})}})}}};` }));
  await p.route('**/fonts.googleapis.com/**', rt => rt.fulfill({ status: 200, contentType: 'text/css', body: '' }));

  await p.goto('http://localhost:9151/finance.html'); await p.waitForTimeout(600);
  const txt = sel => p.$eval(sel, el => el.innerText.replace(/\s+/g, ' ')).catch(() => '');
  const last = fn => calls.filter(c => c[0] === fn).slice(-1)[0];
  const shot = async name => { if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT + '/' + name + '.png', fullPage: true }); };

  // 1. キー
  ck('キーが無ければ入力を求める', await p.$('#modal.show #keyIn') !== null, '');
  await p.fill('#keyIn', 'WRONG'); await p.click('#modalBody .btn-gold'); await p.waitForTimeout(300);
  ck('違うキーは理由を出す', /キーが違います/.test(await txt('#keyMsg')), await txt('#keyMsg'));
  await p.fill('#keyIn', 'STAFF'); await p.fill('#opIn', 'テスト担当'); await p.click('#modalBody .btn-gold'); await p.waitForTimeout(900);
  ck('スタッフキーで入ると役割が「スタッフ」になり、担当者名と部門の選択が出る', (await txt('#roleBadge')) === 'スタッフ' && /テスト担当/.test(await txt('#whoami')) && (await p.$$eval('#deptSel option', os => os.map(o => o.textContent).join('|'))) === '全部門|T　館山ジビエセンター|ア　合同会社アルコ（本体）', await txt('#roleBadge'));

  // 2. ダッシュボード
  const dash = await txt('#sec-dash');
  ck('ダッシュボード: 口座ごとの残高・未入金（期日超過）・やることの件数', /ジビエ口座 ジビエ ¥1,071,869/.test(dash) && /未入金の請求書 ¥36,869 3件/.test(dash) && /うち期日超過 ¥4,869 1件/.test(dash)
    && /請求書に当てていない入金が 3件/.test(dash) && /科目を付けていない出金が 1件/.test(dash) && /科目を付けていない利用が 1件/.test(dash), dash.slice(0, 400));
  await shot('01-dash');

  // 3. 銀行: CSV 取込（口座が1つなら自動で選ぶ）
  await p.click('.tab[data-tab="bank"]'); await p.waitForTimeout(500);
  ck('銀行: 今月の明細が出る（口座と部門の列、消込済みの請求書の札、出金の科目選択）', (await p.$$('#bankBody tr')).length === 5 && /INV-T-0/.test(await txt('#bankBody')) && /ジビエ口座/.test(await txt('#bankBody')) && (await p.$('#bankBody select.catsel')) !== null, await txt('#bankBody'));
  ck('銀行: 「テストガス」の出金に科目の候補（水道光熱費）が出る', /候補: 水道光熱費/.test(await txt('#bankBody')), '');
  const csv = '取引日,摘要,お支払金額,お預り金額,残高\n2026/10/06,カ）シンキ,,7000,1078869\n2026/10/07,テストデンキ,2500,,1076369\n';
  await p.setInputFiles('#bankFile', { name: 'bank.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') }); await p.waitForTimeout(400);
  ck('銀行CSV: 列の当たりが付く（日付・摘要・入金・出金・残高）', (await p.$$eval('.bankmap', ss => ss.map(s => s.value).join(','))) === '0,1,3,2,,4', await p.$$eval('.bankmap', ss => ss.map(s => s.value).join(',')));
  await p.click('text=この列で読む'); await p.waitForTimeout(300);
  ck('銀行CSV: 確認表（2行・入金 7,000・出金 2,500）と口座（1つしかないので自動で選ばれる）', /2行・入金 ¥7,000・出金 ¥2,500/.test(await txt('#bankImportBox')) && (await p.$eval('#csvAccount', s => s.value)) === 'acc1', await txt('#bankImportBox'));
  await p.click('#bankImportBtn'); await p.waitForTimeout(400);
  ck('銀行CSV: まず件数（新規 2件）を出してから取り込む', /ジビエ口座 に 2行のうち 新規 2件/.test(await txt('#bankImportMsg')) && last('staff_bank_import')[1].p_commit === false && last('staff_bank_import')[1].p_account === 'acc1', await txt('#bankImportMsg'));
  await p.click('#bankImportMsg .btn-green'); await p.waitForTimeout(700);
  ck('銀行CSV: 取り込むと明細に増える（担当者名つき）', /取り込みました: 新規 2件/.test(await txt('#bankImportMsg')) && last('staff_bank_import')[1].p_commit === true && last('staff_bank_import')[1].p_by === 'テスト担当' && S.bank.length === 7, S.bank.length);
  // PDF 取込（偽 pdf.js）: 未登録の口座 → その場で登録 → 検算OK → 取込。壊れた残高は取り込めない
  const mk = (rows, accountLine) => { const H = 842, items = [{ str: '2026年10月23日13:34', x: 571, y: H - 41 }, { str: '金融機関名: 千葉銀行', x: 20, y: H - 80 }, { str: accountLine, x: 20, y: H - 100 }, { str: '照会期間:  2026年10月', x: 20, y: H - 120 }, { str: '入金金額合計: ' + rows.filter(r => r[1] === '入金').reduce((a, r) => a + r[2], 0).toLocaleString() + ' 円（全' + rows.filter(r => r[1] === '入金').length + '件）', x: 20, y: H - 161 }, { str: '出金金額合計: ' + rows.filter(r => r[1] === '出金').reduce((a, r) => a + r[2], 0).toLocaleString() + ' 円（全' + rows.filter(r => r[1] === '出金').length + '件）', x: 270, y: H - 161 }];
    ['取引区分', '取引日', '出金金額', '入金金額', '摘要', '残高'].forEach((h, k) => items.push({ str: h, x: [30, 120, 235, 350, 475, 640][k], y: H - 221 })); let y = 255;
    rows.forEach(r => { items.push({ str: r[3], x: 420, y: H - y }, { str: r[0], x: 105, y: H - (y + 16) }, { str: r[2].toLocaleString() + '円', x: r[1] === '出金' ? 246 : 360, y: H - (y + 16) }, { str: r[4].toLocaleString() + '円', x: 610, y: H - (y + 16) }); y += 51; }); return items; };
  await p.evaluate(items => { window.__pdfItems = items; }, mk([['2026/10/08', '入金', 9000, 'カ）ピ－ディ－エフ', 4300000], ['2026/10/09', '出金', 1500, 'テストツウシン', 4298500]], '口座:  館山支店 普通 3725493'));
  await p.setInputFiles('#bankFile', { name: 'tsucho.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fake') }); await p.waitForTimeout(700);
  ck('銀行PDF: 口座番号を読み取り、未登録なら登録の欄を出す（取込ボタンはまだ押せない）', /未登録の口座/.test(await txt('#bankImportBox')) && /館山支店 普通 3725493/.test(await txt('#bankImportBox')) && (await p.$eval('#bankImportBtn', b => b.disabled)), (await txt('#bankImportBox')).slice(0, 200));
  await p.fill('#newAccLabel', 'アルコ口座'); await p.selectOption('#newAccDept', 'arco'); await p.click('text=この口座を登録して続ける'); await p.waitForTimeout(500);
  ck('銀行PDF: 口座を登録すると（銀行・支店・番号・部門つき）取り込めるようになり、検算 OK が出る', last('staff_account_set')[1].p_account.account_no === '3725493' && last('staff_account_set')[1].p_account.department === 'arco' && last('staff_account_set')[1].p_account.branch === '館山支店' && /口座: アルコ口座 アルコ/.test(await txt('#bankImportBox')) && /✔ PDF の合計/.test(await txt('#bankImportBox')) && !(await p.$eval('#bankImportBtn', b => b.disabled)), JSON.stringify(last('staff_account_set')[1]));
  await p.click('#bankImportBtn'); await p.waitForTimeout(400); await p.click('#bankImportMsg .btn-green'); await p.waitForTimeout(700);
  ck('銀行PDF: アルコ口座に取り込まれる', last('staff_bank_import')[1].p_account === 'acc2' && S.bank.filter(x => x.account_id === 'acc2').length === 2, S.bank.length);
  await p.evaluate(items => { window.__pdfItems = items; }, mk([['2026/10/10', '入金', 9000, 'ズレ', 4310000], ['2026/10/11', '出金', 1500, 'ズレ2', 4308499]], '口座:  館山支店 普通 3725493'));
  await p.setInputFiles('#bankFile', { name: 'tsucho2.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fake') }); await p.waitForTimeout(700);
  ck('銀行PDF: 残高の繋がりが崩れていれば ✖ を出し、取込ボタンを押せない（登録済みの口座は自動で当たる）', /✖ 検算が合いません/.test(await txt('#bankImportBox')) && /口座: アルコ口座/.test(await txt('#bankImportBox')) && (await p.$eval('#bankImportBtn', b => b.disabled)), (await txt('#bankImportBox')).slice(0, 200));
  await shot('02-bank');
  // 出金の科目付け
  await p.click('#bankBody button:has-text("候補: 水道光熱費")'); await p.waitForTimeout(400);
  ck('銀行: 候補ボタンで科目が付く（staff_classify）', last('staff_classify')[1].p_kind === 'bank' && last('staff_classify')[1].p_txn === 'b2' && last('staff_classify')[1].p_category === 'expense.utilities', JSON.stringify(last('staff_classify')[1]));
  S.failNext = 'bank'; await p.click('#sec-bank button:has-text("更新")'); await p.waitForTimeout(400);
  ck('失敗は画面に出る（銀行の読み込みが失敗したら表に理由）', /読み込めませんでした: わざと失敗/.test(await txt('#bankBody')), await txt('#bankBody'));
  await p.click('#sec-bank button:has-text("更新")'); await p.waitForTimeout(400);

  // 4. 部門
  ck('全部門: 明細は2口座ぶん（7＋2＝9行）', (await p.$$('#bankBody tr')).length === 9 && /アルコ口座/.test(await txt('#bankBody')), (await p.$$('#bankBody tr')).length);
  await p.selectOption('#bankBody select.deptsel[data-id="b2"]', 'arco'); await p.waitForTimeout(400);
  ck('部門の付け替え: ジビエ口座の出金1件をアルコに（staff_classify に p_department）', last('staff_classify')[1].p_txn === 'b2' && last('staff_classify')[1].p_department === 'arco' && last('staff_classify')[1].p_category === 'expense.utilities', JSON.stringify(last('staff_classify')[1]));
  await p.selectOption('#deptSel', 'gibier'); await p.waitForTimeout(700);
  ck('右上で「ジビエ」に絞ると、銀行の明細はジビエ口座の分だけ（付け替えた1件は消える）', (await p.$$('#bankBody tr')).length === 6 && !/アルコ口座/.test(await txt('#bankBody')) && !/テストガス/.test(await txt('#bankBody')), (await p.$$('#bankBody tr')).length);
  await p.click('.tab[data-tab="dash"]'); await p.waitForTimeout(500);
  ck('ジビエに絞ったダッシュボード: 口座はジビエ口座だけ・未処理も部門ぶん', /ジビエ口座/.test(await txt('#dashAccounts')) && !/アルコ口座/.test(await txt('#dashAccounts')) && /（ジビエ）/.test(await txt('#dashDeptLabel')), await txt('#dashAccounts'));
  await p.selectOption('#deptSel', 'arco'); await p.waitForTimeout(500);
  ck('アルコに絞ると、アルコ口座だけになり、PDFで入れた未消込1件・未分類の出金1件と、付け替えた出金（科目つき）が部門の数に入る', /アルコ口座/.test(await txt('#dashAccounts')) && !/ジビエ口座/.test(await txt('#dashAccounts')) && /請求書に当てていない入金が 1件/.test(await txt('#dashTodo')) && /科目を付けていない出金が 1件/.test(await txt('#dashTodo')) && (await txt('#dashCards')).includes('今月の出金（通帳） ¥4,500'), await txt('#dashTodo') + ' | ' + await txt('#dashCards'));
  await p.selectOption('#deptSel', ''); await p.waitForTimeout(500);

  // 5. 入金消込
  await p.click('.tab[data-tab="recon"]'); await p.waitForTimeout(600);
  const rc = await txt('#reconBox');
  ck('消込: 自動1（名義一致）・候補1（金額だけ一致）・請求書なし（補助金・新規・PDF分）に分かれる', /自動で当たった 1件/.test(rc) && /候補から選ぶ 1件/.test(rc) && /請求書に当たらない入金 3件/.test(rc) && /カ）テストショウテン/.test(rc), rc.slice(0, 300));
  await p.click('text=まとめて確定'); await p.waitForTimeout(600);
  ck('消込: 自動をまとめて確定（method=auto・名義は登録しない）', last('staff_recon_confirm')[1].p_method === 'auto' && last('staff_recon_confirm')[1].p_txn === 'b1' && !last('staff_recon_confirm')[1].p_alias && S.invoices[0].paid === 12000, JSON.stringify(last('staff_recon_confirm')[1]));
  ck('消込: 確定した分は一覧から消え、自動の枠が無くなる', (await p.$('#rc-b1')) === null && !/自動で当たった 1件/.test(await txt('#reconBox')), '');
  await p.click('#rc-b4 button:has-text("この請求書に確定")'); await p.waitForTimeout(600);
  ck('消込: 候補を確定すると manual・振込名義を alias として登録', last('staff_recon_confirm')[1].p_method === 'manual' && last('staff_recon_confirm')[1].p_alias === 'ヤマキ　タロウ' && S.aliases.length === 1 && S.invoices[1].paid === 4869, JSON.stringify(last('staff_recon_confirm')[1]));
  await p.selectOption('#cat-b3', 'income.subsidy'); await p.click('#rc-b3 button:has-text("この科目で記録")'); await p.waitForTimeout(500);
  ck('消込: 請求書でない入金に科目を付ける（補助金）', last('staff_classify')[1].p_txn === 'b3' && last('staff_classify')[1].p_category === 'income.subsidy', '');
  await p.click('#sec-recon button:has-text("表示")'); await p.waitForTimeout(500);
  ck('消込: 最近の消込に取消ボタンがある', /INV-T-1/.test(await txt('#recentMatched')) && (await p.$('#recentMatched .btn-danger')) !== null, await txt('#recentMatched'));
  await shot('03-recon');

  // 6. 未入金・督促
  await p.click('.tab[data-tab="unpaid"]'); await p.waitForTimeout(500);
  const up = await txt('#unpaidBody');
  ck('未入金: 取引先ごとにまとまる（残っているのは INV-T-3 だけ・部門の札つき）', /ビストロ架空/.test(up) && /ジビエ/.test(up) && /INV-T-3 20,000/.test(up) && !/INV-T-1/.test(up), up);
  await p.click('#unpaidBody button:has-text("督促文")'); await p.waitForTimeout(300);
  ck('督促: 文面に取引先名・請求書・合計が入る', /ビストロ架空 御中/.test(await p.$eval('#dunText', t => t.value)) && /INV-T-3/.test(await p.$eval('#dunText', t => t.value)) && /合計 ¥20,000/.test(await p.$eval('#dunText', t => t.value)), (await p.$eval('#dunText', t => t.value)).slice(0, 120));
  await p.click('text=送った記録を残す'); await p.waitForTimeout(400);
  ck('督促: 送った記録（LINE・請求書の id）が残る', last('staff_dunning_record')[1].p_channel === 'line' && last('staff_dunning_record')[1].p_docs[0] === 'd3', JSON.stringify(last('staff_dunning_record')[1]));
  await shot('04-unpaid');

  // 7. カード（はじめてのカードは部門つきで取込）
  await p.click('.tab[data-tab="card"]'); await p.waitForTimeout(500);
  await p.fill('#cardName', '事業用カードB'); await p.selectOption('#cardDept', 'arco');
  await p.setInputFiles('#cardFile', { name: 'card.csv', mimeType: 'text/csv', buffer: Buffer.from('ご利用日,ご利用先,ご利用金額,支払区分\n2026/10/12,ホームセンター,3200,1回\n2026/10/13,返品,-1200,1回\n', 'utf8') }); await p.waitForTimeout(400);
  await p.click('#cardImportBox button:has-text("この列で読む")'); await p.waitForTimeout(300);
  ck('カードCSV: 利用額と返金が読める（2行・合計 2,000）', /2行・合計 ¥2,000/.test(await txt('#cardImportBox')), await txt('#cardImportBox'));
  await p.click('#cardImportBtn'); await p.waitForTimeout(400); await p.click('#cardImportMsg .btn-green'); await p.waitForTimeout(700);
  ck('カードCSV: カード名と部門つきで取り込め、カードが登録される', last('staff_card_import')[1].p_card_name === '事業用カードB' && last('staff_card_import')[1].p_department === 'arco' && last('staff_card_import')[1].p_commit === true && S.card.length === 3 && S.cards.some(c => c.card_name === '事業用カードB' && c.department === 'arco'), S.card.length);
  ck('カード: 一覧にカードの部門が出る（事業用カードB → アルコ）', /アルコ/.test(await txt('#cardBody')) && (await p.$$('#cardBody tr')).length === 3, await txt('#cardBody'));
  await p.selectOption('#cardBody select.catsel >> nth=0', 'expense.vehicle'); await p.waitForTimeout(400);
  ck('カード: 科目を付けられる', last('staff_classify')[1].p_kind === 'card' && last('staff_classify')[1].p_category === 'expense.vehicle', '');
  await shot('05-card');

  // 8. 領収書（写真つき・部門つき）
  await p.click('.tab[data-tab="receipts"]'); await p.waitForTimeout(400);
  const png = await p.evaluate(() => { const c = document.createElement('canvas'); c.width = 2400; c.height = 1800; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 2400, 1800); g.fillStyle = '#000'; g.font = '80px sans-serif'; g.fillText('RECEIPT 5,500', 100, 300); return c.toDataURL('image/png').split(',')[1]; });
  await p.setInputFiles('#rcFile', { name: 'receipt.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }); await p.waitForTimeout(800);
  ck('領収書: 写真は長辺1600pxの JPEG に縮小してから送る', /縮小済み/.test(await txt('#rcFileInfo')), await txt('#rcFileInfo'));
  await p.click('#rcMarks .mk:has-text("ア")'); await p.waitForTimeout(100);
  ck('領収書: レシートの印（T／ア…）のボタンで部門が選べる（ア → アルコ）', (await p.$eval('#rcDept', el => el.value)) === 'arco' && /ア/.test(await txt('#rcMarks .mk.on')) && (await p.$$('#rcMarks .mk')).length === 2, await txt('#rcMarks'));
  await p.selectOption('#rcDept', 'gibier'); await p.fill('#rcDate', '2026-10-03'); await p.fill('#rcVendor', 'ガソリンスタンド'); await p.fill('#rcAmount', '5500'); await p.selectOption('#rcCat', 'expense.vehicle'); await p.selectOption('#rcPaidBy', 'card');
  await p.click('#rcAddBtn'); await p.waitForTimeout(1200);
  const put = last('staff_receipt_file_put');
  ck('領収書: 台帳（部門つき）に登録してからファイル（JPEG・base64）を送る', last('staff_receipt_add')[1].p_receipt.vendor === 'ガソリンスタンド' && last('staff_receipt_add')[1].p_receipt.department === 'gibier' && last('staff_receipt_add')[1].p_receipt.amount === 5500 && put && put[1].p_mime === 'image/jpeg' && put[1].p_base64.length > 1000 && put[1].p_base64.length < 400000, put && put[1].p_base64.length);
  await p.waitForTimeout(500);
  ck('領収書: 未確認の一覧に出て、サムネイルが付く', (await p.$eval('#rcList input[data-f="vendor"]', el => el.value)) === 'ガソリンスタンド' && (await p.$('#rcList img.thumb')) !== null, (await txt('#rcList')).slice(0, 200));
  await p.click('#rcList button:has-text("明細に紐づける")'); await p.waitForTimeout(500);
  ck('領収書: 紐づけ候補に金額一致のカード明細（ガソリン 5,500）が上に出る', /ガソリン 5,500 金額一致/.test(await txt('#modalBody')), (await txt('#modalBody')).slice(0, 300));
  await p.check('#modalBody input[name="lk"] >> nth=0'); await p.click('#modalBody button:has-text("紐づける")'); await p.waitForTimeout(500);
  ck('領収書: カード明細に紐づく', S.receipts[0].card_transaction_id === 'c1' && /カード明細に紐づけ済/.test(await txt('#rcList')), JSON.stringify(S.receipts[0]));
  await shot('06-receipts');
  await p.click('#rcList button:has-text("確認済にする")'); await p.waitForTimeout(500);
  ck('領収書: 確認済にすると未確認の一覧から消え、件数が減る', S.receipts[0].status === 'confirmed' && /該当する領収書はありません/.test(await txt('#rcList')), '');
  // 8b. 内容だけ先に登録（写真なし）→ あとから「写真を付ける」
  await p.fill('#rcVendor', '写真はあとで'); await p.fill('#rcAmount', '1200'); await p.click('#rcAddBtn'); await p.waitForTimeout(900);
  ck('領収書: 写真なしでも内容だけ登録でき、一覧に「写真を付ける」が出る', S.receipts.length === 2 && !S.receipts[1].storage_path && (await p.$('#rcList button:has-text("写真を付ける")')) !== null, (await txt('#rcList')).slice(0, 200));
  await p.click('#rcList button:has-text("写真を付ける")'); await p.waitForTimeout(300);
  await p.setInputFiles('#rcAttachFile', { name: 'later.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }); await p.click('#rcAttachBtn'); await p.waitForTimeout(1500);
  ck('領収書: あとから写真を付けられる（縮小して送り、サムネイルが出て、ボタンが消える）', !!S.files[S.receipts[1].id] && S.files[S.receipts[1].id].mime === 'image/jpeg' && !!S.receipts[1].storage_path && (await p.$('#rcList img.thumb')) !== null && (await p.$('#rcList button:has-text("写真を付ける")')) === null, JSON.stringify(Object.keys(S.files)));
  // 8c. 写真の本体が Google ドライブにある領収書（storage_path が URL）→ 🔗 で新しいタブに開く。DBのファイル取得は呼ばない
  const driveUrl = 'https://drive.google.com/file/d/TESTFILEID/view';
  S.receipts.push({ id: 'r3', status: 'pending', receipt_date: '2026-10-20', vendor: 'ドライブの写真', amount: 700, category_code: 'expense.supplies', paid_by: 'cash', department: 'gibier', storage_path: driveUrl, file_name: 'IMG_0001.JPG', mime: 'image/jpeg', uploaded_by: 'テスト', created_at: '2026-10-25' });
  const fileCalls0 = calls.filter(c => c[0] === 'finance_receipt_file').length;
  await ctx.route('https://drive.google.com/**', rt => rt.fulfill({ status: 200, contentType: 'text/html', body: '<title>drive</title>' }));
  await p.evaluate(() => loadReceipts()); await p.waitForTimeout(600);
  const extCard = await txt('#rc-card-r3');
  ck('領収書: Drive の写真は 🔗 と「Driveで開く」が出て、「写真を付ける」は出ない', /🔗/.test(extCard) && /Driveで開く/.test(extCard) && !/写真を付ける/.test(extCard) && (await p.$eval('#rc-card-r3 a[target="_blank"]', a => a.href)) === driveUrl, extCard.slice(0, 200));
  ck('領収書: Drive の写真は DB のファイル取得（finance_receipt_file）を呼ばない', calls.filter(c => c[0] === 'finance_receipt_file').length === fileCalls0, String(calls.filter(c => c[0] === 'finance_receipt_file').length - fileCalls0));
  const [pop] = await Promise.all([ctx.waitForEvent('page', { timeout: 3000 }).catch(() => null), p.click('#th-r3')]);
  ck('領収書: 🔗 をクリックすると Drive のページが新しいタブで開く', !!pop && pop.url() === driveUrl, pop ? pop.url() : 'ポップアップなし');
  if (pop) await pop.close();

  // 9. 月次
  const dl = []; await p.exposeFunction('__dl', (n) => dl.push(n)); await p.evaluate(() => { window.download = (n) => window.__dl(n); });
  await p.click('.tab[data-tab="month"]'); await p.waitForTimeout(600);
  const mc = await txt('#monthCards');
  ck('月次（全部門）: 売上（請求書）・入金・出金・カード・経費が出る', /売上（この月に発行した請求書） ¥32,000 2件/.test(mc) && /入金（通帳） ¥90,869/.test(mc) && /うち請求書に当てた ¥24,869/.test(mc) && /カード利用 ¥7,500/.test(mc), mc);
  const jb = await txt('#journalBody');
  ck('月次: 仕訳に部門の札、普通預金／売掛金（INV-T-1）、水道光熱費／普通預金（アルコに付け替えた分）、未分類の「要確認」が出る', /ジビエ 普通預金 売掛金 12,000/.test(jb) && /アルコ 水道光熱費 普通預金 3,000/.test(jb) && /要確認/.test(jb), jb.slice(0, 300));
  await p.click('text=税理士向けにまとめて出す'); await p.waitForTimeout(500);
  ck('月次: 税理士向けに5つのCSV（仕訳・銀行・カード・領収書・未入金、全部門）', dl.length === 5 && dl.some(n => /^仕訳_全部門_/.test(n)) && dl.some(n => /^未入金_全部門_/.test(n)), dl.join(','));
  await p.selectOption('#deptSel', 'gibier'); await p.waitForTimeout(600);
  ck('月次（ジビエだけ）: 市役所への報告の注意が出て、入金はジビエ口座ぶん（¥81,869）', /館山市/.test(await txt('#monthReportNote')) && /入金（通帳） ¥81,869/.test(await txt('#monthCards')) && !/アルコ 水道光熱費/.test(await txt('#journalBody')), (await txt('#monthCards')).slice(0, 200));
  await shot('07-month');
  await p.selectOption('#deptSel', ''); await p.waitForTimeout(400);

  // 10. 設定
  await p.click('.tab[data-tab="settings"]'); await p.waitForTimeout(600);
  ck('設定: 部門2・口座2（番号・部門つき）・カード2 が一覧になり、勘定科目28件、閲覧専用キーの発行は管理者でないと出ない',
    (await p.$$('#deptBody tr')).length === 2 && (await p.$$('#accBody tr')).length === 2 && /3725493/.test(await txt('#accBody')) && /アルコ口座/.test(await txt('#accBody')) && (await p.$$('#cardsBody tr')).length === 2
    && (await p.$$('#titlesBody tr')).length === 28 && (await p.$eval('#viewerKeyPanel', el => getComputedStyle(el).display)) === 'none', [(await p.$$('#deptBody tr')).length, (await p.$$('#accBody tr')).length, (await p.$$('#cardsBody tr')).length].join('/'));
  await p.click('text=＋ 部門を足す'); const drows = await p.$$('#deptBody tr');
  await drows[drows.length - 1].$eval('[data-f="code"]', el => el.value = 'nature'); await drows[drows.length - 1].$eval('[data-f="name"]', el => el.value = 'ネイチャーキャピタル'); await drows[drows.length - 1].$eval('[data-f="mark"]', el => el.value = 'ネ');
  await p.click('#sec-settings button:has-text("保存") >> nth=0'); await p.waitForTimeout(500);
  ck('設定: 部門を足して保存できる（右上の選択にも増える）', last('staff_department_set')[1].p_rows.some(r => r.code === 'nature' && r.name === 'ネイチャーキャピタル' && r.mark === 'ネ') && S.departments.length === 3 && (await p.$$('#deptSel option')).length === 4, await txt('#deptMsg'));
  await p.click('text=＋ 科目を足す'); const rowsN = await p.$$('#titlesBody tr');
  await rowsN[rowsN.length - 1].$eval('[data-f="code"]', el => el.value = 'expense.feed'); await rowsN[rowsN.length - 1].$eval('[data-f="name"]', el => el.value = '飼料費');
  await p.click('#sec-settings button:has-text("保存") >> nth=1'); await p.waitForTimeout(500);
  ck('設定: 科目を足して保存できる（29件）', last('staff_titles_set')[1].p_rows.some(r => r.code === 'expense.feed' && r.name === '飼料費') && /29件/.test(await txt('#titlesMsg')), await txt('#titlesMsg'));
  ck('設定: 名義表に消込で登録した名義が出る', /ヤマキ[ 　]?タロウ/.test(await txt('#aliasList')) && /ビストロ架空/.test(await txt('#aliasList')), await txt('#aliasList'));
  await p.evaluate(() => sessionStorage.setItem('tg_role_v1', 'admin')); await p.click('.tab[data-tab="dash"]'); await p.click('.tab[data-tab="settings"]'); await p.waitForTimeout(500);
  ck('設定: 管理者コードを入れた端末では閲覧専用キーの発行が出る', (await p.$eval('#viewerKeyPanel', el => getComputedStyle(el).display)) !== 'none' && (await txt('#roleBadge')) === '管理者', await txt('#roleBadge'));
  await p.fill('#vkRecovery', 'x'); await p.click('text=自動で作る'); await p.click('text=発行する'); await p.waitForTimeout(400);
  ck('設定: 回復コードが違えば発行できず、その旨が出る', /回復コードが違います/.test(await txt('#vkMsg')) && !S.viewerKey, await txt('#vkMsg'));
  await p.fill('#vkRecovery', 'RECOV'); await p.click('text=発行する'); await p.waitForTimeout(400);
  ck('設定: 発行するとキーと共有リンク（#fkey=）を一度だけ表示', S.viewerKey && /#fkey=/.test(await txt('#vkMsg')) && (await txt('#vkMsg')).includes(S.viewerKey), '');
  await shot('08-settings');

  // 11. 税理士（閲覧専用）
  await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('tg_finance_key', 'VIEW'); });
  await p.goto('http://localhost:9151/finance.html?viewer=1#bank'); await p.waitForTimeout(900);
  ck('閲覧専用キー: 役割が「税理士（閲覧のみ）」、取込の枠が消え、科目・部門の選択が押せない', (await txt('#roleBadge')) === '税理士（閲覧のみ）' && (await p.$eval('#sec-bank .panel.w', el => getComputedStyle(el).display)) === 'none' && (await p.$eval('#bankBody select.catsel', el => el.disabled)) && (await p.$eval('#bankBody select.deptsel', el => el.disabled)), await txt('#roleBadge'));
  await p.click('.tab[data-tab="recon"]'); await p.waitForTimeout(300);
  ck('閲覧専用キー: 消込は読むだけ（操作は出ない）', /消込の操作はスタッフが行います/.test(await txt('#reconBox')), '');
  await p.click('.tab[data-tab="month"]'); await p.waitForTimeout(500);
  ck('閲覧専用キー: 月次・仕訳は見られる', /普通預金 売掛金 12,000/.test(await txt('#journalBody')), '');
  await p.click('.tab[data-tab="settings"]'); await p.waitForTimeout(500);
  ck('閲覧専用キー: 設定の部門・口座・カードは見えるが、足す・保存のボタンは無い', (await p.$$('#accBody tr')).length === 2 && (await p.$eval('#sec-settings .row.w', el => getComputedStyle(el).display)) === 'none', '');
  ck('pageerror なし', errs.length === 0, errs.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of out) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 300) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${out.length} passed`);
  await b.close(); srv.close();
  process.exit(pass === out.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
