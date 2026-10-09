// 道の駅の店舗リンク（outlet.html?store=トークン）でも「訂正」「期限切れ・廃棄」を使えるようにする（2026-10-10）
//
//   きっかけ
//     9/28 に「訂正」「期限切れ・廃棄」を追加したが、店舗リンクの画面では販売報告だけに絞っていたため
//     出ていなかった。さらに読み込み中だけ全ボタン（納品・訂正など）が見えてすぐ消えるので、
//     お店からは「一瞬だけ表示されて入力できない」状態だった（おふくろ・あわ海月堂）。
//
//   ここで測ること
//     1. 読み込み中も含め、店舗リンクで「納品を記録」と「納品方法（編集）」が一度も見えない（ちらつかない）
//     2. 店舗リンクで「販売報告」「期限切れ・廃棄」「訂正」「履歴」が押せる
//     3. 訂正は理由が無いと保存しない。保存すると店名（店舗入力）・符号付き数量・その店あてで記録される
//     4. 期限切れ・廃棄も同じく店名で記録され、店頭在庫だけ減る（センター在庫は触らない）
//     5. 入力欄の小さい在庫表示は、店舗リンクでは自店の店頭在庫
//     6. 職員の画面（トークンなし）は従来どおり納品・訂正などすべて出る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const OUTLET = { id: 'o1', name: 'おふくろ', delivery_notes: '手数料30%' };
const PRODS = [{ id: 'p120', name: '味付け肉 うま辛 120g', unit: '袋', stock_qty: 20, price: 500 }, { id: 'p250', name: '味付け肉 うま辛 250g', unit: '袋', stock_qty: 9, price: 1000 }];

