/**
 * 通販の注文メール → 館山ジビエ基幹システム（marketplace_orders）への自動取り込み
 *
 *   対象: さとふる（info@satofull.co.jp）／まいぷれのご当地ギフト（mypl-gift@jimo.co.jp）／
 *         AWAWA! FOOD（account@fb-awa.com）
 *
 *   動き方: Google Apps Script（沖さんの Google アカウントで動く）が15分ごとに Gmail を見て、
 *           注文メールから「商品・数・集荷日・伝票番号・金額」だけを読み取り、Supabase に入れる。
 *           同じメールは二度入らない（元メールのIDで止める）。
 *
 *   個人情報: AWAWA のメールにある届け先・購入者の名前・住所・電話は読み取らない（送らない）。
 *             さとふる・まいぷれのメールにはもともと届け先が無い。
 *
 *   設定（初回だけ。詳しくは README.md）
 *     1. script.google.com で新しいプロジェクトを作り、このファイルを貼る
 *     2. プロジェクトの設定 → スクリプト プロパティに
 *          SUPABASE_URL      … https://（プロジェクト）.supabase.co
 *          SUPABASE_ANON_KEY … 業務アプリと同じ公開キー（anon）
 *        を入れる（このファイルには書かない）
 *     3. installTrigger を1回実行（Gmail を読む許可を求められるので許可する）
 *
 *   読み取れなかったメールも「（読み取れませんでした）」の行として入れ、出荷タブで気づけるようにする
 *   （黙って捨てない）。
 */

var MP_SENDERS = {
  'info@satofull.co.jp': 'さとふる',
  'mypl-gift@jimo.co.jp': 'まいぷれ',
  'account@fb-awa.com': 'AWAWA'
};

/* ───────── 読み取り（Node のテストからも呼べるよう、Gmail に依存しない関数にしてある） ───────── */

function mpToHalf(s) {
  return String(s == null ? '' : s)
    .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/，/g, ',').replace(/：/g, ':');
}

function mpIsOrderMail(platform, subject) {
  subject = String(subject || '');
  if (/^\s*(re|fw|fwd)\s*:/i.test(subject)) return false;      // 返信・転送は注文ではない
  if (platform === 'さとふる') return /お礼品のお申込み/.test(subject);
  if (platform === 'まいぷれ') return /【出荷依頼】/.test(subject);
  if (platform === 'AWAWA') return /商品注文のお知らせ/.test(subject);
  return false;
}

