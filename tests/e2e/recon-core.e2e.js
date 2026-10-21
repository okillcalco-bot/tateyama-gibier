// 入金消込の中身（recon-core.js）の単体テスト。ブラウザ不要（node だけ）。データはすべて架空。
//   誤消込0件が最優先: 自動確定は「名義の完全一致＋金額の一致（1件 or 同じ取引先の合計）」だけ。
//   最後にランダムな架空データを多数作り、自動確定の結果が必ずこの条件を満たすことを確かめる（性質テスト）。
const path = require('path');
const R = require(path.resolve(__dirname, '../../recon-core.js'));
const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

// ── 文字コード ──
const sjis = Uint8Array.from([0x93, 0xFA, 0x95, 0x74, 0x2C, 0x93, 0xFC, 0x8B, 0xE0, 0x0D, 0x0A, 0x32, 0x30, 0x32, 0x36, 0x2F, 0x31, 0x30, 0x2F, 0x30, 0x35, 0x2C, 0xC3, 0xBD, 0xC4]); // 日付,入金\r\n2026/10/05,ﾃｽﾄ
const d1 = R.decode(sjis);
T('Shift_JIS を自動判定して読める', d1.encoding === 'shift_jis' && d1.text === '日付,入金\r\n2026/10/05,ﾃｽﾄ', JSON.stringify(d1));
const d2 = R.decode(new TextEncoder().encode('﻿日付,入金'));
T('UTF-8（BOM付き）はそのまま・BOMを外す', d2.encoding === 'utf-8' && d2.text === '日付,入金', JSON.stringify(d2));

// ── CSV ──
const rows = R.parseCsv('a,"b,c","d""e"\r\n1,"改\n行",3\n');
T('CSV: 引用符内のカンマ・改行・"" を読める', JSON.stringify(rows) === JSON.stringify([['a', 'b,c', 'd"e'], ['1', '改\n行', '3']]), JSON.stringify(rows));

// ── 日付・金額 ──
const dates = ['2026/10/05', '2026-10-5', '20261005', '2026年10月5日', 'R8.10.5', '令和8年10月5日', '２０２６/１０/０５'].map(R.parseDate);
T('日付の書式（7種）を YYYY-MM-DD に', dates.every(x => x === '2026-10-05'), JSON.stringify(dates));
T('ありえない日付は読めない（2/30・13月）', R.parseDate('2026/02/30') === null && R.parseDate('2026/13/01') === null, '');
T('金額: カンマ・円・全角・空欄', R.parseAmount('12,345') === 12345 && R.parseAmount('１２３円') === 123 && R.parseAmount('') === 0 && R.parseAmount('abc') === null, '');

// ── 列定義で明細にする・読めない行は全部挙げる ──
const prof = { column_map: { header_rows: 1, date: 0, description: 1, amount_in: 2, amount_out: 3, balance: 4 } };
const ap = R.applyProfile(R.parseCsv('日付,摘要,入金,出金,残高\n2026/10/01,ﾌﾘｺﾐ ﾔﾏﾀﾞ,10000,,50000\n\n2026/10/02,ﾃﾞﾝｷﾀﾞｲ,,3000,47000\n2026/13/01,ﾌﾘｺﾐ X,100,,47100\n2026/10/03,ﾌﾘｺﾐ Y,abc,,47100\n'), prof);
T('列定義で入金・出金を読む（空行は数えない）', ap.txns.length === 2 && ap.txns[0].amount_in === 10000 && ap.txns[1].amount_out === 3000 && ap.txns[0].balance === 50000, JSON.stringify(ap.txns));
T('読めない行（日付・金額）を行番号つきで全部挙げる', ap.invalid.length === 2 && ap.invalid[0].row_no === 5 && ap.invalid[1].row_no === 6, JSON.stringify(ap.invalid.map(x => [x.row_no, x.reason])));
const ap2 = R.applyProfile([['2026/10/01', 'A', '-500'], ['2026/10/02', 'B', '800']], { column_map: { date: 0, description: 1, amount: 2 } });
T('入出金が1列（符号付き）の銀行', ap2.txns[0].amount_out === 500 && ap2.txns[1].amount_in === 800, JSON.stringify(ap2.txns));

