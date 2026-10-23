// 会計画面（finance.html）の通し：DB関数はすべてモック（架空データ）。本番にはつながない。
//   1. キー: 無ければ入力を求める／違うキーは理由を出す／スタッフと税理士（閲覧専用）で画面が変わる
//   2. ダッシュボード: 残高・未入金・やること（未消込・未分類・未確認）の件数
//   3. 銀行: CSV 取込（列の当たり→確認→件数→取込）、PDF 取込（検算OKのときだけ取り込める）、出金の科目付け・候補
//   4. 入金消込: 自動をまとめて確定／候補から選んで確定（名義が登録される）／請求書でない入金に科目
//   5. 未入金・督促: 取引先ごとの一覧→文面→送った記録
//   6. カード: CSV 取込→科目付け
//   7. 領収書: 写真つき登録（縮小して base64 で送る）→確認済に
//   8. 月次: 集計・仕訳・CSV（5つ）
//   9. 設定: 勘定科目の追加・保存、閲覧専用キーの発行は管理者だけ
//  10. 失敗は画面に出る（黙って成功にしない）
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
    titles: FC.DEFAULT_TITLES.map(t => Object.assign({ is_active: true }, t)),
    bank: [
      { id: 'b1', txn_date: '2026-10-01', description: 'カ）テストショウテン', amount_in: 12000, amount_out: 0, balance: 1012000, matched_docs: [], category_code: null, memo: null },
      { id: 'b2', txn_date: '2026-10-02', description: 'テストガス', amount_in: 0, amount_out: 3000, balance: 1009000, matched_docs: [], category_code: null, memo: null },
      { id: 'b3', txn_date: '2026-10-03', description: 'ホジヨキン', amount_in: 50000, amount_out: 0, balance: 1059000, matched_docs: [], category_code: null, memo: null },
      { id: 'b4', txn_date: '2026-10-04', description: 'ヤマキ　タロウ', amount_in: 4869, amount_out: 0, balance: 1063869, matched_docs: [], category_code: null, memo: null },
      { id: 'b5', txn_date: '2026-10-05', description: 'テストシヨクドウ', amount_in: 8000, amount_out: 0, balance: 1071869, matched_docs: [{ doc_number: 'INV-T-0', customer_name: '架空食堂', amount: 8000, fee: 0, method: 'auto' }], category_code: null, memo: null },
    ],
    card: [{ id: 'c1', txn_date: '2026-10-03', description: 'ガソリン', amount: 5500, card_name: 'テストカード', category_code: null, memo: null, receipt_id: null }],
    receipts: [], files: {}, payments: [],
    invoices: [
      { id: 'd1', doc_number: 'INV-T-1', customer_id: 'cu1', partner_name: '架空商店', issue_date: '2026-10-06', due_date: '2026-11-30', total_amount: 12000, paid: 0 },
      { id: 'd2', doc_number: 'INV-T-2', customer_id: 'cu2', partner_name: 'ビストロ架空', issue_date: '2026-09-06', due_date: '2026-10-10', total_amount: 4869, paid: 0 },
      { id: 'd3', doc_number: 'INV-T-3', customer_id: 'cu2', partner_name: 'ビストロ架空', issue_date: '2026-10-06', due_date: '2026-11-30', total_amount: 20000, paid: 0 },
    ],
    customers: [{ id: 'cu1', name: '架空商店', kana: 'ｶ)ﾃｽﾄｼｮｳﾃﾝ', aliases: [] }, { id: 'cu2', name: 'ビストロ架空', kana: null, aliases: [] }],
    aliases: [], events: [], viewerKey: null, failNext: null,
  };
  const calls = [];
  const role = k => (k === 'STAFF' ? 'staff' : k === 'VIEW' ? 'viewer' : null);
  const needStaff = k => { if (k !== 'STAFF') throw new Error('スタッフキーが違います'); };
  const needAny = k => { if (!role(k)) throw new Error('キーが違います'); return role(k); };
  const unpaid = () => S.invoices.filter(v => v.total_amount - v.paid > 0).map(v => ({ document_id: v.id, doc_number: v.doc_number, customer_id: v.customer_id, customer_code: 'C' + v.customer_id, customer_name: v.partner_name, issue_date: v.issue_date, due_date: v.due_date, total: v.total_amount, paid: v.paid, remain: v.total_amount - v.paid, days_overdue: v.due_date < '2026-10-23' ? 13 : 0, dunning_count: S.events.filter(e => e.kind === 'dunning' && e.docs.includes(v.id)).length, department: 'gibier' }));
  const H = {
    finance_role: a => needAny(a.p_key),
    finance_titles: a => { needAny(a.p_key); return S.titles; },
    finance_overview: a => { const r = needAny(a.p_key); const u = unpaid(); return { role: r, latest: { date: '2026-10-05', balance: 1071869 }, months: [{ month: '2026-09', amount_in: 100000, amount_out: 80000 }, { month: '2026-10', amount_in: 74869, amount_out: 3000 }],
      unpaid: { count: u.length, total: u.reduce((s, x) => s + x.remain, 0), overdue_count: u.filter(x => x.days_overdue > 0).length, overdue_total: u.filter(x => x.days_overdue > 0).reduce((s, x) => s + x.remain, 0) },
      pending: { bank_in_unmatched: S.bank.filter(x => x.amount_in > 0 && !x.matched_docs.length && !x.category_code).length, bank_out_unclassified: S.bank.filter(x => x.amount_out > 0 && !x.category_code).length, card_unclassified: S.card.filter(x => !x.category_code).length, receipts_pending: S.receipts.filter(x => x.status === 'pending').length }, last_import: null }; },
    finance_bank_list: a => { needAny(a.p_key); if (S.failNext === 'bank') { S.failNext = null; throw new Error('わざと失敗'); } return S.bank.filter(x => x.txn_date >= a.p_from && x.txn_date <= a.p_to).map(x => Object.assign({}, x, { receipt_id: (S.receipts.find(r => r.bank_transaction_id === x.id && r.status !== 'rejected') || {}).id || null })); },
    finance_card_list: a => { needAny(a.p_key); return S.card.filter(x => x.txn_date >= a.p_from && x.txn_date <= a.p_to).map(x => Object.assign({}, x, { receipt_id: (S.receipts.find(r => r.card_transaction_id === x.id && r.status !== 'rejected') || {}).id || null })); },
    finance_receipts_list: a => { needAny(a.p_key); return S.receipts.filter(r => (!a.p_status || r.status === a.p_status) && (!a.p_from || r.receipt_date >= a.p_from) && (!a.p_to || r.receipt_date <= a.p_to)); },
    finance_receipt_file: a => { needAny(a.p_key); const f = S.files[a.p_receipt]; return f ? { ok: true, mime: f.mime, base64: f.base64, size_bytes: f.size } : { ok: false, reason: 'ファイルがありません' }; },
    finance_month: a => { needAny(a.p_key); return { month: a.p_month, bank: H.finance_bank_list({ p_key: a.p_key, p_from: a.p_month + '-01', p_to: a.p_month + '-31' }), card: H.finance_card_list({ p_key: a.p_key, p_from: a.p_month + '-01', p_to: a.p_month + '-31' }), receipts: S.receipts, titles: S.titles, invoices: S.invoices.filter(v => v.issue_date.startsWith(a.p_month)).map(v => ({ doc_number: v.doc_number, customer_name: v.partner_name, total: v.total_amount, tax: 0 })) }; },
    staff_unpaid_list_any: a => { needAny(a.p_key); return unpaid(); },
    staff_bank_import: a => { needStaff(a.p_staff_key); const bad = a.p_rows.filter(r => !/^\d{4}-\d{2}-\d{2}$/.test(r.txn_date)); if (bad.length) return { ok: false, invalid_rows: bad.map(r => r.row_no), row_count: a.p_rows.length };
      const dup = a.p_rows.filter(r => S.bank.some(x => x.txn_date === r.txn_date && x.amount_in === r.amount_in && x.amount_out === r.amount_out && x.description === r.description)).length;
      if (!a.p_commit) return { ok: true, preview: true, row_count: a.p_rows.length, new_count: a.p_rows.length - dup, dup_count: dup };
      a.p_rows.forEach((r, i) => { if (!S.bank.some(x => x.txn_date === r.txn_date && x.amount_in === r.amount_in && x.amount_out === r.amount_out && x.description === r.description)) S.bank.push({ id: 'bi' + S.bank.length, txn_date: r.txn_date, description: r.description, amount_in: r.amount_in, amount_out: r.amount_out, balance: r.balance, matched_docs: [], category_code: null, memo: null }); });
      return { ok: true, preview: false, row_count: a.p_rows.length, new_count: a.p_rows.length - dup, dup_count: dup }; },
    staff_card_import: a => { needStaff(a.p_staff_key); if (!a.p_commit) return { ok: true, preview: true, row_count: a.p_rows.length, new_count: a.p_rows.length, dup_count: 0 }; a.p_rows.forEach(r => S.card.push({ id: 'ci' + S.card.length, txn_date: r.txn_date, description: r.description, amount: r.amount, card_name: a.p_card_name, category_code: null, memo: null, receipt_id: null })); return { ok: true, preview: false, row_count: a.p_rows.length, new_count: a.p_rows.length, dup_count: 0 }; },
    staff_classify: a => { needStaff(a.p_staff_key); const list = a.p_kind === 'bank' ? S.bank : S.card; const x = list.find(r => r.id === a.p_txn); if (!x) throw new Error('明細が見つかりません'); x.category_code = a.p_category; x.memo = a.p_memo; return { ok: true }; },
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
  // pdf.js は CDN から取れないので、合成ページを返す偽物を差し込む
  await p.route('**/pdf.min.js', rt => rt.fulfill({ status: 200, contentType: 'application/javascript', body: `window.pdfjsLib={GlobalWorkerOptions:{},getDocument:function(){return {promise:Promise.resolve({numPages:1,getPage:function(){return Promise.resolve({getViewport:function(){return {width:595,height:842}},getTextContent:function(){return Promise.resolve({items:(window.__pdfItems||[]).map(function(i){return {str:i.str,transform:[1,0,0,1,i.x,i.y]}})})}})}})}}};` }));
  await p.route('**/fonts.googleapis.com/**', rt => rt.fulfill({ status: 200, contentType: 'text/css', body: '' }));

  await p.goto('http://localhost:9151/finance.html'); await p.waitForTimeout(600);
  const txt = sel => p.$eval(sel, el => el.innerText.replace(/\s+/g, ' ')).catch(() => '');
  const last = fn => calls.filter(c => c[0] === fn).slice(-1)[0];

  // 1. キー
  ck('キーが無ければ入力を求める', await p.$('#modal.show #keyIn') !== null, '');
  await p.fill('#keyIn', 'WRONG'); await p.click('#modalBody .btn-gold'); await p.waitForTimeout(300);
  ck('違うキーは理由を出す', /キーが違います/.test(await txt('#keyMsg')), await txt('#keyMsg'));
  await p.fill('#keyIn', 'STAFF'); await p.fill('#opIn', 'テスト担当'); await p.click('#modalBody .btn-gold'); await p.waitForTimeout(900);
  ck('スタッフキーで入ると役割が「スタッフ」になり、担当者名が出る', (await txt('#roleBadge')) === 'スタッフ' && /テスト担当/.test(await txt('#whoami')), await txt('#roleBadge'));

  // 2. ダッシュボード
  const dash = await txt('#sec-dash');
  ck('ダッシュボード: 残高・未入金（期日超過）・やることの件数', /¥1,071,869/.test(dash) && /未入金の請求書 ¥36,869 3件/.test(dash) && /うち期日超過 ¥4,869 1件/.test(dash)
    && /請求書に当てていない入金が 3件/.test(dash) && /科目を付けていない出金が 1件/.test(dash) && /科目を付けていない利用が 1件/.test(dash), dash.slice(0, 400));

  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT + '/01-dash.png', fullPage: true });
  // 3. 銀行: CSV 取込
  await p.click('.tab[data-tab="bank"]'); await p.waitForTimeout(500);
  ck('銀行: 今月の明細が出る（消込済みには請求書の札、出金には科目の選択）', (await p.$$('#bankBody tr')).length === 5 && /INV-T-0/.test(await txt('#bankBody')) && (await p.$('#bankBody select.catsel')) !== null, await txt('#bankBody'));
  ck('銀行: 「テストガス」の出金に科目の候補（水道光熱費）が出る', /候補: 水道光熱費/.test(await txt('#bankBody')), '');
  const csv = '取引日,摘要,お支払金額,お預り金額,残高\n2026/10/06,カ）シンキ,,7000,1078869\n2026/10/07,テストデンキ,2500,,1076369\n';
  await p.setInputFiles('#bankFile', { name: 'bank.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') }); await p.waitForTimeout(400);
  ck('銀行CSV: 列の当たりが付く（日付・摘要・入金・出金・残高）', (await p.$$eval('.bankmap', ss => ss.map(s => s.value).join(','))) === '0,1,3,2,,4', await p.$$eval('.bankmap', ss => ss.map(s => s.value).join(',')));
  await p.click('text=この列で読む'); await p.waitForTimeout(300);
  ck('銀行CSV: 確認表（2行・入金 7,000・出金 2,500）', /2行・入金 ¥7,000・出金 ¥2,500/.test(await txt('#bankImportBox')), await txt('#bankImportBox'));
  await p.click('#bankImportBtn'); await p.waitForTimeout(400);
  ck('銀行CSV: まず件数（新規 2件）を出してから取り込む', /新規 2件/.test(await txt('#bankImportMsg')) && last('staff_bank_import')[1].p_commit === false, await txt('#bankImportMsg'));
  await p.click('#bankImportMsg .btn-green'); await p.waitForTimeout(700);
  ck('銀行CSV: 取り込むと明細に増える（担当者名つき）', /取り込みました: 新規 2件/.test(await txt('#bankImportMsg')) && last('staff_bank_import')[1].p_commit === true && last('staff_bank_import')[1].p_by === 'テスト担当' && S.bank.length === 7, S.bank.length);
  // PDF 取込（偽 pdf.js）: 検算が合うページと合わないページ
  const mk = (rows) => { const H = 842, items = [{ str: '2026年10月23日13:34', x: 571, y: H - 41 }, { str: '照会期間:  2026年10月', x: 20, y: H - 120 }, { str: '入金金額合計: ' + rows.filter(r => r[1] === '入金').reduce((a, r) => a + r[2], 0).toLocaleString() + ' 円（全' + rows.filter(r => r[1] === '入金').length + '件）', x: 20, y: H - 161 }, { str: '出金金額合計: ' + rows.filter(r => r[1] === '出金').reduce((a, r) => a + r[2], 0).toLocaleString() + ' 円（全' + rows.filter(r => r[1] === '出金').length + '件）', x: 270, y: H - 161 }];
    ['取引区分', '取引日', '出金金額', '入金金額', '摘要', '残高'].forEach((h, k) => items.push({ str: h, x: [30, 120, 235, 350, 475, 640][k], y: H - 221 })); let y = 255;
    rows.forEach(r => { items.push({ str: r[3], x: 420, y: H - y }, { str: r[0], x: 105, y: H - (y + 16) }, { str: r[2].toLocaleString() + '円', x: r[1] === '出金' ? 246 : 360, y: H - (y + 16) }, { str: r[4].toLocaleString() + '円', x: 610, y: H - (y + 16) }); y += 51; }); return items; };
  await p.evaluate(items => { window.__pdfItems = items; }, mk([['2026/10/08', '入金', 9000, 'カ）ピ－ディ－エフ', 1085369], ['2026/10/09', '出金', 1500, 'テストツウシン', 1083869]]));
  await p.setInputFiles('#bankFile', { name: 'tsucho.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fake') }); await p.waitForTimeout(700);
  ck('銀行PDF: 読み取れて検算 OK（合計・残高の繋がり）が表示され、取り込める', /✔ PDF の合計/.test(await txt('#bankImportBox')) && /2026-10-08/.test(await txt('#bankImportBox')) && !(await p.$eval('#bankImportBtn', b => b.disabled)), (await txt('#bankImportBox')).slice(0, 300));
  await p.evaluate(items => { window.__pdfItems = items; }, mk([['2026/10/10', '入金', 9000, 'ズレ', 1085369], ['2026/10/11', '出金', 1500, 'ズレ2', 1083868]]));
  await p.setInputFiles('#bankFile', { name: 'tsucho2.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 fake') }); await p.waitForTimeout(700);
  ck('銀行PDF: 残高の繋がりが崩れていれば ✖ を出し、取込ボタンを押せない', /✖ 検算が合いません/.test(await txt('#bankImportBox')) && (await p.$eval('#bankImportBtn', b => b.disabled)), (await txt('#bankImportBox')).slice(0, 200));
  // 出金の科目付け
  await p.click('#bankBody button:has-text("候補: 水道光熱費")'); await p.waitForTimeout(400);
  ck('銀行: 候補ボタンで科目が付く（staff_classify）', last('staff_classify')[1].p_kind === 'bank' && last('staff_classify')[1].p_txn === 'b2' && last('staff_classify')[1].p_category === 'expense.utilities', JSON.stringify(last('staff_classify')[1]));
  S.failNext = 'bank'; await p.click('#sec-bank button:has-text("更新")'); await p.waitForTimeout(400);
  ck('失敗は画面に出る（銀行の読み込みが失敗したら表に理由）', /読み込めませんでした: わざと失敗/.test(await txt('#bankBody')), await txt('#bankBody'));
  await p.click('#sec-bank button:has-text("更新")'); await p.waitForTimeout(400);

  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT + '/02-bank.png', fullPage: true });
  // 4. 入金消込
  await p.click('.tab[data-tab="recon"]'); await p.waitForTimeout(600);
  const rc = await txt('#reconBox');
  ck('消込: 自動1（名義一致）・候補1（金額だけ一致）・請求書なし（補助金・新規）に分かれる', /自動で当たった 1件/.test(rc) && /候補から選ぶ 1件/.test(rc) && /請求書に当たらない入金/.test(rc) && /カ）テストショウテン/.test(rc), rc.slice(0, 300));
  await p.click('text=まとめて確定'); await p.waitForTimeout(600);
  ck('消込: 自動をまとめて確定（method=auto・名義は登録しない）', last('staff_recon_confirm')[1].p_method === 'auto' && last('staff_recon_confirm')[1].p_txn === 'b1' && !last('staff_recon_confirm')[1].p_alias && S.invoices[0].paid === 12000, JSON.stringify(last('staff_recon_confirm')[1]));
  ck('消込: 確定した分は一覧から消え、自動の枠が無くなる', (await p.$('#rc-b1')) === null && !/自動で当たった 1件/.test(await txt('#reconBox')), '');
  await p.click('#rc-b4 button:has-text("この請求書に確定")'); await p.waitForTimeout(600);
  ck('消込: 候補を確定すると manual・振込名義を alias として登録', last('staff_recon_confirm')[1].p_method === 'manual' && last('staff_recon_confirm')[1].p_alias === 'ヤマキ　タロウ' && S.aliases.length === 1 && S.invoices[1].paid === 4869, JSON.stringify(last('staff_recon_confirm')[1]));
  await p.selectOption('#cat-b3', 'income.subsidy'); await p.click('#rc-b3 button:has-text("この科目で記録")'); await p.waitForTimeout(500);
  ck('消込: 請求書でない入金に科目を付ける（補助金）', last('staff_classify')[1].p_txn === 'b3' && last('staff_classify')[1].p_category === 'income.subsidy', '');
  await p.click('text=最近の消込'); await p.click('#sec-recon button:has-text("表示")'); await p.waitForTimeout(500);
  ck('消込: 最近の消込に取消ボタンがある', /INV-T-1/.test(await txt('#recentMatched')) && (await p.$('#recentMatched .btn-danger')) !== null, await txt('#recentMatched'));

  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT + '/03-recon.png', fullPage: true });
  // 5. 未入金・督促
  await p.click('.tab[data-tab="unpaid"]'); await p.waitForTimeout(500);
  const up = await txt('#unpaidBody');
  ck('未入金: 取引先ごとにまとまる（残っているのは INV-T-3 だけ）', /ビストロ架空/.test(up) && /INV-T-3 20,000/.test(up) && !/INV-T-1/.test(up), up);
  await p.click('#unpaidBody button:has-text("督促文")'); await p.waitForTimeout(300);
  ck('督促: 文面に取引先名・請求書・合計が入る', /ビストロ架空 御中/.test(await p.$eval('#dunText', t => t.value)) && /INV-T-3/.test(await p.$eval('#dunText', t => t.value)) && /合計 ¥20,000/.test(await p.$eval('#dunText', t => t.value)), (await p.$eval('#dunText', t => t.value)).slice(0, 120));
  await p.click('text=送った記録を残す'); await p.waitForTimeout(400);
  ck('督促: 送った記録（LINE・請求書の id）が残る', last('staff_dunning_record')[1].p_channel === 'line' && last('staff_dunning_record')[1].p_docs[0] === 'd3', JSON.stringify(last('staff_dunning_record')[1]));

  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT + '/04-unpaid.png', fullPage: true });
  // 6. カード
  await p.click('.tab[data-tab="card"]'); await p.waitForTimeout(500);
  await p.fill('#cardName', '事業用カードB');
  await p.setInputFiles('#cardFile', { name: 'card.csv', mimeType: 'text/csv', buffer: Buffer.from('ご利用日,ご利用先,ご利用金額,支払区分\n2026/10/12,ホームセンター,3200,1回\n2026/10/13,返品,-1200,1回\n', 'utf8') }); await p.waitForTimeout(400);
  await p.click('#cardImportBox button:has-text("この列で読む")'); await p.waitForTimeout(300);
  ck('カードCSV: 利用額と返金が読める（2行・合計 2,000）', /2行・合計 ¥2,000/.test(await txt('#cardImportBox')), await txt('#cardImportBox'));
  await p.click('#cardImportBtn'); await p.waitForTimeout(400); await p.click('#cardImportMsg .btn-green'); await p.waitForTimeout(600);
  ck('カードCSV: 取り込める（カード名つき）', last('staff_card_import')[1].p_card_name === '事業用カードB' && last('staff_card_import')[1].p_commit === true && S.card.length === 3, S.card.length);
  await p.selectOption('#cardBody select.catsel >> nth=0', 'expense.vehicle'); await p.waitForTimeout(400);
  ck('カード: 科目を付けられる', last('staff_classify')[1].p_kind === 'card' && last('staff_classify')[1].p_category === 'expense.vehicle', '');

  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT + '/05-card.png', fullPage: true });
  // 7. 領収書（写真つき）
  await p.click('.tab[data-tab="receipts"]'); await p.waitForTimeout(400);
  const png = await p.evaluate(() => { const c = document.createElement('canvas'); c.width = 2400; c.height = 1800; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 2400, 1800); g.fillStyle = '#000'; g.font = '80px sans-serif'; g.fillText('RECEIPT 5,500', 100, 300); return c.toDataURL('image/png').split(',')[1]; });
  await p.setInputFiles('#rcFile', { name: 'receipt.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') }); await p.waitForTimeout(800);
  ck('領収書: 写真は長辺1600pxの JPEG に縮小してから送る', /縮小済み/.test(await txt('#rcFileInfo')), await txt('#rcFileInfo'));
  await p.fill('#rcDate', '2026-10-03'); await p.fill('#rcVendor', 'ガソリンスタンド'); await p.fill('#rcAmount', '5500'); await p.selectOption('#rcCat', 'expense.vehicle'); await p.selectOption('#rcPaidBy', 'card');
  await p.click('#rcAddBtn'); await p.waitForTimeout(1200);
  const put = last('staff_receipt_file_put');
  ck('領収書: 台帳に登録してからファイル（JPEG・base64）を送る', last('staff_receipt_add')[1].p_receipt.vendor === 'ガソリンスタンド' && last('staff_receipt_add')[1].p_receipt.amount === 5500 && put && put[1].p_mime === 'image/jpeg' && put[1].p_base64.length > 1000 && put[1].p_base64.length < 400000, put && put[1].p_base64.length);
  await p.waitForTimeout(500);
  ck('領収書: 未確認の一覧に出て、サムネイルが付く', (await p.$eval('#rcList input[data-f="vendor"]', el => el.value)) === 'ガソリンスタンド' && (await p.$('#rcList img.thumb')) !== null, (await txt('#rcList')).slice(0, 200));
  await p.click('#rcList button:has-text("明細に紐づける")'); await p.waitForTimeout(500);
  ck('領収書: 紐づけ候補に金額一致のカード明細（ガソリン 5,500）が上に出る', /ガソリン 5,500 金額一致/.test(await txt('#modalBody')), (await txt('#modalBody')).slice(0, 300));
  await p.check('#modalBody input[name="lk"] >> nth=0'); await p.click('#modalBody button:has-text("紐づける")'); await p.waitForTimeout(500);
  ck('領収書: カード明細に紐づく', S.receipts[0].card_transaction_id === 'c1' && /カード明細に紐づけ済/.test(await txt('#rcList')), JSON.stringify(S.receipts[0]));
  await p.click('#rcList button:has-text("確認済にする")'); await p.waitForTimeout(500);
  ck('領収書: 確認済にすると未確認の一覧から消え、件数が減る', S.receipts[0].status === 'confirmed' && /該当する領収書はありません/.test(await txt('#rcList')), '');

  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT + '/06-receipts.png', fullPage: true });
  // 8. 月次
  const dl = []; await p.exposeFunction('__dl', (n) => dl.push(n)); await p.evaluate(() => { window.download = (n) => window.__dl(n); });
  await p.click('.tab[data-tab="month"]'); await p.waitForTimeout(600);
  const mc = await txt('#monthCards');
  ck('月次: 売上（請求書）・入金・出金・カード・経費が出る', /売上（この月に発行した請求書） ¥32,000 2件/.test(mc) && /入金（通帳） ¥81,869/.test(mc) && /うち請求書に当てた ¥24,869/.test(mc) && /カード利用 ¥7,500/.test(mc), mc);
  const jb = await txt('#journalBody');
  ck('月次: 仕訳に 普通預金／売掛金（INV-T-1）、水道光熱費／普通預金、未分類の「要確認」が出る', /普通預金 売掛金 12,000/.test(jb) && /水道光熱費 普通預金 3,000/.test(jb) && /要確認/.test(jb), jb.slice(0, 300));
  await p.click('text=税理士向けにまとめて出す'); await p.waitForTimeout(500);
  ck('月次: 税理士向けに5つのCSV（仕訳・銀行・カード・領収書・未入金）', dl.length === 5 && dl.some(n => /^仕訳_/.test(n)) && dl.some(n => /^未入金_/.test(n)), dl.join(','));

  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT + '/07-month.png', fullPage: true });
  // 9. 設定
  await p.click('.tab[data-tab="settings"]'); await p.waitForTimeout(500);
  ck('設定: 勘定科目が一覧になり、閲覧専用キーの発行は管理者でないと出ない', (await p.$$('#titlesBody tr')).length === 28 && (await p.$eval('#viewerKeyPanel', el => getComputedStyle(el).display)) === 'none', (await p.$$('#titlesBody tr')).length);
  await p.click('text=＋ 科目を足す'); const rowsN = await p.$$('#titlesBody tr');
  await rowsN[rowsN.length - 1].$eval('[data-f="code"]', el => el.value = 'expense.feed'); await rowsN[rowsN.length - 1].$eval('[data-f="name"]', el => el.value = '飼料費');
  await p.click('#sec-settings button:has-text("保存")'); await p.waitForTimeout(500);
  ck('設定: 科目を足して保存できる（29件）', last('staff_titles_set')[1].p_rows.some(r => r.code === 'expense.feed' && r.name === '飼料費') && /29件/.test(await txt('#titlesMsg')), await txt('#titlesMsg'));
  ck('設定: 名義表に消込で登録した名義が出る', /ヤマキ[ 　]?タロウ/.test(await txt('#aliasList')) && /ビストロ架空/.test(await txt('#aliasList')), await txt('#aliasList'));
  await p.evaluate(() => sessionStorage.setItem('tg_role_v1', 'admin')); await p.click('.tab[data-tab="dash"]'); await p.click('.tab[data-tab="settings"]'); await p.waitForTimeout(300);
  ck('設定: 管理者コードを入れた端末では閲覧専用キーの発行が出る', (await p.$eval('#viewerKeyPanel', el => getComputedStyle(el).display)) !== 'none' && (await txt('#roleBadge')) === '管理者', await txt('#roleBadge'));
  await p.fill('#vkRecovery', 'x'); await p.click('text=自動で作る'); await p.click('text=発行する'); await p.waitForTimeout(400);
  ck('設定: 回復コードが違えば発行できず、その旨が出る', /回復コードが違います/.test(await txt('#vkMsg')) && !S.viewerKey, await txt('#vkMsg'));
  await p.fill('#vkRecovery', 'RECOV'); await p.click('text=発行する'); await p.waitForTimeout(400);
  ck('設定: 発行するとキーと共有リンク（#fkey=）を一度だけ表示', S.viewerKey && /#fkey=/.test(await txt('#vkMsg')) && (await txt('#vkMsg')).includes(S.viewerKey), '');

  if (process.env.SHOT) await p.screenshot({ path: process.env.SHOT + '/08-settings.png', fullPage: true });
  // 10. 税理士（閲覧専用）
  await p.evaluate(() => { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('tg_finance_key', 'VIEW'); });
  await p.goto('http://localhost:9151/finance.html?viewer=1#bank'); await p.waitForTimeout(900);
  ck('閲覧専用キー: 役割が「税理士（閲覧のみ）」、取込の枠が消え、科目の選択が押せない', (await txt('#roleBadge')) === '税理士（閲覧のみ）' && (await p.$eval('#sec-bank .panel.w', el => getComputedStyle(el).display)) === 'none' && (await p.$eval('#bankBody select.catsel', el => el.disabled)), await txt('#roleBadge'));
  await p.click('.tab[data-tab="recon"]'); await p.waitForTimeout(300);
  ck('閲覧専用キー: 消込は読むだけ（操作は出ない）', /消込の操作はスタッフが行います/.test(await txt('#reconBox')), '');
  await p.click('.tab[data-tab="month"]'); await p.waitForTimeout(500);
  ck('閲覧専用キー: 月次・仕訳は見られる', /普通預金 売掛金 12,000/.test(await txt('#journalBody')), '');
  ck('pageerror なし', errs.length === 0, errs.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of out) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 300) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${out.length} passed`);
  await b.close(); srv.close();
  process.exit(pass === out.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
