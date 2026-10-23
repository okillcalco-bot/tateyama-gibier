// 会計の中身（finance-core.js）のテスト。node だけで動く（ブラウザ不要）。データはすべて架空。
//   1. 千葉銀行 PDF（pdf.js の textContent 相当の items）→ 明細行。列の x で入金・出金を判定し、合計・残高の繋がりで検算する
//      - 摘要は取引日の1行上にある／ページをまたぐ／摘要の無い行がある／印字日時を摘要に混ぜない／1 item に日付と金額が同居する
//   2. CSV の見出しから列の当たり（銀行・カード）
//   3. カード明細の行（返金はマイナス、読めない行は理由つき）
//   4. 月次集計・仕訳（消込済みの入金は売掛金、未分類は「要確認」、領収書のある行に印）
const path = require('path');
const FC = require(path.resolve(__dirname, '../../finance-core.js'));
const RC = require(path.resolve(__dirname, '../../recon-core.js'));
const out = []; const ck = (n, c, e) => out.push([n, !!c, e == null ? '' : String(e)]);

// ── 1. 千葉銀行 PDF を模した items（座標は本物の PDF と同じ配置。名義・金額は架空）──
// 1ページ目は口座の見出しがあるので表が下から始まる。2ページ目以降は表が上から始まる（摘要が y=155 に来る）
function makePages(rows) {
  const H = 842, pages = [], per = 10;
  let i = 0, pageNo = 0;
  const headerY = p => (p === 0 ? 221 : 139);
  while (i < rows.length || pageNo === 0) {
    const items = [{ str: '入出金明細', x: 20, y: 30 }, { str: '2026年10月23日13:34', x: 571, y: 41 }];
    if (pageNo === 0) items.push({ str: '金融機関名: テスト銀行', x: 20, y: 80 }, { str: '口座:  テスト支店 普通 0000000', x: 20, y: 100 }, { str: '照会期間:  2026年09月', x: 20, y: 120 },
      { str: '入金金額合計: ' + rows.filter(r => r.kind === '入金').reduce((a, r) => a + r.amount, 0).toLocaleString() + ' 円（全' + rows.filter(r => r.kind === '入金').length + '件）', x: 20, y: 161 },
      { str: '出金金額合計: ' + rows.filter(r => r.kind === '出金').reduce((a, r) => a + r.amount, 0).toLocaleString() + ' 円（全' + rows.filter(r => r.kind === '出金').length + '件）', x: 270, y: 161 });
    const hy = headerY(pageNo);
    ['取引区分', '取引日', '出金金額', '入金金額', '摘要', '残高'].forEach((h, k) => items.push({ str: h, x: [30, 120, 235, 350, 475, 640][k], y: hy }));
    let y = hy + 32;
    for (let k = 0; k < per && i < rows.length; k++, i++) {
      const r = rows[i];
      if (r.description) items.push({ str: r.description, x: 420, y: y });                                  // 摘要は行の16pt上
      const amtStr = r.amount.toLocaleString() + '円';
      if (r.joined) items.push({ str: r.txn_date.replace(/-/g, '/') + ' ' + amtStr, x: 105, y: y + 16 });     // 1 item に日付と金額が同居
      else { items.push({ str: r.txn_date.replace(/-/g, '/'), x: 105, y: y + 16 }); items.push({ str: amtStr, x: r.kind === '出金' ? 246 : 360, y: y + 16 }); }
      if (r.joined) items.push({ str: r.kind === '出金' ? '' : '', x: 0, y: 0 });
      items.push({ str: r.balance.toLocaleString() + '円', x: 610, y: y + 16 });
      y += 51;
    }
    items.push({ str: (pageNo + 1) + '/9ページ', x: 270, y: 781 });
    // pdf.js の流儀（y は下が0）に変換
    pages.push({ width: 595, height: H, items: items.filter(it => it.str).map(it => ({ str: it.str, x: it.x, y: H - it.y })) });
    pageNo++;
  }
  return pages;
}
let bal = 1000000;
const rows = [];
const add = (date, kind, amount, description, extra) => { bal += kind === '入金' ? amount : -amount; rows.push(Object.assign({ txn_date: date, kind, amount, description, balance: bal }, extra || {})); };
add('2026-09-01', '入金', 10627, 'テストシヨウテン');
add('2026-09-02', '出金', 8415, 'テストガス');
add('2026-09-03', '出金', 923584, '');                   // 摘要の無い行（振替）
add('2026-09-04', '入金', 200340, 'カ）テストオブリ－シ');
for (let k = 0; k < 12; k++) add('2026-09-' + String(5 + k).padStart(2, '0'), k % 3 === 0 ? '入金' : '出金', 1000 + k * 7, 'フリコミ　テスト　' + k);   // 2ページ目へまたぐ
add('2026-09-20', '入金', 57988, '（ユ）テストシヨウジ');      // ページ先頭行の摘要
add('2026-09-21', '出金', 3000, 'ページまたぎ');
const pages = makePages(rows);
const r1 = FC.chibaPdfRows(pages);
ck('PDF: 行数が合う（' + rows.length + '行・2ページ）', r1.rows.length === rows.length && pages.length === 2, r1.rows.length + '/' + pages.length);
ck('PDF: 入金・出金の判定が列の位置で決まる', r1.rows.every((x, i) => x.kind === rows[i].kind), JSON.stringify(r1.rows.filter((x, i) => x.kind !== rows[i].kind).slice(0, 2)));
ck('PDF: 日付・金額・残高が合う', r1.rows.every((x, i) => x.txn_date === rows[i].txn_date && x.amount === rows[i].amount && x.balance === rows[i].balance), '');
ck('PDF: 摘要が自分の行に付く（1行上にある・ページをまたぐ・先頭行）', r1.rows.every((x, i) => x.description === rows[i].description.replace(/[\s　]+/g, ' ')), JSON.stringify(r1.rows.map(x => x.description).slice(14, 18)));
ck('PDF: 摘要の無い行は空のまま（前後の摘要を取り込まない）', r1.rows[2].description === '' && r1.rows[3].description === 'カ）テストオブリ－シ', r1.rows[2].description + '|' + r1.rows[3].description);
ck('PDF: 印字日時「2026年10月23日13:34」は摘要に混ざらない', !r1.rows.some(x => /年.*月.*日/.test(x.description)), '');
ck('PDF: 見出し（照会期間・合計・件数）が読める', r1.header.period === '2026年09月' && r1.header.in_count === rows.filter(r => r.kind === '入金').length && r1.header.bank === 'テスト銀行', JSON.stringify(r1.header));
ck('PDF: 合計・件数・残高の繋がりの検算が通る', r1.checks.ok === true && r1.checks.balance_chain_bad === 0, JSON.stringify(r1.checks));
// 1 item に日付と金額が同居して x が当てにならないときは、残高の増減で入金・出金を決める（2行目以降）
const joined = makePages([rows[0], Object.assign({}, rows[1], { joined: true }), Object.assign({}, rows[3], { joined: true, balance: rows[1].balance + rows[3].amount })]);
const r2 = FC.chibaPdfRows(joined);
ck('PDF: 1 item に「日付 金額」が同居しても、残高の増減で入金・出金を決められる', r2.rows.length === 3 && r2.rows[1].kind === '出金' && r2.rows[1].amount === 8415 && r2.rows[2].kind === '入金' && r2.rows[2].amount === 200340, JSON.stringify(r2.rows.map(x => [x.kind, x.amount])));
// 壊れた残高（1行だけ残高がずれている）→ 検算 NG
const broken = rows.map(r => Object.assign({}, r)); broken[5].balance += 1;
const r3 = FC.chibaPdfRows(makePages(broken));
ck('PDF: 残高の繋がりが1か所でも崩れていれば ok=false（取り込ませない）', r3.checks.ok === false && r3.checks.balance_chain_bad >= 1, JSON.stringify(r3.checks));
ck('PDF: 明細の無いページ（見出しだけ）は無視する', FC.chibaPdfRows([{ width: 595, height: 842, items: [{ str: '入出金明細', x: 20, y: 800 }] }]).rows.length === 0, '');
const imp = FC.toImportRows(r1.rows);
ck('取込用の行: amount_in / amount_out / balance / row_no に分かれる', imp.length === rows.length && imp[0].amount_in === 10627 && imp[0].amount_out === 0 && imp[1].amount_out === 8415 && imp[1].row_no === 2 && imp[0].balance === rows[0].balance, JSON.stringify(imp[0]));