// ── 名義の正規化 ──
const N = R.normName;
T('法人略号（前・後ろ・閉じ括弧なし）と小書きをそろえる', N('ｶ)ﾔﾏﾀﾞｼｮｳﾃﾝ') === N('ヤマダショウテン') && N('ﾔﾏﾀﾞｼﾖｳﾃﾝ(ｶ') === N('やまだしょうてん') && N('ヤマダショウテン(カ)') === N('ヤマダショウテン'), N('ｶ)ﾔﾏﾀﾞｼｮｳﾃﾝ'));
T('漢字の法人格・全角空白・先頭の「振込」を除く', N('株式会社　山田商店') === '山田商店' && N('振込 ﾔﾏﾀﾞ ﾀﾛｳ') === 'ヤマダタロウ', N('株式会社　山田商店'));
T('名前の中の「カ」は消さない（カシマ）', N('カシマ') === 'カシマ' && N('ｶｼﾏｺｳｻﾝ(ｶ') === 'カシマコウサン', N('ｶｼﾏｺｳｻﾝ(ｶ'));

// ── 消込の判定（架空の取引先 A〜E）──
const cust = [
  { id: 'A', name: '山田商店', kana: 'ﾔﾏﾀﾞｼｮｳﾃﾝ' },
  { id: 'B', name: '海辺食堂', kana: 'ウミベショクドウ' },
  { id: 'C', name: '森のキッチン', kana: null, aliases: ['モリノキッチン'] },
  { id: 'D', name: '山田商会', kana: 'ﾔﾏﾀﾞｼｮｳｶｲ' },
  { id: 'E', name: '川辺亭', kana: 'カワベテイ' },
];
const inv = (id, c, total, paid = 0, issue = '2026-10-06') => ({ id, doc_number: 'INV-' + id, customer_id: c, total_amount: total, paid, issue_date: issue, due_date: '2026-11-30' });
const snap = (txns, invoices, aliases = []) => ({ customers: cust, aliases, invoices, txns, fee_tolerance: 1000 });
const tx = (id, desc, amt) => ({ id, txn_date: '2026-10-31', description: desc, amount_in: amt });
const run = (txns, invoices, aliases) => R.reconcile(snap(txns, invoices, aliases));

