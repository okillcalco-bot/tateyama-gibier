// 中身の見直し 第2弾（2026-11-11）: 「確かめられなかった」を「問題なし」として扱っていた所
//
//   きっかけ
//     「中身はどう見直した？」— 全画面の見直し（#425）では、書き込みの失敗を捨てている候補のうち、
//     中まで読んだのは一部だった。残りと、「失敗を戻り値で返す関数の結果を見ていない呼び出し」を全部読んだ。
//     見つかったのは、どれも「確かめられなかった」ことを「無い／問題なし」と同じに扱う作りだった:
//       1. 出荷登録（直販）: 顧客の価格ランクを読めないと、何も出さずに standard の単価で記録する
//          （通信の失敗／この端末にスタッフキーが無く、顧客台帳が空で返るとき。ローカル・スタートメンバーのお客さんが高く請求される）
//       2. 出荷登録（直販）: 顧客の照合だけ失敗して登録の関数が既存の顧客を返したとき、ランクを読まずに standard にしていた
//       3. 出荷登録（直販）: 価格マスタを読めないと全部が単価なしになり、「価格マスタに単価が無く」と原因の違う知らせが出る
//       4. BASE の注文一覧: BASE がエラーを返すと「注文はありません」と出る（未発送の注文があっても気づけない）
//       5. BASE 連携の設定: BASE がエラーを返すと「BASE側に商品がありません」、確認に失敗すると「未接続です」と出る
//       6. ダッシュボード「今日やること」: 確認が全部失敗しても「✅ 本日の要対応はありません」と出る
//       7. 送料: 通信で計算できなかったときも「料金表にありません」と出る
//
//   ここで測ること（顧客・在庫・単価は架空）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const PM = [{ species: 'イノシシ', part_name: 'ロース', grade: '並', price_standard: 4000, price_local: 3500, price_startmember: 3600 }];
const ITEMS = [{ id: 'inv1', part_name: 'ロース', species: 'イノシシ', grade: '並', weight: 2, _via: 'scan' }];