async function open(browser, query) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  const posts = [], patches = [];
  const moves = [{ product_id: 'p120', movement_type: '納品', qty: 5, destination: 'おふくろ' }, { product_id: 'p250', movement_type: '納品', qty: 5, destination: 'おふくろ' }];
  await page.route('**/rest/v1/**', async rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = x => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m === 'GET' && /\/retail_outlets\b/.test(url)) return J([OUTLET]);
    if (m === 'GET' && /\/products\b/.test(url)) { await new Promise(r => setTimeout(r, 400)); return J(PRODS); } // 読み込みを遅くしてちらつきを測る
    if (m === 'GET' && /\/staff\b/.test(url)) return J([{ name: '沖浩志' }]);
    if (m === 'GET' && /\/product_movements\b/.test(url)) return J(/店頭販売/.test(url) ? [] : moves);
    if (m === 'POST' && /\/product_movements\b/.test(url)) { const b = JSON.parse(req.postData()); (Array.isArray(b) ? b : [b]).forEach(x => { posts.push(x); moves.push(x); }); return J([]); }
    if (m === 'PATCH') { patches.push(url); return J([]); }
    return J([]);
  });
  // 読み込みの最初から、見えたボタンを記録する
  await page.addInitScript(() => {
    window.__seen = new Set();
    const tick = () => {
      ['btn-nohin', 'btn-teisei', 'btn-kigen', 'notes-card'].forEach(id => { const e = document.getElementById(id); if (e && e.offsetParent !== null) window.__seen.add(id); });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../outlet.html') + query);
  await page.waitForTimeout(1200);
  return { page, ctx, errors, posts, patches };
}
const vis = (page, id) => page.$eval('#' + id, e => e.offsetParent !== null);

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  const s = await open(browser, '?store=tok');
  const seen = await s.page.evaluate(() => [...window.__seen]);
  T('店舗リンク: 読み込み中も「納品を記録」「納品方法」が一度も見えない（ちらつかない）', !seen.includes('btn-nohin') && !seen.includes('notes-card'), JSON.stringify(seen));
  const v = { hanbai: await vis(s.page, 'btn-hanbai'), kigen: await vis(s.page, 'btn-kigen'), teisei: await vis(s.page, 'btn-teisei'), nohin: await vis(s.page, 'btn-nohin') };
  T('店舗リンク: 販売報告・期限切れ・訂正が押せる／納品は出ない', v.hanbai && v.kigen && v.teisei && !v.nohin, JSON.stringify(v));
  T('店舗リンク: 説明に訂正・期限切れの案内', /訂正/.test(await s.page.$eval('.card .memo', e => e.textContent)), '');

  // 訂正
  await s.page.click('#btn-teisei');
  const small = await s.page.$$eval('#f-products small', es => es.map(e => e.textContent));
  T('入力欄の在庫表示は自店の店頭在庫（センター在庫ではない）', small[0] === '店頭在庫 5' && small[1] === '店頭在庫 5', JSON.stringify(small));
  await s.page.fill('.f-qty[data-pid="p120"]', '-2');
  await s.page.fill('.f-qty[data-pid="p250"]', '2');
  await s.page.click('#f-save'); await s.page.waitForTimeout(200);
  T('訂正: 理由が無いと保存しない', s.posts.length === 0, String(s.posts.length));
  await s.page.fill('#f-note', '250g×2 を 120g×2 と報告ミス');
  await s.page.click('#f-save'); await s.page.waitForTimeout(400);
  const c = s.posts.filter(x => x.movement_type === '訂正');
  T('訂正: 店名（店舗入力）・符号付き数量・この店あてで記録', c.length === 2 && c.every(x => x.staff_name === 'おふくろ(店舗入力)' && x.destination === 'おふくろ') && c.find(x => x.product_id === 'p120').qty === -2 && c.find(x => x.product_id === 'p250').qty === 2, JSON.stringify(c));

  // 期限切れ
  await s.page.click('#btn-kigen');
  await s.page.fill('.f-qty[data-pid="p250"]', '1');
  await s.page.click('#f-save'); await s.page.waitForTimeout(1000);
  const k = s.posts.filter(x => x.movement_type === '期限切れ');
  T('期限切れ: 店名で記録し、センター在庫（products）は触らない', k.length === 1 && k[0].qty === 1 && k[0].staff_name === 'おふくろ(店舗入力)' && s.patches.length === 0, JSON.stringify(k) + ' patches=' + s.patches.length);
  const stock = await s.page.$$eval('#stock-body tr', trs => trs.map(t => t.textContent.replace(/\s+/g, ' ').trim()));
  T('店頭在庫に反映（120g: 5-2=3、250g: 5+2-1=6）', /120g ?3$/.test(stock[0]) && /250g ?6$/.test(stock[1]), JSON.stringify(stock));
  await s.page.click('button:has-text("履歴")'); await s.page.waitForTimeout(300);
  T('店舗リンク: 履歴が見られる', await vis(s.page, 'history-card') && /訂正/.test(await s.page.$eval('#history-body', e => e.textContent)), '');
  T('pageerrorなし（店舗リンク）', s.errors.length === 0, s.errors.join(' / '));
  await s.ctx.close();

  // 職員の画面は従来どおり
  // 朝6時台（日本時間）に開いても日付が前日にならない
  {
    const ctx = await browser.newContext({ timezoneId: 'Asia/Tokyo' });
    const pg = await ctx.newPage();
    await pg.addInitScript(() => { const R = Date; const fixed = new R('2026-10-10T06:42:00+09:00').getTime(); window.Date = class extends R { constructor(...a) { super(...(a.length ? a : [fixed])); } static now() { return fixed; } }; });
    await pg.route('**/rest/v1/**', rt => rt.fulfill({ status: 200, contentType: 'application/json', body: /retail_outlets/.test(rt.request().url()) ? JSON.stringify([OUTLET]) : /products/.test(rt.request().url()) ? JSON.stringify(PRODS) : '[]' }));
    await pg.goto('file://' + path.resolve(__dirname, '../../outlet.html') + '?store=tok'); await pg.waitForTimeout(600);
    await pg.click('#btn-hanbai');
    const d = await pg.$eval('#f-date', e => e.value);
    T('日付: 日本時間の朝6:42に開くと当日（2026-10-10）が入る', d === '2026-10-10', d);
    await ctx.close();
  }
  const st = await open(browser, '');
  await st.page.click('button.chip:has-text("おふくろ")'); await st.page.waitForTimeout(900);
  const sv = { nohin: await vis(st.page, 'btn-nohin'), teisei: await vis(st.page, 'btn-teisei'), notes: await vis(st.page, 'notes-card') };
  T('職員の画面: 納品・訂正・納品方法が出る', sv.nohin && sv.teisei && sv.notes, JSON.stringify(sv));
  await st.page.click('#btn-nohin');
  T('職員の画面: 入力欄の在庫表示はセンター在庫', (await st.page.$$eval('#f-products small', es => es.map(e => e.textContent)))[0] === 'センター在庫 20', '');
  T('pageerrorなし（職員）', st.errors.length === 0, st.errors.join(' / '));
  await st.ctx.close();

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