let r = run([tx('t1', 'ﾌﾘｺﾐ ﾔﾏﾀﾞｼｮｳﾃﾝ(ｶ', 12000)], [inv('1', 'A', 12000), inv('2', 'A', 8000), inv('3', 'D', 12000)]);
T('ルール1: 名義完全一致＋残額一致1件 → 自動（似た名前の山田商会には当てない）', r[0].kind === 'auto' && r[0].rule === 'amount_name' && r[0].allocs[0].document_id === '1', JSON.stringify(r[0].allocs));
r = run([tx('t1', 'ﾔﾏﾀﾞｼｮｳﾃﾝ', 12000)], [inv('1', 'A', 12000), inv('2', 'A', 12000, 0, '2026-09-06')]);
T('名義一致でも同額の請求書が2件 → 自動にしない', r[0].kind === 'candidate' && r[0].rule === 'ambiguous' && r[0].candidates.length === 2, r[0].reason);
r = run([tx('t1', 'ｳﾐﾍﾞｼｮｸﾄﾞｳ', 20000)], [inv('1', 'B', 12000), inv('2', 'B', 8000), inv('3', 'A', 20000)]);
T('ルール2: 同じ取引先の未入金2件の合計と一致 → まとめて自動', r[0].kind === 'auto' && r[0].rule === 'sum' && r[0].allocs.length === 2 && r[0].allocs.reduce((a, x) => a + x.amount, 0) === 20000, JSON.stringify(r[0].allocs));
r = run([tx('t1', 'ﾔﾏﾀﾞｼｮｳﾃﾝ', 11560)], [inv('1', 'A', 12000)]);
T('ルール3: 手数料差（440円）→ 候補だけ・自動にしない・差額を記録', r[0].kind === 'candidate' && r[0].rule === 'fee' && r[0].candidates[0].fee === 440 && !r[0].allocs.length, JSON.stringify(r[0].candidates));
r = run([tx('t1', 'ﾔﾏﾀﾞｼｮｳﾃﾝ', 10500)], [inv('1', 'A', 12000)]);
T('差額が許容範囲（1,000円）を超えたら手数料扱いしない（分割・不足）', r[0].kind === 'candidate' && r[0].rule === 'partial', r[0].rule);
r = run([tx('t1', 'ﾔﾏﾀﾞ', 12000)], [inv('1', 'A', 12000)]);
T('名義が部分一致（ﾔﾏﾀﾞ）だけ → 自動にしない（候補・ファジー照合の対象）', r[0].kind === 'candidate' && r[0].rule === 'fuzzy' && r[0].needs_fuzzy && r[0].candidates[0].document_id === '1', r[0].reason);
r = run([tx('t1', 'ﾓﾘﾉｷｯﾁﾝ', 5400)], [inv('1', 'C', 5400)]);
T('取引先の別名（search_aliases）でも完全一致すれば自動', r[0].kind === 'auto', r[0].reason);
r = run([tx('t1', 'ｽｽﾞｷ ﾊﾅｺ', 7000)], [inv('1', 'E', 7000)]);
T('個人名義（未登録）＋金額だけ一致 → 候補（金額だけ一致）', r[0].kind === 'candidate' && r[0].candidates[0].reason === '金額だけ一致', r[0].reason);
r = run([tx('t1', 'ｽｽﾞｷ ﾊﾅｺ', 7000)], [inv('1', 'E', 7000)], [{ customer_id: 'E', name: N('ｽｽﾞｷ ﾊﾅｺ') }]);
T('手動確定で登録した名義（customer_aliases）は次回から自動', r[0].kind === 'auto', r[0].reason);
r = run([tx('t1', 'ｽｽﾞｷ ﾊﾅｺ', 7000)], [inv('1', 'E', 7000), inv('2', 'B', 7000)], [{ customer_id: 'E', name: N('ｽｽﾞｷﾊﾅｺ') }, { customer_id: 'B', name: N('ｽｽﾞｷﾊﾅｺ') }]);
T('同じ名義が2つの取引先に登録されていたら自動にしない', r[0].kind === 'candidate' && r[0].rule === 'alias_conflict', r[0].reason);
r = run([tx('t1', 'ﾔﾏﾀﾞｼｮｳﾃﾝ', 12000), tx('t2', 'ﾔﾏﾀﾞｼｮｳﾃﾝ', 12000)], [inv('1', 'A', 12000)]);
T('同じ請求書を2つの入金が取り合ったら、どちらも自動にしない', r.every(x => x.kind === 'candidate' && x.rule === 'conflict'), r.map(x => x.rule).join(','));
r = run([tx('t1', 'ﾔﾏﾀﾞｼｮｳﾃﾝ', 4000)], [inv('1', 'A', 12000, 8000)]);
T('一部入金済みの請求書は残額（4,000円）で照らす', r[0].kind === 'auto', r[0].reason);
r = run([tx('t1', 'ﾅｿﾞﾉﾋﾄ', 3333), { id: 'o', txn_date: '2026-10-31', description: '電気代', amount_in: 0, amount_out: 5000 }], [inv('1', 'A', 12000)]);
T('当てはまらない入金は「不明入金」・出金は対象外', r.length === 1 && r[0].kind === 'unknown', r.map(x => x.kind).join(','));
r = run([tx('t1', 'ﾔﾏﾀﾞｼｮｳﾃﾝ', 30000)], [inv('1', 'A', 12000), inv('2', 'A', 8000)]);
T('未入金の合計より多い入金 → 過入金の候補（自動にしない）', r[0].kind === 'candidate' && r[0].rule === 'over', r[0].rule);