// ── 2. CSV の見出し ──
ck('CSV見出し: 銀行（取引日・摘要・お支払金額・お預り金額・残高）', JSON.stringify(FC.guessColumns([['取引日', '摘要', 'お支払金額', 'お預り金額', '残高']])) === JSON.stringify({ date: 0, description: 1, amount_out: 2, amount_in: 3, balance: 4, header_rows: 1 }), JSON.stringify(FC.guessColumns([['取引日', '摘要', 'お支払金額', 'お預り金額', '残高']])));
ck('CSV見出し: カード（ご利用日・ご利用先・ご利用金額）→ amount 1列', JSON.stringify(FC.guessColumns([['ご利用日', 'ご利用先', 'ご利用金額', '支払区分']])) === JSON.stringify({ date: 0, description: 1, amount: 2, header_rows: 1 }), '');
ck('CSV見出し: 見出しが2行目にあっても見つける（header_rows=2）', FC.guessColumns([['カード明細', '', ''], ['利用日', '利用店名', '金額']]).header_rows === 2, '');
ck('CSV見出し: 見出しらしい行が無ければ null', FC.guessColumns([['2026/10/01', 'ABC', '100']]) === null, '');

// ── 3. カード明細 ──
const card = FC.cardRows([['利用日', '利用店名', '金額'], ['2026/10/03', 'ガソリン', '5,500'], ['2026/10/07', '返品', '-1,200'], ['', '', ''], ['2026/13/01', 'だめ', '100'], ['2026/10/08', 'ゼロ', '0']],
  { column_map: { header_rows: 1, date: 0, description: 1, amount: 2 } }, RC);