async function open(browser, net, withKey) {
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 800 } });
  await ctx.addInitScript(k => {
    try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); if (k) localStorage.setItem('tg_staff_key', 'TESTKEY'); } catch (e) {}
    window.__dlg = []; window.alert = m => window.__dlg.push('alert:' + m); window.confirm = () => true; window.prompt = () => null; window.open = () => null;
    window.__rej = []; window.addEventListener('unhandledrejection', e => window.__rej.push(String(e.reason && e.reason.message || e.reason)));
  }, withKey);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    if (url.startsWith('file:')) return rt.continue();
    const J = (x, s) => rt.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(x) });
    const FAIL = () => J({ message: 'テスト用の通信失敗' }, 503);
    if (!/\/rest\/v1\//.test(url)) return rt.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    const table = url.split('/rest/v1/')[1].split('?')[0];
    if (net.failAll) return FAIL();
    if (m !== 'GET' && !/^rpc\//.test(table)) { let b = null; try { b = JSON.parse(req.postData() || 'null'); } catch (e) {} net.writes.push({ m, table, b }); }
    if (table === 'rpc/staff_lookup_customer_id') return net.lookup === 'throw' ? FAIL() : J(net.lookup === undefined ? 'cust-1' : net.lookup);
    if (table === 'rpc/staff_register_customer_on_ship') return J('cust-1');
    if (table === 'customers' && m === 'GET') { if (net.customers === 'throw') return FAIL(); return J(net.customers || []); }
    if (table === 'price_master') return net.pm === 'throw' ? FAIL() : J(PM);
    if (table === 'rpc/base_orders') return net.baseOrders === 'throw' ? FAIL() : J(net.baseOrders || { orders: [] });
    if (table === 'rpc/base_items') return J(net.baseItems || { items: [] });
    if (table === 'rpc/base_status') return net.baseStatus === 'throw' ? FAIL() : J({ connected: true });
    if (table === 'rpc/tgc_compute_freight') return net.freight === 'throw' ? FAIL() : J(net.freight === undefined ? null : net.freight);
    if (table === 'orders' && m === 'POST') return J([{ id: 'new-order' }], 201);
    if (m !== 'GET') return J([{ id: 'x' }], 201);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(900);
  return { ctx, page, errors };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);
  const warns = page => page.evaluate(() => [...document.querySelectorAll('#toasts [role=alert]')].map(e => e.textContent));
  const clear = page => page.evaluate(() => { document.querySelectorAll('#toasts .toast').forEach(e => e.remove()); });
  const ship = async (page, net, set, opts) => {
    Object.assign(net, { lookup: undefined, customers: null, pm: null }, set); net.writes.length = 0; await clear(page);
    const r = await page.evaluate(([items, o]) => recordDirectShipment(items, '架空食堂', o || {}).then(x => ({ ok: true, created: x.createdCustomer }), e => ({ ok: false, err: String(e.message || e) })), [ITEMS, opts || null]);
    await page.waitForTimeout(200);
    const order = net.writes.find(w => w.table === 'orders' && w.m === 'POST'); const item = net.writes.find(w => w.table === 'order_items' && w.m === 'POST');
    const it = item && (Array.isArray(item.b) ? item.b[0] : item.b);
    return { r, w: await warns(page), notes: order && order.b ? (order.b.notes || '') : null, unit: it ? it.unit_price : null, rank: it ? it.price_rank_applied : null, total: order && order.b ? order.b.total_amount : null };
  };

  // ── 1〜3. 出荷登録（直販）──
  {
    const net = { writes: [] };
    const { ctx, page, errors } = await open(browser, net, true);
    // ランクを読めた（ローカル）
    let s = await ship(page, net, { customers: [{ price_rank: 'local', notes: '' }] });
    T('ランクを読めたとき: その単価で記録し、知らせは出さない（ローカル 3,500円 × 2kg = 7,000円）', s.r.ok && s.unit === 3500 && s.rank === 'local' && s.total === 7000 && s.w.length === 0 && !/価格ランク未確認/.test(s.notes), JSON.stringify(s));
    // 1. 通信の失敗
    s = await ship(page, net, { customers: 'throw' });
    T('1. ランクを読めなかった（通信）: 出荷は記録する（standard 4,000円）', s.r.ok && s.unit === 4000 && s.rank === 'standard' && s.total === 8000, JSON.stringify(s.r) + ' ' + s.unit);
    T('1. 確かめられなかったことを画面に出す（出荷先・理由・standardで記録・請求前に直す）', s.w.some(x => /架空食堂 の価格ランクを確かめられませんでした（通信に失敗しました）/.test(x) && /standard の単価で記録/.test(x) && /請求前に単価を直して/.test(x)), s.w.join(' / '));
    T('1. 注文の備考に「価格ランク未確認」を残す（請求のときに気づける）', /価格ランク未確認（standardで計算。請求前に単価を確認）/.test(s.notes || ''), s.notes);
    s = await ship(page, net, { customers: 'throw' }, { memo: '常温で', operator: '架空 太郎' });
    T('1. もとのメモ・担当は消さない', /常温で/.test(s.notes || '') && /担当:架空 太郎/.test(s.notes || '') && /価格ランク未確認/.test(s.notes || ''), s.notes);
    // 1. 台帳が空で返る（キーあり）
    s = await ship(page, net, { customers: [] });
    T('1. 顧客台帳が空で返る（キーあり）: 黙らない', s.w.some(x => /顧客台帳からこの出荷先を読めませんでした/.test(x)) && /価格ランク未確認/.test(s.notes || ''), s.w.join(' / '));
    // 2. 照合だけ失敗 → 登録の関数が既存の顧客を返す
    s = await ship(page, net, { lookup: 'throw', customers: [{ price_rank: 'startmember', notes: '' }] });
    T('2. 照合だけ失敗しても、台帳のランクで記録する（スタートメンバー 3,600円。以前は standard）', s.r.ok && s.unit === 3600 && s.rank === 'startmember' && s.w.length === 0, JSON.stringify([s.unit, s.rank, s.w]));
    // 新しいお客さんを登録したとき（台帳を読めなくても、渡したランクで計算する）
    s = await ship(page, net, { lookup: null, customers: [] }, { newCustomer: { rank: 'local' } });
    T('新しく登録したお客さん: 渡したランク（ローカル）で記録し、知らせは出さない', s.r.ok && s.r.created && s.unit === 3500 && s.rank === 'local' && !s.w.some(x => /価格ランク/.test(x)), JSON.stringify([s.r, s.unit, s.rank, s.w]));
    // 3. 価格マスタを読めない
    s = await ship(page, net, { customers: [{ price_rank: 'local', notes: '' }], pm: 'throw' });
    T('3. 価格マスタを読めなかった: 原因どおりの知らせを出す（単価なしで記録・請求前に入れる）', s.r.ok && s.unit === null && s.w.some(x => /価格マスタを読み込めませんでした（通信）/.test(x) && /単価なし（0円）で記録/.test(x)), s.w.join(' / '));
    const rej = await page.evaluate(() => window.__rej.slice());
    T('出荷登録: ページエラー・未処理の例外なし', errors.length === 0 && rej.length === 0, errors.concat(rej).join(' / '));
    await ctx.close();
  }
  // 1. スタッフキーの無い端末
  {
    const net = { writes: [] };
    const { ctx, page } = await open(browser, net, false);
    const s = await ship(page, net, { customers: [] });
    T('1. スタッフキーの無い端末: 理由（キーが無く顧客台帳を読めない）を出して standard で記録', s.r.ok && s.unit === 4000 && s.w.some(x => /この端末にスタッフキーが無く、顧客台帳を読めません/.test(x)) && /価格ランク未確認/.test(s.notes || ''), s.w.join(' / ') + ' ' + JSON.stringify(s.r));
    await ctx.close();
  }

  // ── 4〜7. BASE・今日やること・送料 ──
  {
    const net = { writes: [], baseOrders: { error: 'invalid_request', error_description: 'アクセストークンが無効です' } };
    const { ctx, page, errors } = await open(browser, net, true);
    const boxText = id => page.evaluate(i => document.getElementById(i).innerText.replace(/\s+/g, ' '), id);
    await page.evaluate(() => loadBaseOrders()); await page.waitForTimeout(300);
    let t = await boxText('base-orders');
    T('4. BASEがエラーを返した: 「注文はありません」と出さず、失敗と理由を出す', /BASE注文の取得に失敗しました/.test(t) && /アクセストークンが無効です/.test(t) && !/注文はありません/.test(t), t.slice(0, 160));
    net.baseOrders = 'throw';
    await page.evaluate(() => loadBaseOrders()); await page.waitForTimeout(300);
    t = await boxText('base-orders');
    T('4. 通信の失敗: 失敗と出す', /BASE注文の取得に失敗しました/.test(t) && !/注文はありません/.test(t), t.slice(0, 120));
    net.baseOrders = { orders: [] };
    await page.evaluate(() => loadBaseOrders()); await page.waitForTimeout(300);
    t = await boxText('base-orders');
    T('4. 本当に注文が無いとき: 今までどおり「注文はありません」', /注文はありません/.test(t), t.slice(0, 80));
    net.baseOrders = { error: 'not_connected' };
    await page.evaluate(() => loadBaseOrders()); await page.waitForTimeout(300);
    t = await boxText('base-orders');
    T('4. 未接続のとき: 今までどおり「BASE未接続です」', /BASE未接続です/.test(t), t.slice(0, 80));

    // 5. BASE 連携の設定
    net.baseItems = { error: 'invalid_request', error_description: 'アクセストークンが無効です' };
    await page.evaluate(() => baseOpen()); await page.waitForTimeout(400);
    t = await boxText('base-mapping');
    T('5. 設定: BASEがエラーを返したら「BASE側に商品がありません」と出さない', !/BASE側に商品がありません/.test(t) && /アクセストークンが無効です/.test(t), t.slice(0, 160));
    net.baseStatus = 'throw';
    await page.evaluate(() => baseOpen()); await page.waitForTimeout(400);
    t = await boxText('base-status');
    T('5. 設定: 接続の確認に失敗したら「未接続です」と出さない', /確認できませんでした/.test(t) && !/未接続です/.test(t), t.slice(0, 100));
    net.baseStatus = null; net.baseItems = null;
    await page.evaluate(() => { document.getElementById('baseModal').style.display = 'none'; });

    // 7. 送料
    await page.evaluate(() => { shipSelectedOrderId = 'o1'; shipOrdersCache['o1'] = { order: { delivery_address: '架空県架空市1-1' } }; });
    net.freight = 'throw';
    await page.evaluate(() => shipFreightPreview()); await page.waitForTimeout(200);
    t = await boxText('ship-freight-preview');
    T('7. 送料: 通信で計算できなかったら、そう出す（「対象外の地域」と言わない）', /送料を計算できませんでした（通信）/.test(t) && !/対象外/.test(t), t);
    net.freight = null;
    await page.evaluate(() => shipFreightPreview()); await page.waitForTimeout(200);
    t = await boxText('ship-freight-preview');
    T('7. 送料: 料金表に無いときは今までどおり「未計算（対象外の地域/サイズ）」', /未計算（対象外の地域\/サイズ/.test(t), t);
    net.freight = 1450;
    await page.evaluate(() => shipFreightPreview()); await page.waitForTimeout(200);
    t = await boxText('ship-freight-preview');
    T('7. 送料: 計算できたら金額を出す', /¥1,450/.test(t), t);

    // 6. 今日やること
    net.failAll = true;
    await page.evaluate(() => loadTodayTodos()); await page.waitForTimeout(500);
    t = await boxText('today-todos');
    T('6. 確認が全部失敗: 「✅ 本日の要対応はありません」と出さない', !/本日の要対応はありません/.test(t) && /確認できなかった項目があります/.test(t) && /要対応が無いとは限りません/.test(t), t.slice(0, 200));
    T('6. 何を確認できなかったかを出す（新しい注文・BASEの注文 など）', /新しい注文・出荷待ちの注文/.test(t) && /BASEの注文/.test(t), t.slice(0, 200));
    net.failAll = false; net.baseOrders = { orders: [] };
    if (await page.$('#today-todos-failed button')) await page.click('#today-todos-failed button'); else await page.evaluate(() => loadTodayTodos());
    await page.waitForTimeout(600);
    t = await boxText('today-todos');
    T('6. 「もう一度確認」で読み直せる。全部確認できて0件なら「✅ 本日の要対応はありません」', !/確認できなかった/.test(t), t.slice(0, 160));
    net.baseOrders = { error: 'invalid_request', error_description: 'x' };
    await page.evaluate(() => loadTodayTodos()); await page.waitForTimeout(500);
    t = await boxText('today-todos');
    T('6. BASEだけ失敗: ほかの項目は出しつつ、BASEを確認できなかったと出す', /確認できなかった項目があります（BASEの注文）/.test(t), t.slice(0, 200));
    const rej = await page.evaluate(() => window.__rej.slice());
    T('BASE・今日やること・送料: ページエラー・未処理の例外なし', errors.length === 0 && rej.length === 0, errors.concat(rej).join(' / '));
    await ctx.close();
  }

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 280) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