// ── 性質テスト: ランダムな架空データで、自動確定は必ず条件を満たす ──
let seed = 20261021; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const kanas = ['ヤマダ', 'ヤマダショウテン', 'ウミベ', 'ウミベショクドウ', 'モリ', 'カワベ', 'カワベテイ', 'スズキ', 'タナカ', 'タナカヤ'];
let violations = [], autoCount = 0, total = 0;
for (let round = 0; round < 400; round++) {
  const cs = Array.from({ length: 6 }, (_, i) => ({ id: 'c' + i, name: '店' + i, kana: kanas[rnd(kanas.length)] }));
  const invs = Array.from({ length: 12 }, (_, i) => { const t = (1 + rnd(20)) * 1000 + rnd(3) * 220; return { id: 'i' + i, doc_number: 'N' + i, customer_id: 'c' + rnd(6), total_amount: t, paid: rnd(4) === 0 ? Math.floor(t / 2) : 0, issue_date: '2026-0' + (8 + rnd(2)) + '-0' + (1 + rnd(9)) }; });
  const txns = Array.from({ length: 8 }, (_, i) => { const v = invs[rnd(invs.length)], c = cs.find(x => x.id === v.customer_id); const amt = rnd(3) === 0 ? v.total_amount - v.paid - rnd(2) * 440 : (v.total_amount - v.paid); return { id: 't' + i, description: rnd(4) === 0 ? kanas[rnd(kanas.length)] : 'ﾌﾘｺﾐ ' + c.kana + (rnd(2) ? '(カ' : ''), amount_in: Math.max(1, amt) }; });
  const out = R.reconcile({ customers: cs, aliases: [], invoices: invs, txns, fee_tolerance: 1000 });
  const claimed = {};
  out.forEach(x => {
    total++;
    if (x.kind !== 'auto') return;
    autoCount++;
    const docs = x.allocs.map(a => invs.find(v => v.id === a.document_id));
    const custs = new Set(docs.map(v => v.customer_id));
    const nmOk = custs.size === 1 && cs.filter(c => N(c.kana) === N(x.txn.description) || N(c.name) === N(x.txn.description)).map(c => c.id).join() === [...custs][0];
    const sumOk = x.allocs.reduce((a, b) => a + b.amount, 0) === x.txn.amount_in && x.allocs.every(a => a.fee === 0 && a.amount === docs.find(v => v.id === a.document_id).total_amount - docs.find(v => v.id === a.document_id).paid);
    x.allocs.forEach(a => { claimed[a.document_id] = (claimed[a.document_id] || 0) + 1; });
    if (!nmOk || !sumOk) violations.push({ round, txn: x.txn, rule: x.rule });
  });
  Object.entries(claimed).forEach(([k, n]) => { if (n > 1) violations.push({ round, doubleClaim: k }); });
}
T(`性質テスト（架空データ ${total}件の入金）: 自動確定 ${autoCount}件すべてが名義完全一致・金額一致・手数料0・請求書の取り合いなし`, violations.length === 0 && autoCount > 0, violations.length ? JSON.stringify(violations.slice(0, 2)) : `${autoCount}/${total}`);

// ── 督促文面・CSV ──
const docs = [{ doc_number: 'INV-202610-001', issue_date: '2026-10-06', due_date: '2026-11-30', remain: 12000 }, { doc_number: 'INV-202610-002', issue_date: '2026-10-06', due_date: '2026-11-30', remain: 8000 }];
const m1 = R.dunningDraft('架空商店', docs, 1, { as_of: '2026-12-05' }), m2 = R.dunningDraft('架空商店', docs, 2, { as_of: '2026-12-20', new_due: '2026-12-28' });
T('督促1回目は確認のトーン・2回目は期日を明記', /行き違い/.test(m1) && !/行き違い/.test(m2) && /2026-12-28 までに/.test(m2) && /合計 ¥20,000/.test(m1), '');
const csv = R.toCsv([{ a: 'x,y', b: 1 }], [{ key: 'a', label: '名' }, { key: 'b', label: '額' }]);
T('CSV出力: BOM付き・カンマを含む値を引用符で囲む', csv === '﻿名,額\r\n"x,y",1', JSON.stringify(csv));

let pass = 0;
for (const [nm, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + nm + (got ? '  [' + String(got).slice(0, 200) + ']' : '')); if (ok) pass++; }
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
