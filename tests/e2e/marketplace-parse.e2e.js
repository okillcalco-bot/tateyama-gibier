// 通販の注文メールの読み取り（integrations/marketplace-gmail/Code.gs）: 形式どおりに読めて、個人情報は持ち出さない
//
//   きっかけ（2026-11-19 沖）: さとふる・まいぷれ・AWAWA の注文をシステムに載せ、出荷したら在庫から引きたい。
//   メールの形式は本物と同じ並びで、名前・住所・番号はすべて架空に置き換えてある。
//
//   ここで測ること
//     1. さとふる: お礼品ID・名前・数量・集荷予定日・配送区分・寄付受付番号が読める
//     2. まいぷれ: 商品番号・商品名・数量・集荷日・商品内容・伝票番号が読める
//     3. AWAWA: 商品・部位・数量・金額が読める。「×3」「3点」どちらの書き方も読める。複数商品も読める
//     4. AWAWA: 届け先・購入者の名前・住所・電話は、どの行のどの欄にも入らない
//     5. 返信（Re:）や未集荷のお知らせは注文として取り込まない
//     6. 形式が変わって読めないメールは「（読み取れませんでした）」の行になる（黙って捨てない）
const path = require('path');
require.extensions['.gs'] = require.extensions['.js'];   // Apps Script のファイルをそのまま読む
const P = require(path.resolve(__dirname, '../../integrations/marketplace-gmail/Code.gs'));

const SATOFULL = `架空商店 様

寄付者様より下記お礼品のお申込みがありました。

【申込み小計】
********************************************
お礼品ID：1486491
お礼品名：館山ジビエ 満足セット 猪肉 計1kg(4種)
伝票品名：ジビエ猪肉4種計1kgセット
数量：1個
配送業者：ヤマト運輸
配送区分：クール便（冷凍便）
********************************************

【申込み明細】
********************************************
お礼品ID：1486491
お礼品名：館山ジビエ 満足セット 猪肉 計1kg(4種)
伝票品名：ジビエ猪肉4種計1kgセット
配送業者：ヤマト運輸
配送区分：クール便（冷凍便）

集荷予定日：2026-11-24
数量：2件
　　寄付受付番号：配送情報番号
　　2026111600000000001：100000001
　　2026111600000000002：100000002
********************************************
`;
const MYPL_SUB = '【出荷依頼】2026年11月30日 館山ジビエ2種セット （商品番号：1004297）';
const MYPL = `架空商店 様

「館山ジビエ2種セット（商品番号：1004297）」の注文が入りました。
＜集荷日＞ 2026-11-30
＜数量＞ 2 件
＜商品内容＞
・味付け肉（塩ニンニク味）250g×1袋
・山さんが焼き 210g×1袋
＜伝票番号＞
500000000001,500000000002

※伝票が届かない場合など、配送業者の担当ドライバーに問い合わせる際にお使いください。
`;
const AWAWA1 = `架空さん

-------------------------------
▼2026/11/5(木) AWAWA! FOOD受注分

館山産イノシシ肉ブロック 200g前後 <https://example.invalid/items/1> 部位：ロース(170g)　7点

合計7点(販売金額7,000円)

▼お届け先情報
架空店舗さま
〒000-0000
架空県架空市1-2-3
0000000000

▼ご購入者様情報
架空 太郎さま
〒000-0001
架空県架空市4-5-6
09000000000
-------------------------------
`;
const AWAWA2 = `▼2026/6/18(木) AWAWA! FOOD受注分
館山産イノシシ肉スライス5mm 300g ×1
館山産イノシシ肉味付け肉250g みそ味 ×2
合計3点
▼お客様のお届け先情報
架空 花子さま
〒000-0002 架空県架空町7-8-9
`;

const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

