/* 会計（finance.html）の中身のうち、画面に依存しない純粋な関数だけ。入金消込の recon-core.js と対で使う。
   finance.html から <script src="finance-core.js"> で読み、tests/e2e/finance-core.e2e.js から node で直接テストする。
   DB への読み書きはここでは行わない。銀行・カードの実データはテストに入れない（公開リポジトリ）。

   入っているもの
     1. 千葉銀行「入出金明細」PDF（インターネットバンキングの印刷PDF）→ 明細行
        pdf.js の page.getTextContent() の items を受け取り、列の x 座標で入金・出金を判定し、残高の繋がりで検算する。
     2. CSV の列の当たりをつける（銀行・カードとも。見出しの言葉から 日付／摘要／入金／出金／金額／残高 を推定）
     3. カード明細 → 明細行（利用額は正、返金は負）
     4. 月次集計と、税理士向けの仕訳CSV（汎用の「日付・借方科目・貸方科目・金額・摘要」形式） */
(function (root) {
  'use strict';
  var FC = {};
  var num = function (s) { return Number(String(s || '').replace(/[,，円¥\s]/g, '')); };

  // ── 1. 千葉銀行 PDF ──
  // pages: [{ width, height, items: [{ str, x, y }] }]  y は pdf.js の流儀（下が0）でも pymupdf の流儀（上が0）でもよい（top:true で上が0）
  // 返り値: { rows: [{txn_date, kind:'入金'|'出金', amount, description, balance}], header: {period, bank, account, in_total, in_count, out_total, out_count}, checks: {...} }
  FC.chibaPdfRows = function (pages, opts) {
    opts = opts || {};
    var rows = [], header = {}, pending = [], allText = [];
    var isDate = function (s) { return /^\d{4}\/\d{2}\/\d{2}$/.test(s); };
    var isAmt = function (s) { return /^[\d,]+円$/.test(s); };
    pages.forEach(function (page) {
      var items = page.items.map(function (it) {
        return { str: String(it.str || '').trim(), x: it.x, y: opts.top ? it.y : (page.height - it.y) };
      }).filter(function (it) { return it.str; });
      items.forEach(function (it) { allText.push(it.str); });
      // 見出しの列位置（ページごとに取り直す）
      var cols = {};
      items.forEach(function (it) {
        ['取引区分', '取引日', '出金金額', '入金金額', '摘要', '残高'].forEach(function (h) { if (it.str === h && cols[h] == null) cols[h] = it.x; });
      });
      if (cols['出金金額'] == null || cols['入金金額'] == null || cols['残高'] == null) return;   // 明細の無いページ
      // y が近いものを同じ行にまとめる（上から順）
      var lines = [];
      items.slice().sort(function (a, b) { return a.y - b.y || a.x - b.x; }).forEach(function (it) {
        var L = lines.length ? lines[lines.length - 1] : null;
        if (L && Math.abs(L.y - it.y) <= 4) { L.items.push(it); } else lines.push({ y: it.y, items: [it] });
      });
      lines.forEach(function (L) {
        var ws = L.items.sort(function (a, b) { return a.x - b.x; });
        // 1つの item に「2026/07/02 14,110円」のように複数入ることがあるので、空白で割ってから見る
        var toks = [];
        ws.forEach(function (it) { var parts = it.str.split(/\s+/).filter(Boolean); parts.forEach(function (t) { toks.push({ str: t, x: it.x, shared: parts.length > 1 }); }); });
        var dates = toks.filter(function (t) { return isDate(t.str); });
        var amts = toks.filter(function (t) { return isAmt(t.str); });
        if (!dates.length) {
          // 摘要は取引日の1行上に、摘要列の位置で出る。印字日時（右上）と見出しは除く
          var first = ws[0];
          var inDescCol = first.x > cols['摘要'] - 80 && first.x < cols['残高'] - 30;
          var text = ws.map(function (it) { return it.str; }).join(' ');
          if (inDescCol && !amts.length && !/^\d{4}年\d{1,2}月\d{1,2}日/.test(text) && text !== '摘要') pending.push(text);
          return;
        }
        if (amts.length < 2) return;
        var bal = amts.reduce(function (m, t) { return t.x > m.x ? t : m; });
        var amt = amts.filter(function (t) { return t !== bal; })[0];
        var kind = Math.abs(amt.x - cols['出金金額']) < Math.abs(amt.x - cols['入金金額']) ? '出金' : '入金';
        // 金額が日付と同じ item に入っていて x が当てにならないときは、残高の増減で決める
        if (amt.shared && rows.length) { var prev = rows[rows.length - 1].balance; kind = num(bal.str) - prev === num(amt.str) ? '入金' : '出金'; }
        // 摘要の空白は全角・連続とも半角1つに寄せる（PDF と CSV のどちらから入れても同じ文字列になるように）
        rows.push({ txn_date: dates[0].str.replace(/\//g, '-'), kind: kind, amount: num(amt.str), description: pending.join(' ').replace(/[\s　]+/g, ' ').trim(), balance: num(bal.str) });
        pending = [];
      });
    });
    var text = allText.join('\n');
    var m;
    if ((m = /入金金額合計:\s*([\d,]+)\s*円（全(\d+)件）/.exec(text))) { header.in_total = num(m[1]); header.in_count = Number(m[2]); }
    if ((m = /出金金額合計:\s*([\d,]+)\s*円（全(\d+)件）/.exec(text))) { header.out_total = num(m[1]); header.out_count = Number(m[2]); }
    if ((m = /照会期間:\s*(\S+)/.exec(text))) header.period = m[1];
    if ((m = /金融機関名:\s*(\S+)/.exec(text))) header.bank = m[1];
    if ((m = /口座:\s*(.+)/.exec(text))) header.account = m[1].trim();
    var sumIn = 0, nIn = 0, sumOut = 0, nOut = 0, bad = 0;
    rows.forEach(function (r, i) {
      if (r.kind === '入金') { sumIn += r.amount; nIn++; } else { sumOut += r.amount; nOut++; }
      if (i > 0) { var d = r.balance - rows[i - 1].balance; if ((r.kind === '入金' && d !== r.amount) || (r.kind === '出金' && d !== -r.amount)) bad++; }
    });
    var checks = { in_total_ok: header.in_total == null ? null : (header.in_total === sumIn && header.in_count === nIn),
                   out_total_ok: header.out_total == null ? null : (header.out_total === sumOut && header.out_count === nOut),
                   balance_chain_bad: bad, in_count: nIn, out_count: nOut, in_total: sumIn, out_total: sumOut };
    checks.ok = checks.in_total_ok !== false && checks.out_total_ok !== false && bad === 0 && rows.length > 0;
    return { rows: rows, header: header, checks: checks };
  };

  // PDF の行 → 取込用の行（staff_bank_import / RC.applyProfile と同じ形）
  FC.toImportRows = function (rows) {
    return rows.map(function (r, i) {
      return { row_no: i + 1, txn_date: r.txn_date, description: r.description || '', amount_in: r.kind === '入金' ? r.amount : 0, amount_out: r.kind === '出金' ? r.amount : 0, balance: r.balance == null ? null : r.balance };
    });
  };

  // ── 2. CSV の列の当たり ──
  // 見出し行を見て {header_rows, date, description, amount_in, amount_out, amount, balance} を返す。見つからない列は undefined
  FC.guessColumns = function (rows) {
    var best = null;
    for (var i = 0; i < Math.min(rows.length, 5); i++) {
      var r = rows[i] || [], map = {}, hits = 0;
      r.forEach(function (h, c) {
        var s = String(h || '').replace(/\s/g, '');
        if (!s) return;
        if (map.date == null && /日付|取引日|利用日|年月日|お取引日|ご利用日/.test(s)) { map.date = c; hits++; }
        else if (map.description == null && /摘要|内容|利用店|ご利用先|店名|お取引内容|明細|名義|加盟店/.test(s)) { map.description = c; hits++; }
        else if (map.amount_in == null && /入金|お預り|預入|受入/.test(s)) { map.amount_in = c; hits++; }
        else if (map.amount_out == null && /出金|お支払|引出|支払金額|お引出/.test(s)) { map.amount_out = c; hits++; }
        else if (map.balance == null && /残高/.test(s)) { map.balance = c; hits++; }
        else if (map.amount == null && /金額|利用額|ご利用金額|利用金額/.test(s)) { map.amount = c; hits++; }
      });
      if (map.amount != null && (map.amount_in != null || map.amount_out != null)) delete map.amount;
      if (hits >= 2 && (!best || hits > best.hits)) { best = { hits: hits, map: map, header_rows: i + 1 }; }
    }
    if (!best) return null;
    best.map.header_rows = best.header_rows;
    return best.map;
  };

  // ── 3. カード明細 ──
  // profile.column_map: {header_rows, date, description, amount}（amount は利用額。マイナスは返金）
  // 返り値 {txns:[{row_no, txn_date, description, amount}], invalid:[{row_no, reason, raw}]}
  FC.cardRows = function (rows, profile, RC) {
    var cm = (profile && profile.column_map) || {}, hdr = cm.header_rows || 0, txns = [], invalid = [];
    rows.forEach(function (r, i) {
      if (i < hdr) return;
      if (!r.some(function (x) { return String(x).trim() !== ''; })) return;
      var rowNo = i + 1, reasons = [];
      var date = RC.parseDate(r[cm.date]);
      if (!date) reasons.push('日付');
      var a = RC.parseAmount(r[cm.amount]);
      if (a === null || a === 0) reasons.push('金額');
      var desc = String(r[cm.description] == null ? '' : r[cm.description]).trim();
      if (reasons.length) invalid.push({ row_no: rowNo, reason: reasons.join('・') + ' が読めない', raw: r.join(',') });
      else txns.push({ row_no: rowNo, txn_date: date, description: desc, amount: a });
    });
    return { txns: txns, invalid: invalid };
  };

  // ── 4. 月次集計・仕訳 ──
  // bank: [{txn_date, amount_in, amount_out, category_code, matched_docs:[...]}]  card: [{txn_date, amount, category_code}]  receipts: [{receipt_date, amount, paid_by, category_code}]
  FC.monthSummary = function (month, data, titles) {
    var inM = function (d) { return String(d || '').slice(0, 7) === month; };
    var name = function (code) { var t = (titles || []).filter(function (x) { return x.code === code; })[0]; return t ? t.name : (code ? code : '未分類'); };
    var s = { month: month, bank_in: 0, bank_out: 0, bank_in_matched: 0, bank_in_unmatched: 0, card: 0, cash_receipts: 0, expense_by_title: {}, income_by_title: {}, unclassified: { bank_out: 0, card: 0 } };
    (data.bank || []).forEach(function (b) {
      if (!inM(b.txn_date)) return;
      if (b.amount_in > 0) { s.bank_in += b.amount_in; if ((b.matched_docs || []).length) s.bank_in_matched += b.amount_in; else { s.bank_in_unmatched += b.amount_in; if (b.category_code) s.income_by_title[name(b.category_code)] = (s.income_by_title[name(b.category_code)] || 0) + b.amount_in; } }
      if (b.amount_out > 0) { s.bank_out += b.amount_out; if (b.category_code) s.expense_by_title[name(b.category_code)] = (s.expense_by_title[name(b.category_code)] || 0) + b.amount_out; else s.unclassified.bank_out += b.amount_out; }
    });
    (data.card || []).forEach(function (c) {
      if (!inM(c.txn_date)) return;
      s.card += c.amount;
      if (c.category_code) s.expense_by_title[name(c.category_code)] = (s.expense_by_title[name(c.category_code)] || 0) + c.amount; else s.unclassified.card += c.amount;
    });
    (data.receipts || []).forEach(function (r) {
      if (!inM(r.receipt_date) || r.status === 'rejected') return;
      if (r.paid_by === 'cash') { s.cash_receipts += r.amount; if (r.category_code) s.expense_by_title[name(r.category_code)] = (s.expense_by_title[name(r.category_code)] || 0) + r.amount; }
    });
    return s;
  };

  // 仕訳の行（税理士が会計ソフトに入れやすい汎用形）。摘要に元の明細と証憑（領収書）の有無を書く。
  FC.journalRows = function (month, data, titles) {
    var inM = function (d) { return String(d || '').slice(0, 7) === month; };
    var name = function (code, fallback) { var t = (titles || []).filter(function (x) { return x.code === code; })[0]; return t ? t.name : (fallback || '未分類'); };
    var out = [];
    (data.bank || []).forEach(function (b) {
      if (!inM(b.txn_date)) return;
      if (b.amount_in > 0) {
        var docs = b.matched_docs || [];
        if (docs.length) docs.forEach(function (d) { out.push({ date: b.txn_date, debit: '普通預金', credit: '売掛金', amount: d.amount, tax: '対象外', memo: '入金 ' + (b.description || '') + ' ' + d.doc_number + (d.fee ? '（手数料差 ' + d.fee + '円）' : ''), source: 'bank', evidence: '銀行明細' });
          if (d.fee) out.push({ date: b.txn_date, debit: '支払手数料', credit: '売掛金', amount: d.fee, tax: '課税仕入10%', memo: '振込手数料差 ' + d.doc_number, source: 'bank', evidence: '銀行明細' }); });
        else out.push({ date: b.txn_date, debit: '普通預金', credit: name(b.category_code, '仮受金'), amount: b.amount_in, tax: b.category_code ? '' : '要確認', memo: '入金 ' + (b.description || '') + (b.memo ? ' / ' + b.memo : ''), source: 'bank', evidence: '銀行明細' });
      }
      if (b.amount_out > 0) out.push({ date: b.txn_date, debit: name(b.category_code, '仮払金'), credit: '普通預金', amount: b.amount_out, tax: b.category_code ? '' : '要確認', memo: '出金 ' + (b.description || '') + (b.memo ? ' / ' + b.memo : '') + (b.receipt_id ? '【領収書あり】' : ''), source: 'bank', evidence: b.receipt_id ? '領収書' : '銀行明細' });
    });
    (data.card || []).forEach(function (c) {
      if (!inM(c.txn_date)) return;
      out.push({ date: c.txn_date, debit: c.amount >= 0 ? name(c.category_code, '仮払金') : '未払金', credit: c.amount >= 0 ? '未払金' : name(c.category_code, '仮払金'), amount: Math.abs(c.amount), tax: c.category_code ? '' : '要確認', memo: 'カード ' + (c.card_name || '') + ' ' + (c.description || '') + (c.memo ? ' / ' + c.memo : '') + (c.receipt_id ? '【領収書あり】' : ''), source: 'card', evidence: c.receipt_id ? '領収書' : 'カード明細' });
    });
    (data.receipts || []).forEach(function (r) {
      if (!inM(r.receipt_date) || r.status === 'rejected' || r.paid_by !== 'cash') return;
      out.push({ date: r.receipt_date, debit: name(r.category_code, '仮払金'), credit: '現金', amount: r.amount, tax: r.category_code ? '' : '要確認', memo: '現金 ' + (r.vendor || '') + (r.memo ? ' / ' + r.memo : '') + '【領収書あり】', source: 'receipt', evidence: '領収書' });
    });
    out.sort(function (a, b) { return String(a.date).localeCompare(String(b.date)) || String(a.source).localeCompare(String(b.source)); });
    return out;
  };
  FC.JOURNAL_COLS = [
    { key: 'date', label: '日付' }, { key: 'debit', label: '借方科目' }, { key: 'credit', label: '貸方科目' }, { key: 'amount', label: '金額' },
    { key: 'tax', label: '税区分' }, { key: 'memo', label: '摘要' }, { key: 'evidence', label: '証憑' }
  ];

  // 既定の勘定科目（税理士が設定で直せる。code は変えない）
  FC.DEFAULT_TITLES = [
    ['income.sales_gibier', '売上高（ジビエ）', 'income', 8], ['income.sales_other', '売上高（その他）', 'income', 10], ['income.subsidy', '補助金・助成金', 'income', 0],
    ['income.interest', '受取利息', 'income', 0], ['income.misc', '雑収入', 'income', 10],
    ['expense.purchase', '仕入高（個体買取・資材）', 'expense', 8], ['expense.outsourcing', '外注費', 'expense', 10], ['expense.freight', '荷造運賃', 'expense', 10],
    ['expense.supplies', '消耗品費', 'expense', 10], ['expense.travel', '旅費交通費', 'expense', 10], ['expense.vehicle', '車両費', 'expense', 10],
    ['expense.utilities', '水道光熱費', 'expense', 10], ['expense.communication', '通信費', 'expense', 10], ['expense.rent', '地代家賃', 'expense', 10],
    ['expense.repair', '修繕費', 'expense', 10], ['expense.fees', '支払手数料', 'expense', 10], ['expense.taxes', '租税公課', 'expense', 0],
    ['expense.insurance', '保険料', 'expense', 0], ['expense.welfare', '法定福利費', 'expense', 0], ['expense.salary', '給料手当', 'expense', 0],
    ['expense.entertainment', '接待交際費', 'expense', 10], ['expense.meeting', '会議費', 'expense', 10], ['expense.advertising', '広告宣伝費', 'expense', 10],
    ['expense.misc', '雑費', 'expense', 10], ['other.owner', '事業主貸／役員貸付', 'other', 0], ['other.transfer', '口座間振替', 'other', 0],
    ['other.loan', '借入金の返済', 'other', 0], ['other.tax_payment', '税金の納付', 'other', 0]
  ].map(function (t, i) { return { code: t[0], name: t[1], kind: t[2], tax_rate: t[3], sort: (i + 1) * 10 }; });

  // 摘要から勘定科目の当たりをつける（確定はしない。候補として出す）
  FC.suggestTitle = function (description, kind) {
    var s = String(description || '').normalize('NFKC');
    var rules = kind === 'in'
      ? [[/リソク/, 'income.interest'], [/ホジヨキン|助成|補助/, 'income.subsidy']]
      : [[/ガス|デンリヨク|電力|スイドウ|水道|エナジ/, 'expense.utilities'], [/ウンユ|運輸|ヤマト|サガワ|佐川|ユウビン/, 'expense.freight'],
         [/ホケン|保険/, 'expense.insurance'], [/シヤカイホケン|ネンキン|年金|ロウム/, 'expense.welfare'], [/テスウリヨウ|手数料/, 'expense.fees'],
         [/ゼイ|税|コクゼイ|ケンゼイ|シゼイ/, 'other.tax_payment'], [/フリカエ|振替/, 'other.transfer'], [/フアイナンス|ファイナンス|リ－ス|リース/, 'expense.vehicle'],
         [/ツウシン|通信|ドコモ|ソフトバンク|KDDI|AU /i, 'expense.communication'], [/ヤチン|家賃|チダイ/, 'expense.rent'], [/キユウヨ|給与|キユウリヨウ/, 'expense.salary']];
    for (var i = 0; i < rules.length; i++) if (rules[i][0].test(s)) return rules[i][1];
    return null;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = FC;
  root.FC = FC;
})(typeof window !== 'undefined' ? window : globalThis);
