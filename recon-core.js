/* 入金消込の中身（画面に依存しない純粋な関数だけ）。order-admin.html から <script src="recon-core.js"> で読み、
   tests/unit/recon-core.test.js から node で直接テストする。DB への書込みはここでは行わない。
   指示書: docs/reconciliation/ 。自動確定のルールを「広げる」変更は沖の承認が必要（DECISIONS.md に記録）。

   自動で確定するのは決定的なルールが当たったときだけ:
     1. 名義一致＋金額一致: 正規化した振込名義が取引先の読み・別名・登録済み名義と「完全一致」し、その取引先の
        未入金請求書のうち残額が入金額と等しいものがちょうど1件
     2. 合算一致: 名義が完全一致した取引先の未入金請求書（2件以上）の残額合計 ＝ 入金額
   それ以外（手数料差・部分一致・金額だけ一致・名義が複数の取引先に当たる・同じ請求書を2つの入金が取り合う）は候補を出して人が選ぶ。 */
(function (root) {
  'use strict';
  var RC = {};

  // ── 文字コード: UTF-8 として正しく読めればそれ、読めなければ Shift_JIS ──
  RC.decode = function (bytes, encoding) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (encoding === 'shift_jis') return { text: new TextDecoder('shift_jis').decode(u8), encoding: 'shift_jis' };
    try {
      var t = new TextDecoder('utf-8', { fatal: true }).decode(u8);
      return { text: t.replace(/^﻿/, ''), encoding: 'utf-8' };
    } catch (e) {
      if (encoding === 'utf-8') throw new Error('UTF-8 として読めません');
      return { text: new TextDecoder('shift_jis').decode(u8), encoding: 'shift_jis' };
    }
  };

  // ── CSV（引用符・引用符内の改行・"" のエスケープに対応）──
  RC.parseCsv = function (text) {
    var rows = [], row = [], f = '', q = false, s = String(text || '');
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (q) {
        if (ch === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && s[i + 1] === '\n') i++;
        row.push(f); rows.push(row); row = []; f = '';
      } else f += ch;
    }
    if (f !== '' || row.length) { row.push(f); rows.push(row); }
    return rows;
  };

  // 金額: 空欄は0。カンマ・円・¥・空白・全角数字に対応。読めなければ null
  RC.parseAmount = function (v) {
    var t = String(v == null ? '' : v).normalize('NFKC').replace(/[,\s¥円]/g, '');
    if (t === '' || t === '-') return 0;
    if (!/^-?\d+$/.test(t)) return null;
    return parseInt(t, 10);
  };

  // 日付: 2026/10/05・2026-10-05・20261005・2026年10月5日・R8.10.5・令和8年10月5日 → 'YYYY-MM-DD'。読めなければ null
  RC.parseDate = function (v) {
    var t = String(v == null ? '' : v).normalize('NFKC').trim(), y, m, d, r;
    if ((r = /^(\d{4})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})日?$/.exec(t))) { y = +r[1]; m = +r[2]; d = +r[3]; }
    else if ((r = /^(\d{4})(\d{2})(\d{2})$/.exec(t))) { y = +r[1]; m = +r[2]; d = +r[3]; }
    else if ((r = /^(?:R|令和)\s*(\d{1,2})[\/\-.年](\d{1,2})[\/\-.月](\d{1,2})日?$/i.exec(t))) { y = 2018 + +r[1]; m = +r[2]; d = +r[3]; }
    else return null;
    var dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  };

  // ── 銀行の列定義でCSVの行を明細にする。1行でも読めなければ invalid に入れる（取込側で全体を止める）──
  // profile.column_map: {header_rows, date, description(番号 or 番号の配列), amount_in, amount_out, balance, amount(入出金が1列で符号付きの銀行)}
  RC.applyProfile = function (rows, profile) {
    var cm = (profile && profile.column_map) || {}, hdr = cm.header_rows || 0, txns = [], invalid = [];
    var col = function (r, k) { var c = cm[k]; if (c == null) return undefined; return Array.isArray(c) ? c.map(function (i) { return (r[i] || '').trim(); }).filter(Boolean).join(' ') : r[c]; };
    rows.forEach(function (r, i) {
      if (i < hdr) return;
      if (!r.some(function (x) { return String(x).trim() !== ''; })) return;   // 空行は飛ばす（数えない）
      var rowNo = i + 1, reasons = [];
      var date = RC.parseDate(col(r, 'date'));
      if (!date) reasons.push('日付');
      var ain, aout;
      if (cm.amount != null) {
        var a = RC.parseAmount(col(r, 'amount'));
        if (a === null) reasons.push('金額'); else { ain = a > 0 ? a : 0; aout = a < 0 ? -a : 0; }
      } else {
        ain = RC.parseAmount(col(r, 'amount_in')); aout = RC.parseAmount(col(r, 'amount_out'));
        if (ain === null || ain < 0) reasons.push('入金額');
        if (aout === null || aout < 0) reasons.push('出金額');
      }
      var bal = cm.balance != null ? RC.parseAmount(col(r, 'balance')) : null;
      if (cm.balance != null && bal === null) reasons.push('残高');
      if (!reasons.length && !ain && !aout) reasons.push('入金・出金とも0');
      var desc = String(col(r, 'description') || '').trim();
      if (reasons.length) invalid.push({ row_no: rowNo, reason: reasons.join('・') + ' が読めない', raw: r.join(',') });
      else txns.push({ row_no: rowNo, txn_date: date, description: desc, amount_in: ain, amount_out: aout, balance: cm.balance != null ? bal : null });
    });
    return { txns: txns, invalid: invalid };
  };

  // ── 振込名義の正規化: 全角半角・ひらがな→カタカナ・小書き→大書き・法人格・記号・空白・先頭の「振込」等を除く ──
  var CORP = /(株式会社|有限会社|合同会社|合資会社|合名会社|一般社団法人|一般財団法人|公益社団法人|公益財団法人|特定非営利活動法人|NPO法人|医療法人|社会福祉法人|学校法人|宗教法人|\(株\)|\(有\)|\(同\)|\(資\)|\(名\)|\(一社\)|\(一財\)|\(医\)|\(福\)|\(学\)|カブシキガイシャ|カブシキカイシヤ|カブシキカイシャ|ユウゲンガイシャ|ユウゲンカイシヤ|ゴウドウガイシャ|ゴウドウカイシヤ|イツパンシヤダンホウジン|イツパンシャダンホウジン)/g;
  // 銀行の名義は「カ)ヤマダ」「ヤマダ(カ)」「ヤマダ(カ」の形で法人略号が付く（カ=株式会社 ユ=有限 ド=合同 シヤ=社団 ザイ=財団 など）
  var AB = '(?:カ|ユ|ド|メ|シ|ゴ|イ|ガク|シヤ|シャ|ザイ|トク|ノウ|ギヨ|ギョ|フク|イリヨウ)';
  var CORP_ABBR = [new RegExp('\\(' + AB + '\\)', 'g'), new RegExp('^' + AB + '\\)'), new RegExp('\\(' + AB + '$')];
  var SMALL = { 'ァ': 'ア', 'ィ': 'イ', 'ゥ': 'ウ', 'ェ': 'エ', 'ォ': 'オ', 'ッ': 'ツ', 'ャ': 'ヤ', 'ュ': 'ユ', 'ョ': 'ヨ', 'ヮ': 'ワ', 'ヵ': 'カ', 'ヶ': 'ケ' };
  RC.normName = function (s) {
    var t = String(s || '').normalize('NFKC').toUpperCase();
    t = t.replace(/[ぁ-ゖ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + 0x60); });
    t = t.replace(/[ァィゥェォッャュョヮヵヶ]/g, function (c) { return SMALL[c]; });
    t = t.replace(/^\s*(振込入金|振込|フリコミ|電信|テレ為替|入金)\s*/, '');
    t = t.replace(CORP, '').trim();
    CORP_ABBR.forEach(function (re) { t = t.replace(re, ''); });
    return t.replace(/[\s・.,，、。\-－ー―‐()（）「」\[\]［］\/／]/g, '');
  };

  // ── 名義 → 取引先の索引（完全一致用）──
  RC.buildNameIndex = function (customers, aliases) {
    var idx = {};
    var add = function (name, cid) { var k = RC.normName(name); if (k.length < 2) return; (idx[k] = idx[k] || {})[cid] = true; };
    (customers || []).forEach(function (c) {
      add(c.kana, c.id); add(c.name, c.id);
      (c.aliases || []).forEach(function (a) { add(a, c.id); });
    });
    (aliases || []).forEach(function (a) { add(a.name, a.customer_id); });
    return idx;
  };

  var remainOf = function (inv) { return Number(inv.total_amount || 0) - Number(inv.paid || 0); };
  var byIssue = function (a, b) { return String(a.issue_date || '').localeCompare(String(b.issue_date || '')) || String(a.doc_number || '').localeCompare(String(b.doc_number || '')); };

  // ── 自動消込の判定 ──
  // snap: {invoices:[{id,doc_number,customer_id,total_amount,paid,issue_date,due_date}], customers, aliases, txns:[{id,txn_date,description,amount_in}], fee_tolerance}
  // 返り値: 入金明細ごとに {txn, kind:'auto'|'candidate'|'unknown', rule, reason, confidence, allocs:[{document_id,amount,fee}], candidates:[...], name}
  RC.reconcile = function (snap) {
    var tol = snap.fee_tolerance == null ? 1000 : Number(snap.fee_tolerance);
    var idx = RC.buildNameIndex(snap.customers, snap.aliases);
    var open = (snap.invoices || []).filter(function (v) { return remainOf(v) > 0; });
    var byCust = {};
    open.forEach(function (v) { (byCust[v.customer_id] = byCust[v.customer_id] || []).push(v); });
    Object.keys(byCust).forEach(function (k) { byCust[k].sort(byIssue); });
    var custName = {}; (snap.customers || []).forEach(function (c) { custName[c.id] = c; });

    var cand = function (v, reason, conf, fee) { return { document_id: v.id, doc_number: v.doc_number, customer_id: v.customer_id, remain: remainOf(v), reason: reason, confidence: conf, fee: fee || 0 }; };

    var out = (snap.txns || []).filter(function (t) { return Number(t.amount_in) > 0; }).map(function (t) {
      var amt = Number(t.amount_in), nm = RC.normName(t.description);
      var res = { txn: t, name: nm, kind: 'unknown', rule: null, reason: '該当する請求書なし（不明入金）', confidence: 0, allocs: [], candidates: [] };
      var hit = nm.length >= 2 && idx[nm] ? Object.keys(idx[nm]) : [];
      if (hit.length > 1) {
        res.kind = 'candidate'; res.rule = 'alias_conflict'; res.reason = '振込名義が複数の取引先に当たる（' + hit.length + '件）';
        hit.forEach(function (cid) { (byCust[cid] || []).forEach(function (v) { if (remainOf(v) === amt) res.candidates.push(cand(v, '名義・金額一致（取引先が複数）', 0.7)); }); });
        return res;
      }
      if (hit.length === 1) {
        var list = byCust[hit[0]] || [];
        var eq = list.filter(function (v) { return remainOf(v) === amt; });
        if (eq.length === 1) {
          res.kind = 'auto'; res.rule = 'amount_name'; res.reason = '名義と残額が一致'; res.confidence = 1;
          res.allocs = [{ document_id: eq[0].id, amount: amt, fee: 0 }]; res.candidates = [cand(eq[0], '名義と残額が一致', 1)];
          return res;
        }
        if (eq.length > 1) {
          res.kind = 'candidate'; res.rule = 'ambiguous'; res.reason = '名義と金額が同じ請求書が' + eq.length + '件（どれか特定できない）';
          res.candidates = eq.map(function (v) { return cand(v, '名義・金額一致', 0.8); });
          return res;
        }
        var sum = list.reduce(function (a, v) { return a + remainOf(v); }, 0);
        if (list.length > 1 && sum === amt) {
          res.kind = 'auto'; res.rule = 'sum'; res.reason = '同じ取引先の未入金' + list.length + '件の合計と一致'; res.confidence = 1;
          res.allocs = list.map(function (v) { return { document_id: v.id, amount: remainOf(v), fee: 0 }; });
          res.candidates = list.map(function (v) { return cand(v, '合算', 1); });
          return res;
        }
        var fee = list.filter(function (v) { var d = remainOf(v) - amt; return d > 0 && d <= tol; });
        if (fee.length) {
          res.kind = 'candidate'; res.rule = 'fee'; res.reason = '手数料差の可能性（残額より少ない・' + tol.toLocaleString() + '円以内）'; res.confidence = 0.8;
          res.candidates = fee.map(function (v) { return cand(v, '残額より ' + (remainOf(v) - amt).toLocaleString() + '円少ない', 0.8, remainOf(v) - amt); });
          return res;
        }
        if (list.length) {
          var more = sum < amt;
          res.kind = 'candidate'; res.rule = more ? 'over' : 'partial';
          res.reason = more ? '過入金の可能性（未入金の合計より多い）' : '分割・不足の可能性';
          res.candidates = list.map(function (v) { return cand(v, '名義一致・金額不一致', 0.5); });
          return res;
        }
        res.kind = 'unknown'; res.reason = '名義は一致したが、その取引先に未入金の請求書がない';
        return res;
      }
      // 完全一致なし: 部分一致（3文字以上）と金額一致を候補に出す。ファジー照合（サーバー）の対象
      var partial = {};
      if (nm.length >= 3) Object.keys(idx).forEach(function (k) { if (k.length >= 3 && (k.indexOf(nm) >= 0 || nm.indexOf(k) >= 0)) Object.keys(idx[k]).forEach(function (c) { partial[c] = true; }); });
      open.forEach(function (v) {
        var p = !!partial[v.customer_id], m = remainOf(v) === amt;
        if (p && m) res.candidates.push(cand(v, '名義の一部と金額が一致', 0.6));
        else if (p) res.candidates.push(cand(v, '名義の一部が一致', 0.4));
        else if (m) res.candidates.push(cand(v, '金額だけ一致', 0.3));
      });
      if (res.candidates.length) {
        res.kind = 'candidate'; res.rule = 'fuzzy'; res.reason = '名義が完全には一致しない（候補から選ぶ）'; res.needs_fuzzy = true;
        res.candidates.sort(function (a, b) { return b.confidence - a.confidence; });
        res.candidates = res.candidates.slice(0, 3);
        res.confidence = res.candidates[0].confidence;
      } else res.needs_fuzzy = true;
      return res;
    });

    // 同じ請求書を2つ以上の入金が自動で取り合ったら、どちらも候補に落とす（誤消込を防ぐ側に倒す）
    var claim = {};
    out.forEach(function (r) { if (r.kind === 'auto') r.allocs.forEach(function (a) { claim[a.document_id] = (claim[a.document_id] || 0) + 1; }); });
    out.forEach(function (r) {
      if (r.kind === 'auto' && r.allocs.some(function (a) { return claim[a.document_id] > 1; })) {
        r.kind = 'candidate'; r.rule = 'conflict'; r.reason = '同じ請求書に当たる入金が他にもある（どちらか選ぶ）'; r.allocs = [];
      }
    });
    return out;
  };

  // ── 結果の集計（確定率・内訳）──
  RC.summarize = function (results) {
    var s = { total: results.length, auto: 0, candidate: 0, unknown: 0, by_rule: {} };
    results.forEach(function (r) { s[r.kind]++; var k = r.rule || 'unknown'; s.by_rule[k] = (s.by_rule[k] || 0) + 1; });
    s.auto_rate = s.total ? s.auto / s.total : 0;
    return s;
  };

  // ── CSV 書き出し（Excel で開けるよう BOM 付き）──
  RC.toCsv = function (rows, cols) {
    var q = function (v) { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return '﻿' + [cols.map(function (c) { return q(c.label); }).join(',')]
      .concat(rows.map(function (r) { return cols.map(function (c) { return q(typeof c.get === 'function' ? c.get(r) : r[c.key]); }).join(','); })).join('\r\n');
  };

  // ── 督促文面の下書き（テンプレは沖の確定待ち。確定するまで「下書き」の表示を消さない）──
  RC.dunningDraft = function (customerName, docs, round, opts) {
    opts = opts || {};
    var yen = function (n) { return '¥' + Number(n || 0).toLocaleString(); };
    var total = docs.reduce(function (a, d) { return a + Number(d.remain || 0); }, 0);
    var lines = docs.map(function (d) { return '・' + d.doc_number + '（' + (d.issue_date || '') + ' 発行・お支払期日 ' + (d.due_date || '') + '）残額 ' + yen(d.remain); });
    var head = customerName + ' 御中\n\nいつもお世話になっております。館山ジビエセンター（合同会社アルコ）です。\n\n';
    var body = round <= 1
      ? '下記のご請求について、' + (opts.as_of || '') + '時点で当方でご入金を確認できておりません。\nすでにお振込みいただいている場合は、行き違いとなり失礼いたしました。お手数ですがご確認をお願いいたします。\n\n'
      : '先日ご連絡いたしました下記のご請求について、お支払期日を過ぎておりますが、' + (opts.as_of || '') + '時点でご入金を確認できておりません。\n' + (opts.new_due ? opts.new_due + ' までに' : '') + 'お振込みいただきますようお願いいたします。\n\n';
    return head + body + lines.join('\n') + '\n\n合計 ' + yen(total) + '\n\nご不明な点がございましたらご連絡ください。\nよろしくお願いいたします。';
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = RC;
  else root.ReconCore = RC;
})(typeof window !== 'undefined' ? window : this);
