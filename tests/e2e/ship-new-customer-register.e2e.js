// 直販出荷: 新しいお客さんはその場で顧客台帳に登録してつなぐ（住所はあとでも可）（2026-10-02）
//
//   きっかけ
//     出荷先の名前だけで出荷すると、顧客台帳に無い名前の注文は顧客につながらず、請求書作成で
//     そのお客さんを選んでも出てこなかった（直近30日で7件。京城苑・おてんとさん・Couche・
//     ウブリアカーレ・なきざかな… 毎回あとから手で紐付け）。同じ症状が3回を超えたので構造を変える。
//     現場は時間が無いこともあるので「住所はあとで（送り状の写真・Googleマップを送る）」も選べるようにする。
//
//   ここで測ること
//     1. 台帳にある出荷先（lookupでidが返る）は何も聞かず、登録もしない
//     2. 台帳に無い出荷先は確定前に「新しいお客さん」を聞く。キャンセルなら何も書き込まない
//     3. 「住所はあとで」→ 住所なしで登録RPCを呼び、注文・出荷が新しい顧客につながる
//     4. 住所・電話・価格を入れたらその内容で登録し、単価はその価格ランクで付く
//     5. 住所も電話も空で「登録」は止める（あとでを使う）
//     6. 登録RPCが失敗しても出荷は記録し、失敗をエラーで出す（黙らない）
//     7. 住所未登録のお客さんの一覧が出荷画面に出る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9105);
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const p = await b.newPage();
  const errors = []; p.on('pageerror', e => errors.push(String(e)));
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

  const PM = [{ id: 'pm1', species: 'イノシシ', part_name: 'モモ', grade: '並', price_standard: 2600, price_local: 2400 }];
  let lookup = null, registerFails = false;
  const w = { orders: [], items: [], ships: [], register: [] };
  await p.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = (x, st) => rt.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (/\/rpc\/staff_lookup_customer_id/.test(url)) return J(lookup);
    if (/\/rpc\/staff_register_customer_on_ship/.test(url)) {
      w.register.push(JSON.parse(req.postData() || '{}'));
      if (registerFails) return J({ message: '顧客台帳に「X」が2件あります' }, 400);
      return J('new-cust-id');
    }
    if (/\/rpc\/staff_pending_customers/.test(url)) return J([{ code: 'C0846', name: '和ビストロおてんとさん', created_at: '2026-10-02T00:00:00Z', last_order_code: 'DIR-1', last_order_date: '2026-09-29' }]);
    if (m === 'GET' && /\/price_master/.test(url)) return J(PM);
    if (m === 'GET' && /\/customers\?id=eq\./.test(url)) return J([{ price_rank: 'standard', notes: '' }]);
    if (m === 'POST' && /\/orders/.test(url)) { const bd = JSON.parse(req.postData() || '{}'); w.orders.push(bd); return J([{ id: 'ord-' + w.orders.length }], 201); }
    if (m === 'POST' && /\/order_items/.test(url)) { w.items.push(...JSON.parse(req.postData() || '[]')); return J([], 201); }
    if (m === 'POST' && /\/shipments/.test(url)) { w.ships.push(JSON.parse(req.postData() || '{}')); return J([{ id: 'sh' }], 201); }
    return J([]);
  });
  await p.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));
  await p.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  await p.goto('http://localhost:9105/index.html'); await p.waitForTimeout(700);
  await p.evaluate(() => { window.__t = []; window.toast = (m, k) => window.__t.push([m, k]); window.confirm = () => true; });

  const item = { id: 'inv-1', ident_code: 'TGC-08-T331-MOU', part_name: 'モモ（ウチ）', species: 'イノシシ', grade: '並', weight: 1.0 };
  const start = (name) => p.evaluate(({ name, item }) => {
    window.__t = []; shipDirectItems = [item]; shipDirectRender();
    document.getElementById('ship-direct-cust').value = name;
    window.__done = false; window.__p = shipDirectConfirm().then(() => { window.__done = true; });
  }, { name, item });
  const modalOpen = () => p.$eval('#shipNewCustModal', el => el.style.display === 'block');
  const finish = async () => { await p.waitForFunction(() => window.__done, null, { timeout: 5000 }); return p.evaluate(() => window.__t); };
  const reset = () => { w.orders = []; w.items = []; w.ships = []; w.register = []; };

  // 1) 台帳にある出荷先
  reset(); lookup = 'cust-existing';
  await start('既存のお店'); await p.waitForTimeout(300);
  T('台帳にある出荷先は何も聞かない', !(await modalOpen()), '');
  await finish();
  T('台帳にある出荷先は登録しない・既存idでつなぐ', w.register.length === 0 && w.orders[0] && w.orders[0].customer_id === 'cust-existing', JSON.stringify(w.orders[0]));

  // 2) 新規 → キャンセル
  reset(); lookup = null;
  await start('新しいお店A'); await p.waitForTimeout(300);
  T('台帳に無い出荷先は「新しいお客さん」を聞く', await modalOpen(), '');
  T('お店の名前が表示される', (await p.$eval('#snc-name', el => el.textContent)) === '新しいお店A', '');
  await p.click('#snc-cancel'); await finish();
  T('キャンセルなら何も書き込まない', w.orders.length === 0 && w.register.length === 0, JSON.stringify(w));

  // 3) 新規 → 住所はあとで
  reset();
  await start('新しいお店B'); await p.waitForTimeout(300);
  await p.click('#snc-later'); const t3 = await finish();
  T('「あとで」→ 住所なしで登録RPCを呼ぶ', w.register.length === 1 && w.register[0].p_name === '新しいお店B' && w.register[0].p_address === null, JSON.stringify(w.register));
  T('注文が新しい顧客につながる', w.orders[0] && w.orders[0].customer_id === 'new-cust-id', JSON.stringify(w.orders[0]));
  T('出荷も新しい顧客につながる', w.ships[0] && w.ships[0].customer_id === 'new-cust-id', JSON.stringify(w.ships[0]));
  T('完了メッセージで「住所はあとで（送り状の写真か Google マップ）」と伝える', t3.some(([m]) => /送り状の写真か Google マップ/.test(m)), JSON.stringify(t3));

  // 4) 新規 → 住所・電話・ローカル価格で登録
  reset();
  await start('新しいお店C'); await p.waitForTimeout(300);
  await p.fill('#snc-address', '〒150-0002 東京都渋谷区渋谷1-6-8'); await p.fill('#snc-phone', '03-6427-1442');
  await p.selectOption('#snc-rank', 'local');
  await p.click('#snc-save'); await finish();
  T('入れた住所・電話・価格で登録する', w.register[0] && w.register[0].p_address === '〒150-0002 東京都渋谷区渋谷1-6-8' && w.register[0].p_phone === '03-6427-1442' && w.register[0].p_price_rank === 'local', JSON.stringify(w.register));
  T('単価は選んだ価格（ローカル 2,400円）', w.items[0] && w.items[0].unit_price === 2400 && w.items[0].price_rank_applied === 'local', JSON.stringify(w.items[0]));

  // 5) 住所も電話も空で「登録」は止める
  reset();
  await start('新しいお店D'); await p.waitForTimeout(300);
  await p.click('#snc-save'); await p.waitForTimeout(200);
  T('住所も電話も空なら登録しない（モーダルが開いたまま）', await modalOpen() && w.register.length === 0, '');
  await p.click('#snc-cancel'); await finish();

  // 6) 登録RPCが失敗しても出荷は記録し、エラーを出す
  reset(); registerFails = true;
  await start('同名が2件のお店'); await p.waitForTimeout(300);
  await p.click('#snc-later'); const t6 = await finish();
  T('登録に失敗しても出荷は記録する', w.orders.length === 1 && !w.orders[0].customer_id, JSON.stringify(w.orders[0]));
  T('登録の失敗をエラーで出す', t6.some(([m, k]) => k === 'error' && /顧客台帳に登録できませんでした/.test(m)), JSON.stringify(t6));
  registerFails = false;

  // 7) 住所未登録の一覧
  await p.evaluate(() => shipPendingCustLoad()); await p.waitForTimeout(200);
  const pend = await p.$eval('#ship-pending-cust', el => el.innerText);
  T('住所未登録のお客さんの一覧が出る', /住所が未登録のお客さん 1件/.test(pend) && /和ビストロおてんとさん/.test(pend), pend);

  T('ページエラーなし', errors.length === 0, errors.join(' / '));
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await b.close(); srv.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