ck('カード: 利用は正・返金は負、空行は飛ばす', card.txns.length === 2 && card.txns[0].amount === 5500 && card.txns[1].amount === -1200 && card.txns[0].txn_date === '2026-10-03', JSON.stringify(card.txns));
ck('カード: 読めない行（13月・金額0）は理由つきで返す', card.invalid.length === 2 && /日付/.test(card.invalid[0].reason) && /金額/.test(card.invalid[1].reason), JSON.stringify(card.invalid));

// ── 4. 月次集計・仕訳 ──
const titles = FC.DEFAULT_TITLES;
const data = {
  bank: [
    { txn_date: '2026-10-01', description: 'カ）テスト', amount_in: 12000, amount_out: 0, matched_docs: [{ doc_number: 'INV-T-1', amount: 12000, fee: 0 }] },
    { txn_date: '2026-10-02', description: 'ホジヨキン', amount_in: 50000, amount_out: 0, matched_docs: [], category_code: 'income.subsidy' },
    { txn_date: '2026-10-03', description: 'フメイ', amount_in: 700, amount_out: 0, matched_docs: [] },
    { txn_date: '2026-10-04', description: 'ガス', amount_in: 0, amount_out: 3000, category_code: 'expense.utilities', receipt_id: 'r1' },
    { txn_date: '2026-10-05', description: 'ナニカ', amount_in: 0, amount_out: 2000 },
    { txn_date: '2026-11-01', description: '来月', amount_in: 0, amount_out: 999, category_code: 'expense.misc' },
    { txn_date: '2026-10-06', description: 'テスウリヨウ', amount_in: 11450, amount_out: 0, matched_docs: [{ doc_number: 'INV-T-2', amount: 11450, fee: 550 }] }
  ],
  card: [{ txn_date: '2026-10-03', description: 'ガソリン', amount: 5500, category_code: 'expense.vehicle', card_name: 'B', receipt_id: 'r2' }, { txn_date: '2026-10-07', description: '返品', amount: -1200, category_code: 'expense.supplies', card_name: 'B' }, { txn_date: '2026-10-08', description: '未分類', amount: 800, card_name: 'B' }],
  receipts: [{ receipt_date: '2026-10-09', vendor: '文具店', amount: 880, paid_by: 'cash', category_code: 'expense.supplies', status: 'confirmed' }, { receipt_date: '2026-10-10', vendor: '却下', amount: 100, paid_by: 'cash', category_code: 'expense.misc', status: 'rejected' }, { receipt_date: '2026-10-03', vendor: 'GS', amount: 5500, paid_by: 'card', category_code: 'expense.vehicle', status: 'confirmed' }]
};
const s = FC.monthSummary('2026-10', data, titles);
ck('集計: 入金の合計・消込済み・未消込（科目付き）を分ける', s.bank_in === 74150 && s.bank_in_matched === 23450 && s.bank_in_unmatched === 50700 && s.income_by_title['補助金・助成金'] === 50000, JSON.stringify(s));
ck('集計: 出金・カード・現金の科目別と未分類（来月分は入らない）', s.bank_out === 5000 && s.card === 5100 && s.cash_receipts === 880 && s.expense_by_title['水道光熱費'] === 3000 && s.expense_by_title['車両費'] === 5500 && s.expense_by_title['消耗品費'] === -320 && s.unclassified.bank_out === 2000 && s.unclassified.card === 800, JSON.stringify(s.expense_by_title));
const j = FC.journalRows('2026-10', data, titles);
const find = (src, memoPart) => j.find(x => x.source === src && x.memo.includes(memoPart));
ck('仕訳: 消込済みの入金は 普通預金／売掛金、手数料差は 支払手数料／売掛金 に分ける', find('bank', 'INV-T-1').debit === '普通預金' && find('bank', 'INV-T-1').credit === '売掛金' && j.some(x => x.debit === '支払手数料' && x.amount === 550 && x.memo.includes('INV-T-2')), JSON.stringify(j.filter(x => x.memo.includes('INV-T'))));
ck('仕訳: 科目のある出金はその科目、無ければ 仮払金 と「要確認」', find('bank', 'ガス').debit === '水道光熱費' && find('bank', 'ナニカ').debit === '仮払金' && find('bank', 'ナニカ').tax === '要確認', '');
ck('仕訳: 未消込で科目も無い入金は 仮受金・要確認', find('bank', 'フメイ').credit === '仮受金' && find('bank', 'フメイ').tax === '要確認', '');
ck('仕訳: カード利用は 科目／未払金、返金は 未払金／科目', find('card', 'ガソリン').credit === '未払金' && find('card', '返品').debit === '未払金' && find('card', '返品').amount === 1200, '');
ck('仕訳: 現金の領収書は 科目／現金。却下した領収書とカード払いの領収書（二重計上）は入れない', find('receipt', '文具店').credit === '現金' && !j.some(x => x.memo.includes('却下')) && !j.some(x => x.source === 'receipt' && x.memo.includes('GS')), JSON.stringify(j.filter(x => x.source === 'receipt')));
ck('仕訳: 領収書の付いた行には【領収書あり】、証憑の列が入る', find('bank', 'ガス').memo.includes('【領収書あり】') && find('bank', 'ガス').evidence === '領収書' && find('card', 'ガソリン').evidence === '領収書' && find('bank', 'ナニカ').evidence === '銀行明細', '');
ck('仕訳: 来月の行は入らず、日付順', !j.some(x => x.date.startsWith('2026-11')) && j.every((x, i) => i === 0 || x.date >= j[i - 1].date), '');
const csv = RC.toCsv(j, FC.JOURNAL_COLS);
ck('仕訳CSV: 見出し7列・BOM付き・行数が合う', csv.startsWith('﻿日付,借方科目,貸方科目,金額,税区分,摘要,証憑') && csv.split('\r\n').length === j.length + 1, csv.slice(0, 80));
ck('科目の当たり: ガス→水道光熱費・ヤマト→荷造運賃・リソク→受取利息・該当なし→null', FC.suggestTitle('アストモスガス') === 'expense.utilities' && FC.suggestTitle('ヤマトウンユ（カ') === 'expense.freight' && FC.suggestTitle('リソク', 'in') === 'income.interest' && FC.suggestTitle('カ）テスト') === null, '');
ck('既定の勘定科目は28件で code が重複しない', titles.length === 28 && new Set(titles.map(t => t.code)).size === 28, '');

let pass = 0;
for (const [n, ok, got] of out) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 300) + ']' : '')); if (ok) pass++; }
console.log(`\n${pass}/${out.length} passed`);
process.exit(pass === out.length ? 0 : 1);
