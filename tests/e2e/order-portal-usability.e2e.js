// 注文ページ（お客さん側）の見直し（2026-11-20 沖「注文システムは下記の観点で見直して」）
//
//   実測で分かったこと: 注文394件のうち注文ページからは8件。在庫のしるし（◎△×）の説明なし・商品を探す欄なし・
//   読み込みに失敗すると5秒の知らせだけで白い画面・履歴にセンターの社内メモが出る・注文後の状況は履歴を開かないと見えない。
//
//   ここで測ること（お客様・商品・注文はすべて架空）
//     1. 在庫のしるしの説明が一覧に出ている
//     2. 商品をさがす: ひらがな・カタカナを区別せず、種類をまたいで見つかる。在庫なしも出る。消すと元に戻る
//     3. いちおし（掲示板に載せた商品）に印が付き、掲示に掲載日が出る
//     4. 進行中の注文が一覧のいちばん上に出る（受付・確認済み・発送済み。完了とキャンセルは出さない）
//     5. 履歴の「もう一度注文」でカートに入り、一覧へ戻る。入らなかった商品は知らせる
//     6. 履歴にセンターの社内メモを出さない（伝票番号だけ出す）
//     7. 使い方・お店の案内が開ける。電話番号は押せば電話できる。番号を空にしたら出さない（うその番号を出さない）
//     8. 読み込みに失敗したら消えない知らせと「もう一度読み込む」が出て、押すと直る
//     9. 確定ボタンの名前が、押す前・失敗の知らせ・押したあとで同じ
//    10. スマホの幅で横にはみ出さない／ページエラーなし
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const P = (id, name, species, mark, price, extra) => Object.assign({ product_id: id, display_name: name, species, mark, unit_price: price, is_orderable: true, min_order_kg: 0.5, step_kg: 0.5, is_favorite: false, grade_label: '', description: '' }, extra || {});
const CATALOG = [
  P('p1', 'ロース ブロック', 'イノシシ', '◎', 5000),
  P('p2', 'モモ スライス', 'イノシシ', '△', 4000),
  P('p3', 'ミンチ', 'イノシシ', '×', 2500),
  P('p4', 'ロース ブロック', 'シカ', '◎', 4500),
  P('p5', 'ばら肉', 'イノシシ', '◎', 3800),
];
const ORDERS = [
  { id: 'o1', order_code: 'ORD-TEST-1', status: '受注', order_date: '2026-11-19', delivery_date: '2026-11-25', total_amount: 5000, can_doc: false, items: [{ name: 'イノシシ ロース ブロック', kg: 1 }], shipments: [] },
  { id: 'o2', order_code: 'ORD-TEST-2', status: '発送済', order_date: '2026-11-10', delivery_date: '2026-11-12', total_amount: 9000, can_doc: true, items: [{ name: 'シカ ロース ブロック', kg: 2 }], shipments: [{ shipment_date: '2026-11-11', carrier: 'ヤマト', size_code: 80, is_cool: true, notes: 'ヤマト 123456789012。本人の明細から追記起票（架空の社内メモ）' }] },
  { id: 'o3', order_code: 'ORD-TEST-3', status: '納品完了', order_date: '2026-10-01', delivery_date: '2026-10-03', total_amount: 3000, can_doc: true, items: [{ name: 'イノシシ ミンチ', kg: 1 }], shipments: [{ shipment_date: '2026-10-02', notes: '2026-10-02 架空商店宛 手書きメモより起票' }] },
  { id: 'o4', order_code: 'ORD-TEST-4', status: 'キャンセル', order_date: '2026-09-01', total_amount: 0, can_doc: false, items: [{ name: 'イノシシ ばら肉', kg: 1 }], shipments: [] },
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const net = { failCatalog: false, placeFail: false, rebuilt: [] };
  await page.route('**/rest/v1/**', rt => {
    const url = rt.request().url();
    const J = (x, s) => rt.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (!/\/rpc\//.test(url)) return J([]);
    const fn = url.split('/rpc/')[1].split('?')[0];
    const body = JSON.parse(rt.request().postData() || '{}');
    if (fn === 'portal_login_v2') return J([{ status: 'ok', token: 'T', must_change: false, name: '架空食堂', honorific: '様' }]);
    if (fn === 'portal_me') return J([{ name: '架空食堂', honorific: '様', address: '架空県架空市1-1' }]);
    if (fn === 'portal_catalog') return net.failCatalog ? J({ message: 'テスト用の通信失敗' }, 503) : J(CATALOG);
    if (fn === 'portal_bulletins') return J([{ id: 'b1', product_id: 'p5', title: '今週のいちおし', body: '脂がのっています', badge: 'いちおし', sort_order: 1, created_at: new Date(Date.now() - 2 * 86400000).toISOString(), image_url: '' }]);
    if (fn === 'portal_my_orders') return J(ORDERS);
    if (fn === 'portal_rebuild_cart') { net.rebuilt.push(body); return J([{ status: 'ok', product_id: 'p4', name: 'シカ ロース ブロック', old_kg: 2, suggest_kg: 2, unit_price: 4500 }, { status: 'out_of_stock', product_id: 'p3', name: 'イノシシ ミンチ', reason: '在庫がありません' }]); }
    if (fn === 'portal_place_order') return net.placeFail ? rt.abort() : J({ order_code: 'ORD-TEST-9', items: [], total_amount: 0 });
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../order.html'));
  await page.waitForTimeout(300);

  // 7. ログイン画面: 電話番号が未設定なら出さない
  const lg = await page.evaluate(() => { const a = document.querySelector('#scr-login a[href^="tel:"]'); const r = a ? a.getBoundingClientRect() : { height: 0 }; const on = { text: document.getElementById('lg-tel').innerText.trim(), href: a && a.getAttribute('href'), h: r.height };
    const keep = SHOP_INFO.tel; SHOP_INFO.tel = ''; renderShopInfo();
    const off = { text: document.getElementById('lg-tel').innerText, link: !!document.querySelector('#scr-login a[href^="tel:"]'), guide: document.getElementById('shop-info').innerText };
    SHOP_INFO.tel = keep; renderShopInfo(); return { on, off }; });
  T('7. ログイン画面の「お電話ください」に、押せば電話できる番号が出る', lg.on.text === '0470-29-3919' && lg.on.href === 'tel:0470293919' && lg.on.h > 10, JSON.stringify(lg.on));
  T('7. 番号を空にしたら、番号を出さず案内の書面を見るよう伝える（うその番号を出さない）', lg.off.text === '' && !lg.off.link && /案内をご覧ください/.test(lg.off.guide), JSON.stringify(lg.off));

  await page.fill('#lg-id', 'C9999'); await page.fill('#lg-pw', 'password'); await page.click('#lg-btn');
  await page.waitForTimeout(600);

  // 1. しるしの説明
  const legend = await page.evaluate(() => { const e = document.querySelector('#mode-stock .legend'); const r = e.getBoundingClientRect(); return { text: e.innerText.replace(/\s+/g, ' '), h: r.height }; });
  T('1. 在庫のしるし（◎△×）の説明が一覧に出ている', /◎\s*十分あります/.test(legend.text) && /△\s*残りわずか/.test(legend.text) && /×\s*在庫なし/.test(legend.text) && legend.h > 10, legend.text);

  // 4. 進行中の注文
  const act = await page.evaluate(() => { const b = document.getElementById('myactive'); return { shown: !b.classList.contains('hidden'), n: b.querySelectorAll('.act').length, text: b.innerText.replace(/\s+/g, ' '), aboveProducts: b.getBoundingClientRect().top < document.getElementById('all-rows').getBoundingClientRect().top }; });
  T('4. 進行中の注文が一覧の上に出る（受付1・発送済み1。完了・キャンセルは出さない）', act.shown && act.n === 2 && act.aboveProducts && /受付しました/.test(act.text) && /発送しました/.test(act.text) && !/ばら肉|ミンチ/.test(act.text), JSON.stringify(act));
  T('4. 納品希望日が出る', /納品希望 2026年11月25日/.test(act.text), act.text);

  // 3. いちおし
  const pick = await page.evaluate(() => ({ badge: [...document.querySelectorAll('#all-rows .row')].filter(r => r.querySelector('.pick')).map(r => r.dataset.pid), others: document.querySelectorAll('#all-rows .row .pick').length, bull: document.getElementById('bulletins').innerText.replace(/\s+/g, ' ') }));
  const two = new Date(Date.now() - 2 * 86400000);
  T('3. 掲示板に載せた商品だけに「いちおし」の印が付く', pick.badge.join() === 'p5' && pick.others === 1, JSON.stringify(pick.badge));
  T('3. 掲示に掲載日が出る', pick.bull.includes((two.getMonth() + 1) + '月' + two.getDate() + '日 掲載'), pick.bull);

  // 2. さがす
  const search = async q => { await page.fill('#p-search', q); await page.waitForTimeout(350); return page.evaluate(() => ({ pids: [...document.querySelectorAll('#all-rows .row')].map(r => r.dataset.pid), text: document.getElementById('all-rows').innerText.replace(/\s+/g, ' '), tabsHidden: document.getElementById('sp-tabs').classList.contains('hidden') })); };
  let s = await search('ろーす');
  T('2. ひらがなで探してもカタカナの商品が見つかる（種類をまたぐ）', s.pids.slice().sort().join() === 'p1,p4' && s.tabsHidden, JSON.stringify(s.pids));
  s = await search('ミンチ');
  T('2. 在庫なしの商品も見つかる', s.pids.join() === 'p3', JSON.stringify(s.pids));
  s = await search('バラ');
  T('2. カタカナで探してもひらがなの商品が見つかる', s.pids.join() === 'p5', JSON.stringify(s.pids));
  s = await search('ｼｶ');
  T('2. 半角カナでも種類で見つかる', s.pids.join() === 'p4', JSON.stringify(s.pids));
  s = await search('存在しない商品');
  T('2. 見つからないときは、そう伝えて相談の場所を案内する', s.pids.length === 0 && /見つかりません/.test(s.text) && /ご相談/.test(s.text), s.text);
  await page.click('#p-search-clear'); await page.waitForTimeout(250);
  s = await page.evaluate(() => ({ pids: [...document.querySelectorAll('#all-rows .row')].map(r => r.dataset.pid), tabsHidden: document.getElementById('sp-tabs').classList.contains('hidden'), v: document.getElementById('p-search').value }));
  T('2. ×で消すと元の一覧（種類の切替つき）に戻る', s.v === '' && !s.tabsHidden && s.pids.join() === 'p1,p2,p5', JSON.stringify(s));

  // 7. 使い方・お店の案内
  await page.click('#guideBox summary'); await page.waitForTimeout(150);
  const guide = await page.evaluate(() => { const g = document.getElementById('guideBox'); return { open: g.open, text: g.innerText.replace(/\s+/g, ' '), tel: !!g.querySelector('a[href^="tel:"]') }; });
  T('7. 使い方（注文の流れ・前回と同じ注文・予約）が読める', guide.open && /ご注文の流れ/.test(guide.text) && /この内容で注文する/.test(guide.text) && /もう一度注文/.test(guide.text) && /予約/.test(guide.text), guide.text.slice(0, 120));
  T('7. お店の名前・場所・電話番号（押せば電話できる）が出る', /館山ジビエセンター/.test(guide.text) && /館山市/.test(guide.text) && guide.tel && /電話 0470-29-3919/.test(guide.text), guide.text.slice(-160));
  await page.click('#guideBox summary');

  // 6. 履歴に社内メモを出さない
  await page.click('button:has-text("注文履歴")'); await page.waitForTimeout(400);
  const hist = await page.evaluate(() => document.getElementById('hist-rows').innerText.replace(/\s+/g, ' '));
  T('6. 履歴に伝票番号は出る', /伝票番号 123456789012/.test(hist), hist.slice(0, 200));
  T('6. 履歴にセンターの社内メモは出さない', !/追記起票|手書きメモ|社内メモ|架空商店宛/.test(hist), hist);
  const againN = await page.evaluate(() => [...document.querySelectorAll('#hist-rows .hcard')].map(c => !!c.querySelector('button[onclick^="reorderFrom"]')));
  T('5. 「もう一度注文」はキャンセル以外の注文に出る', againN.join() === 'true,true,true,false', againN.join());

  // 5. もう一度注文
  await page.evaluate(() => document.querySelectorAll('#hist-rows .hcard')[1].querySelector('button[onclick^="reorderFrom"]').click());
  await page.waitForTimeout(500);
  const re = await page.evaluate(() => ({ onList: !document.getElementById('scr-list').classList.contains('hidden'), cart: JSON.parse(sessionStorage.getItem('tg_cart') || '[]'), warn: document.getElementById('reorder-warn').innerText, bar: document.getElementById('bar-sum').innerText, go: document.getElementById('bar-go').disabled }));
  T('5. 押した注文で組み直しを頼む', net.rebuilt.length === 1 && Object.values(net.rebuilt[0]).includes('o2'), JSON.stringify(net.rebuilt));
  T('5. カートに入り、一覧へ戻って「確認へ」が押せる', re.onList && re.cart.length === 1 && re.cart[0].product_id === 'p4' && re.cart[0].kg === 2 && /1点/.test(re.bar) && !re.go, JSON.stringify(re));
  T('5. 入らなかった商品を知らせる', /イノシシ ミンチ/.test(re.warn) && /在庫がありません/.test(re.warn), re.warn);

  // 9. ボタンの名前
  await page.click('#bar-go'); await page.waitForTimeout(300);
  const b1 = await page.evaluate(() => document.getElementById('c-go').textContent.trim());
  net.placeFail = true;
  await page.click('#c-go'); await page.waitForTimeout(700);
  const b2 = await page.evaluate(() => ({ btn: document.getElementById('c-go').textContent.trim(), toast: [...document.querySelectorAll('#toasts .toast')].map(e => e.textContent).join(' / ') }));
  T('9. 確定ボタンの名前が、押す前・失敗の知らせ・押したあとで同じ', b1 === 'この内容で注文する' && b2.btn === b1 && b2.toast.includes('「' + b1 + '」'), JSON.stringify({ b1, b2 }));
  await page.waitForTimeout(5600);
  const stay = await page.evaluate(() => document.querySelectorAll('#toasts .toast.err').length);
  T('9. 失敗の知らせは5秒では消えない（読み切れる）', stay >= 1, stay);
  await page.evaluate(() => document.querySelector('#toasts .toast.err').click());
  T('9. 知らせは押せば消える', (await page.evaluate(() => document.querySelectorAll('#toasts .toast.err').length)) === stay - 1);
  net.placeFail = false;

  // 10. はみ出し
  await page.evaluate(() => { showScreen('list'); });
  await page.waitForTimeout(200);
  const over = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
  T('10. スマホの幅で横にはみ出さない', over === 0, over);

  // 8. 読み込み失敗
  net.failCatalog = true;
  await page.evaluate(() => enterList()); await page.waitForTimeout(500);
  const fe = await page.evaluate(() => { const e = document.getElementById('list-err'); return { shown: !e.classList.contains('hidden'), text: e.innerText, btn: !!e.querySelector('button') }; });
  T('8. 読み込みに失敗したら、消えない知らせと「もう一度読み込む」が出る', fe.shown && /読み込めませんでした/.test(fe.text) && fe.btn, JSON.stringify(fe));
  await page.waitForTimeout(5500);
  T('8. 5秒たっても消えない', await page.evaluate(() => !document.getElementById('list-err').classList.contains('hidden')));
  net.failCatalog = false;
  await page.click('#list-err button'); await page.waitForTimeout(500);
  const ok = await page.evaluate(() => ({ hidden: document.getElementById('list-err').classList.contains('hidden'), rows: document.querySelectorAll('#all-rows .row').length }));
  T('8. 押すと読み直して商品が出る', ok.hidden && ok.rows === 3, JSON.stringify(ok));

  T('10. ページエラーなし', errors.length === 0, errors.join(' / '));
  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 240) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