// 1. さとふる
const s = P.mpRowsFromMessage({ id: 'm1', from: 'info@satofull.co.jp', subject: '【さとふる】お礼品のお申込みがありました（2026年11月17日送付）', body: SATOFULL, date: '2026-11-16T19:51:41Z' });
T('1. さとふる: 1行', s.length === 1, s.length);
T('1. さとふる: お礼品ID・名前・数量2・集荷日', s[0] && s[0].item_code === '1486491' && /満足セット/.test(s[0].item_name) && s[0].qty === 2 && s[0].pickup_date === '2026-11-24', JSON.stringify(s[0]));
T('1. さとふる: 配送区分・寄付受付番号', s[0] && /冷凍/.test(s[0].delivery_class) && s[0].external_order_no === '2026111600000000001,2026111600000000002', JSON.stringify(s[0]));
T('1. 小計の塊を二重に数えない（明細だけ）', s.length === 1, s.length);

// 2. まいぷれ
const m = P.mpRowsFromMessage({ id: 'm2', from: 'mypl-gift@jimo.co.jp', subject: MYPL_SUB, body: MYPL });
T('2. まいぷれ: 商品番号・商品名・数量・集荷日', m[0] && m[0].item_code === '1004297' && m[0].item_name === '館山ジビエ2種セット' && m[0].qty === 2 && m[0].pickup_date === '2026-11-30', JSON.stringify(m[0]));
T('2. まいぷれ: 商品内容・伝票番号', m[0] && /塩ニンニク/.test(m[0].item_detail) && /山さんが/.test(m[0].item_detail) && m[0].tracking_nos === '500000000001,500000000002', JSON.stringify(m[0]));

// 3. AWAWA
const a1 = P.mpRowsFromMessage({ id: 'm3', from: 'account@fb-awa.com', subject: 'AWAWA! FOODから商品注文のお知らせ(26/11/5 2件目)', body: AWAWA1 });
T('3. AWAWA: 商品・部位・数量7・金額7000', a1.length === 1 && a1[0].item_name === '館山産イノシシ肉ブロック 200g前後' && a1[0].item_code === '館山産イノシシ肉ブロック 200g前後／ロース' && a1[0].qty === 7 && a1[0].amount === 7000, JSON.stringify(a1));
const a2 = P.mpRowsFromMessage({ id: 'm4', from: 'account@fb-awa.com', subject: 'AWAWA! FOODから商品注文のお知らせ(26/6/18)', body: AWAWA2 });
T('3. AWAWA: 「×n」で書かれた複数商品を読む', a2.length === 2 && a2[0].qty === 1 && a2[1].qty === 2 && /みそ味/.test(a2[1].item_name), JSON.stringify(a2));
T('3. AWAWA: 複数商品のときは金額を按分しない（空）', a2.every(r => r.amount == null), JSON.stringify(a2.map(r => r.amount)));

// 4. 個人情報を持ち出さない
const all = JSON.stringify(a1.concat(a2));
T('4. AWAWA: 届け先・購入者の名前・住所・電話がどこにも入らない', !/架空店舗|架空 太郎|架空 花子|〒|000-000|09000000000|0000000000|架空市|架空町/.test(all), all.slice(0, 300));

// 5. 注文以外は取り込まない
T('5. 返信（Re:）は取り込まない', P.mpRowsFromMessage({ id: 'r', from: 'account@fb-awa.com', subject: 'Re: AWAWA! FOODから商品注文のお知らせ(26/6/25)', body: AWAWA1 }).length === 0);
T('5. さとふるの未集荷のお知らせは取り込まない', P.mpRowsFromMessage({ id: 'n', from: 'info@satofull.co.jp', subject: '【さとふる】未集荷お礼品のお知らせにつきまして 2026/11/05', body: 'x' }).length === 0);
T('5. 対象外の送り主は取り込まない', P.mpRowsFromMessage({ id: 'o', from: 'someone@example.invalid', subject: '【出荷依頼】', body: MYPL }).length === 0);

// 6. 読めないメール
const bad = P.mpRowsFromMessage({ id: 'b', from: 'mypl-gift@jimo.co.jp', subject: '【出荷依頼】形式が変わったメール', body: '中身が違う' });
T('6. 読めない注文メールは「（読み取れませんでした）」の1行になる', bad.length === 1 && bad[0].item_name === '（読み取れませんでした）' && /確認してください/.test(bad[0].note), JSON.stringify(bad));

let pass = 0;
for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 220) + ']' : '')); if (ok) pass++; }
console.log(`\n${pass}/${results.length} passed`);
process.exit(pass === results.length ? 0 : 1);