/** さとふる: 【申込み明細】の * 区切りの塊ごとに1行 */
function mpParseSatofull(body) {
  var text = mpToHalf(body);
  var start = text.indexOf('【申込み明細】');
  if (start < 0) return [];
  var blocks = text.slice(start).split(/\*{5,}/);
  var out = [];
  blocks.forEach(function (b) {
    var id = (b.match(/お礼品ID:\s*(\d+)/) || [])[1];
    var name = (b.match(/お礼品名:\s*(.+)/) || [])[1];
    if (!id || !name) return;
    var qty = parseInt((b.match(/数量:\s*(\d+)/) || [])[1], 10);
    var pickup = (b.match(/集荷予定日:\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
    var receipts = [];
    var re = /(\d{15,}):(\d+)/g, m;
    while ((m = re.exec(b))) receipts.push(m[1]);
    out.push({
      item_code: id, item_name: name.trim(),
      item_detail: ((b.match(/伝票品名:\s*(.+)/) || [])[1] || '').trim() || null,
      qty: qty > 0 ? qty : 1, pickup_date: pickup,
      carrier: ((b.match(/配送業者:\s*(.+)/) || [])[1] || '').trim() || null,
      delivery_class: ((b.match(/配送区分:\s*(.+)/) || [])[1] || '').trim() || null,
      external_order_no: receipts.join(',') || null
    });
  });
  return out;
}

/** まいぷれ: 件名に商品名と商品番号、本文に集荷日・数量・商品内容・伝票番号 */
function mpParseMypl(subject, body) {
  var text = mpToHalf(body);
  var sub = mpToHalf(subject);
  var code = (sub.match(/商品番号:\s*(\d+)/) || text.match(/商品番号:\s*(\d+)/) || [])[1];
  var name = (text.match(/「(.+?)(?:（商品番号|\(商品番号)/) || [])[1] || (sub.match(/\d+日\s+(.+?)\s*[（(]商品番号/) || [])[1];
  if (!code || !name) return [];
  var qty = parseInt((text.match(/<数量>\s*(\d+)/) || text.match(/＜数量＞\s*(\d+)/) || [])[1], 10);
  var pickup = (text.match(/[<＜]集荷日[>＞]\s*(\d{4}-\d{2}-\d{2})/) || [])[1] || null;
  var contents = (text.match(/[<＜]商品内容[>＞]\s*([\s\S]*?)[<＜]伝票番号[>＞]/) || [])[1] || '';
  var tracking = ((text.match(/[<＜]伝票番号[>＞]\s*([\d,\s]+)/) || [])[1] || '').replace(/\s+/g, '').replace(/,+$/, '');
  return [{
    item_code: code, item_name: name.trim(),
    item_detail: contents.split(/\n/).map(function (s) { return s.replace(/^[・\s]+/, '').trim(); }).filter(Boolean).join(' / ') || null,
    qty: qty > 0 ? qty : 1, pickup_date: pickup, carrier: '佐川急便', delivery_class: null,
    tracking_nos: tracking || null
  }];
}

/**
 * AWAWA: 「受注分」から「合計」までの商品行だけを読む。
 * 「▼お届け先」「▼ご購入者」以降（名前・住所・電話）は読まない。
 */
function mpParseAwawa(body) {
  var text = mpToHalf(body);
  var cut = text.search(/▼\s*(お客様の)?(お届け先|ご購入者)/);
  if (cut >= 0) text = text.slice(0, cut);              // 個人情報の手前で切る
  var s = text.search(/受注分/);
  if (s < 0) return [];
  var region = text.slice(s).replace(/^受注分[^\n]*\n?/, '');
  var e = region.search(/合計\s*\d+\s*点/);
  var amount = null;
  if (e >= 0) {
    var am = region.slice(e).match(/販売金額\s*([\d,]+)\s*円/);
    if (am) amount = parseInt(am[1].replace(/,/g, ''), 10);
    region = region.slice(0, e);
  }
  var out = [];
  region.split(/\n/).forEach(function (raw) {
    var line = raw.replace(/<https?:[^>]*>/g, ' ').replace(/https?:\S+/g, ' ').replace(/[　\s]+/g, ' ').trim();
    if (!line || /^2件目$|^\d+件目$/.test(line)) return;
    var qm = line.match(/(?:[×xX]\s*(\d+)|(\d+)\s*点)\s*$/);
    if (!qm) return;
    var qty = parseInt(qm[1] || qm[2], 10);
    line = line.slice(0, qm.index).trim();
    var detail = null;
    var dm = line.match(/部位\s*:\s*(.+)$/);
    if (dm) { detail = '部位:' + dm[1].trim(); line = line.slice(0, dm.index).trim(); }
    var name = line.replace(/^\d+件目\s*/, '').trim();
    if (!name) return;
    var part = dm ? dm[1].replace(/[（(].*$/, '').trim() : '';
    out.push({ item_code: name + (part ? '／' + part : ''), item_name: name, item_detail: detail, qty: qty > 0 ? qty : 1 });
  });
  if (out.length === 1 && amount != null) out[0].amount = amount;   // 1商品のときだけ金額を行に付ける（按分しない）
  return out;
}

/** 1通のメール → marketplace_orders の行（読み取れなければ「読み取れませんでした」の1行） */
function mpRowsFromMessage(msg) {
  var platform = MP_SENDERS[String(msg.from || '').toLowerCase()];
  if (!platform || !mpIsOrderMail(platform, msg.subject)) return [];
  var items = platform === 'さとふる' ? mpParseSatofull(msg.body)
    : platform === 'まいぷれ' ? mpParseMypl(msg.subject, msg.body)
    : mpParseAwawa(msg.body);
  if (!items.length) {
    items = [{ item_code: null, item_name: '（読み取れませんでした）', qty: 1,
      note: '注文メールの形式が変わった可能性があります。Gmail の「' + String(msg.subject || '').slice(0, 60) + '」を確認してください' }];
  }
  return items.map(function (it, i) {
    return {
      platform: platform, source_message_id: String(msg.id), line_no: i + 1,
      received_at: msg.date || null,
      external_order_no: it.external_order_no || null,
      item_code: it.item_code || null, item_name: it.item_name, item_detail: it.item_detail || null,
      qty: it.qty, amount: it.amount != null ? it.amount : null,
      pickup_date: it.pickup_date || null, carrier: it.carrier || null, delivery_class: it.delivery_class || null,
      tracking_nos: it.tracking_nos || null, note: it.note || null
    };
  });
}

/* ───────── Gmail と Supabase をつなぐ部分（Apps Script 上でだけ動く） ───────── */

function importMarketplaceOrders() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('SUPABASE_URL'), key = props.getProperty('SUPABASE_ANON_KEY');
  if (!url || !key) throw new Error('スクリプト プロパティに SUPABASE_URL と SUPABASE_ANON_KEY を入れてください');
  var q = 'from:(' + Object.keys(MP_SENDERS).join(' OR ') + ') newer_than:21d';
  var threads = GmailApp.search(q, 0, 100);
  var rows = [];
  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      var from = (m.getFrom().match(/<([^>]+)>/) || [null, m.getFrom()])[1].trim();
      rows = rows.concat(mpRowsFromMessage({
        id: m.getId(), from: from, subject: m.getSubject(),
        body: m.getPlainBody(), date: m.getDate().toISOString()
      }));
    });
  });
  if (!rows.length) return 0;
  var res = UrlFetchApp.fetch(url.replace(/\/$/, '') + '/rest/v1/marketplace_orders?on_conflict=source_message_id,line_no', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: key, Authorization: 'Bearer ' + key, Prefer: 'resolution=ignore-duplicates,return=minimal' },
    payload: JSON.stringify(rows)
  });
  var code = res.getResponseCode();
  if (code >= 300) throw new Error('取り込みに失敗しました（' + code + '）: ' + res.getContentText().slice(0, 300));   // 失敗は Apps Script の実行ログとメール通知に出る
  return rows.length;
}

/** 15分ごとの自動実行を入れる（1回だけ実行する。二重に入らないよう既存のものは外してから入れる） */
function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'importMarketplaceOrders') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('importMarketplaceOrders').timeBased().everyMinutes(15).create();
  return importMarketplaceOrders();
}

if (typeof module !== 'undefined') {
  module.exports = { mpParseSatofull: mpParseSatofull, mpParseMypl: mpParseMypl, mpParseAwawa: mpParseAwawa, mpRowsFromMessage: mpRowsFromMessage, mpIsOrderMail: mpIsOrderMail };
}
