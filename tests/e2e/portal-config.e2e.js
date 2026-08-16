const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/order-admin.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9062);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));

  const CMP = [{ product_id: 'p1', species: 'イノシシ', display_name: 'ロース', grade_label: '上',
    resolved_price: 4250, price_source: 'customer_override', price_rank_applied: null,
    standard_price: 4750, rank_label: 'standard', rank_price: 4750, override_price: 4250,
    has_override: true, diff_vs_standard: -500, orderable: true }];
  const USUAL = [{ product_id: 'p1', species: 'イノシシ', display_name: 'ロース', grade_label: '上',
    rank: 1, purchase_count: 5, total_kg: 12.5, avg_order_kg: 2.5, usual_qty_kg: 2.5,
    last_purchased_on: '2026-08-01', avg_interval_days: 14, reason: '購入実績 5回・合計12.5kg',
    is_pinned: false, is_hidden: false }];

  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await ctx.addInitScript(() => { localStorage.setItem('tg_staff_key', 'K'); localStorage.setItem('tg_operator', 'テスト職員'); });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  let setPortalCalled = 0, recomputeCalled = 0;

  await p.route('**/rest/v1/**', async route => {
    const url = route.request().url();
    const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    const m = url.match(/\/rpc\/([a-z_]+)/); const fn = m ? m[1] : '';
    let body = {}; try { body = route.request().postDataJSON() || {}; } catch (e) {}
    if (fn === 'staff_key_ok') return j(true);
    if (fn === 'admin_list_portal_enabled') return j([{ id: 'c1', code: 'A001', name: 'エー商店',
      price_rank: 'standard', is_active: true, portal_enabled: setPortalCalled > 0, has_login: true,
      order_count: 3, usual_items: 2 }]);
    if (fn === 'admin_set_portal_enabled') { setPortalCalled++; return j({ ok: true, portal_enabled: !!body.p_enabled }); }
    if (fn === 'admin_customer_price_comparison') return j(CMP);
    if (fn === 'admin_customer_usual_items') return j(USUAL);
    if (fn === 'admin_recompute_usual_items') { recomputeCalled++; return j({ ok: true, customers: 1, items: 1 }); }
    return j([]);
  });
  await p.on('dialog', d => d.accept());
  await p.goto('http://localhost:9062/order-admin.html'); await p.waitForTimeout(600);

  // ① タブ表示・一覧
  ck('①ポータル設定タブがある', await p.locator('.tab[data-tab="portalcfg"]').count() === 1);
  await p.locator('.tab[data-tab="portalcfg"]').click(); await p.waitForTimeout(400);
  ck('①フィルタ3種', await p.locator('#pcFilter .inv-sb').count() === 3);
  const bodyText = await p.locator('#pcBody').innerText();
  ck('①顧客行が出る(エー商店)', bodyText.includes('エー商店') && bodyText.includes('A001'));
  ck('①停止中バッジ', bodyText.includes('停止中'));

  // ② 390px 横スクロールなし
  const sw = await p.evaluate(() => document.documentElement.scrollWidth);
  ck('②横スクロールなし(390px)', sw <= 390, 'scrollWidth=' + sw);

  // ③ 価格・いつもの モーダル
  await p.locator('#pcBody .btn', { hasText: '価格・いつもの' }).click(); await p.waitForTimeout(400);
  ck('③モーダルが開く', await p.locator('#pcDetailModal').evaluate(el => el.classList.contains('show')));
  const dt = await p.locator('#pcDetailBody').innerText();
  ck('③価格比較表が出る', dt.includes('価格比較') && dt.includes('標準との差'));
  ck('③個別価格の出所と差額(-500)が出る', dt.includes('個別') && dt.includes('-500'), dt.replace(/\n/g, ' ').slice(0, 120));
  ck('③いつもの商品(5回)が出る', dt.includes('いつもの商品') && dt.includes('5'));

  // ④ この顧客のいつもの再集計
  await p.locator('#pcDetailBody .btn', { hasText: 'この顧客のいつものを再集計' }).click(); await p.waitForTimeout(400);
  ck('④顧客いつもの再集計が呼ばれた', recomputeCalled === 1);
  await p.locator('#pcDetailModal .modal-close').click(); await p.waitForTimeout(200);

  // ⑤ ポータル利用トグル
  await p.locator('#pcBody .btn', { hasText: '利用可にする' }).click(); await p.waitForTimeout(400);
  ck('⑤portal_enabledトグルが呼ばれた', setPortalCalled === 1);

  // ⑥ 全再集計
  await p.locator('.filter-bar .btn', { hasText: 'いつもの商品を全再集計' }).click(); await p.waitForTimeout(400);
  ck('⑥全再集計が呼ばれた', recomputeCalled === 2);

  // ⑦ 担当者名なしでは状態変更しない
  await p.evaluate(() => { localStorage.removeItem('tg_operator'); window.prompt = () => ''; });
  const before = setPortalCalled;
  await p.locator('#pcBody .btn', { hasText: /利用可にする|停止する/ }).first().click(); await p.waitForTimeout(200);
  ck('⑦担当者名なしではトグルしない', setPortalCalled === before, 'delta=' + (setPortalCalled - before));

  ck('JSエラーなし', errs.length === 0, errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
