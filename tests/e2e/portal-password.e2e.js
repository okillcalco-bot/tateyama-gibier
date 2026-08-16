// 仮パスワード方式のモックE2E（order.html 初回変更画面 / order-admin 注文サイト設定カード・発行完了）
// 実データ・実認証情報は使わない。Supabase RPC は page.route で固定モック値に差し替える。
// 実行: node tests/e2e/portal-password.e2e.js
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ROOT = '/home/user/tateyama-gibier';
const SP = '/tmp/claude-0/-home-user-tateyama-gibier/09aef339-0036-54ec-b51f-5910cfb18b46/scratchpad';
const SHOTS = SP + '/shots';

(async () => {
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]);
    let base = ROOT;
    if (p.startsWith('/before/')) base = SP;       // /before/x.html -> SP/before/x.html
    if (p === '/') p = '/order.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(base, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9077);
  const b = await chromium.launch({ executablePath: CHROME }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (!c && e ? ' — ' + String(e).slice(0, 90) : ''));

  const FUTURE = new Date(Date.now() + 12 * 60000).toISOString();
  const CUSTOMER = { code: 'C0001', name: 'モック商店', honorific: '様', price_rank: 'standard', portal_login_id: 'c0001', phone: '', address: '', building: '', default_time_zone: '0000' };
  const CATALOG = [
    { product_id: 'p1', display_name: 'ロース', species: 'イノシシ', grade_label: '', mark: '◎', unit_price: 3800, is_orderable: true, min_order_kg: 0.5, step_kg: 0.5, low_kg: 3, is_favorite: false, description: '' },
    { product_id: 'p2', display_name: 'バラ', species: 'イノシシ', grade_label: '', mark: '◎', unit_price: 3100, is_orderable: true, min_order_kg: 0.5, step_kg: 0.5, low_kg: 3, is_favorite: false, description: '' }
  ];
  const jFill = route => x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
  const noHScroll = page => page.evaluate(() => { const e = document.scrollingElement || document.documentElement; return e.scrollWidth <= e.clientWidth + 1; });
  const minTapVisible = page => page.evaluate(() => { let min = 99; document.querySelectorAll('button,input,select').forEach(el => { if (el.offsetParent === null) return; const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) min = Math.min(min, r.height); }); return min; });

  async function orderRoute(page, calls) {
    await page.route('**/rest/v1/**', async route => {
      const j = jFill(route); const url = route.request().url();
      const m = url.match(/\/rpc\/([a-z_0-9]+)/); const fn = m ? m[1] : '';
      let body = {}; try { body = route.request().postDataJSON() || {}; } catch (e) {}
      if (fn === 'portal_login_v2') {
        const pw = body.p_password;
        if (pw === '000000') return j([{ status: 'ok', token: 'tok-temp', must_change: true, locked_until: null, ...CUSTOMER }]);
        if (pw === 'locked') return j([{ status: 'locked', locked_until: FUTURE }]);
        return j([{ status: 'invalid' }]);
      }
      if (fn === 'portal_change_password') {
        calls.change = (calls.change || 0) + 1; const np = body.p_new || '';
        if (np === 'password') return j([{ status: 'too_common' }]);
        if (np === body.p_old) return j([{ status: 'same_as_temp' }]);
        return j([{ status: 'ok', token: 'tok-real' }]);
      }
      if (fn === 'portal_me') return j([CUSTOMER]);
      if (fn === 'portal_catalog') { calls.catalog = (calls.catalog || 0) + 1; return j(CATALOG); }
      if (fn === 'portal_usual_items') return j([]);
      if (fn === 'portal_last_order') return j(null);
      return j([]);
    });
  }

  // ============ order.html 390px ============
  const ctxM = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const calls = {}; const pM = await ctxM.newPage(); const errsM = []; pM.on('pageerror', e => errsM.push(e.message));
  await orderRoute(pM, calls);
  await pM.goto('http://localhost:9077/order.html'); await pM.waitForSelector('#scr-login:not(.hidden)');
  await pM.fill('#lg-id', 'c0001'); await pM.fill('#lg-pw', 'zzzzzz'); await pM.click('#lg-btn'); await pM.waitForTimeout(300);
  ck('order:誤pwは共通エラー', /正しくありません/.test(await pM.textContent('#lg-err')));
  await pM.fill('#lg-pw', 'locked'); await pM.click('#lg-btn'); await pM.waitForTimeout(300);
  { const t = await pM.textContent('#lg-err'); ck('order:ロックは解除時刻表示', /停止/.test(t) && /解除予定/.test(t), t); }
  await pM.fill('#lg-pw', '000000'); await pM.click('#lg-btn'); await pM.waitForSelector('#scr-changepw:not(.hidden)');
  ck('order:仮pwで変更画面のみ', !(await pM.$eval('#scr-changepw', e => e.classList.contains('hidden'))) && (await pM.$eval('#scr-list', e => e.classList.contains('hidden'))));
  ck('order:変更前にcatalog未呼出', (calls.catalog || 0) === 0);
  ck('order:仮pwトークン非永続', await pM.evaluate(() => !sessionStorage.getItem('tg_ptoken')));
  ck('order:変更画面 横スクロールなし', await noHScroll(pM));
  ck('order:変更画面 タップ44px以上', (await minTapVisible(pM)) >= 44);
  await pM.screenshot({ path: SHOTS + '/after-order-changepw-390.png' });
  await pM.fill('#cp-new', 'sakura2026'); await pM.fill('#cp-confirm', 'sakura9999'); await pM.click('#cp-btn'); await pM.waitForTimeout(200);
  ck('order:確認不一致で拒否', /一致しません/.test(await pM.textContent('#cp-err')));
  await pM.fill('#cp-confirm', 'sakura2026'); await pM.click('#cp-btn'); await pM.waitForSelector('#scr-list:not(.hidden)');
  ck('order:変更成功で商品一覧へ', !(await pM.$eval('#scr-list', e => e.classList.contains('hidden'))) && (calls.catalog || 0) >= 1);
  ck('order:変更後トークン保存', await pM.evaluate(() => sessionStorage.getItem('tg_ptoken') === 'tok-real'));
  ck('order:商品一覧 横スクロールなし', await noHScroll(pM));
  ck('order:pageerror無し', errsM.length === 0, errsM[0]);
  await pM.screenshot({ path: SHOTS + '/after-order-list-390.png' });
  await ctxM.close();

  // order.html PC（変更画面）
  const ctxP = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const cP = {}; const pP = await ctxP.newPage(); await orderRoute(pP, cP);
  await pP.goto('http://localhost:9077/order.html'); await pP.waitForSelector('#scr-login:not(.hidden)');
  await pP.fill('#lg-id', 'c0001'); await pP.fill('#lg-pw', '000000'); await pP.click('#lg-btn'); await pP.waitForSelector('#scr-changepw:not(.hidden)');
  await pP.screenshot({ path: SHOTS + '/after-order-changepw-pc.png' });
  await ctxP.close();

  // before order.html（変更画面が無い基準版・ログイン画面）
  const ctxB = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const pB = await ctxB.newPage();
  await pB.route('**/rest/v1/**', route => { const j = jFill(route); return j([]); });
  await pB.goto('http://localhost:9077/before/order.html'); await pB.waitForSelector('#scr-login');
  await pB.screenshot({ path: SHOTS + '/before-order-login-390.png' });
  await ctxB.close();

  // ============ order-admin.html ============
  const MOCK_C = { id: 'c1', code: 'C0001', name: 'モック商店', portal_login_id: 'c0001', portal_enabled: false, is_active: true, price_rank: 'standard', honorific: '様' };
  let enabled = false, issued = 0;
  async function adminRoute(page) {
    await page.route('**/rest/v1/**', async route => {
      const j = jFill(route); const url = route.request().url();
      const m = url.match(/\/rpc\/([a-z_0-9]+)/); const fn = m ? m[1] : '';
      let body = {}; try { body = route.request().postDataJSON() || {}; } catch (e) {}
      if (fn === 'staff_key_ok') return j(true);
      if (fn === 'admin_portal_credential_status') return j([{ customer_id: 'c1', code: 'C0001', name: 'モック商店', portal_enabled: enabled, login_id: 'c0001', pw_state: (issued > 0 ? 'temp_issued' : 'unissued'), temp_issued_at: (issued > 0 ? new Date().toISOString() : null), last_login_at: null, locked: false, locked_until: null }]);
      if (fn === 'admin_set_portal_enabled') { enabled = !!body.p_enabled; return j({ ok: true }); }
      if (fn === 'staff_issue_portal_passwords') { issued++; return j([{ customer_id: 'c1', code: 'C0001', name: 'モック商店', login_id: 'c0001', password: '042719' }]); }
      if (fn === 'staff_unlock_portal') return j(true);
      return j([]);
    });
  }
  const ctxA = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctxA.addInitScript(() => { localStorage.setItem('tg_staff_key', 'K'); localStorage.setItem('tg_operator', 'テスト職員'); });
  const pA = await ctxA.newPage(); const errsA = []; pA.on('pageerror', e => errsA.push(e.message)); pA.on('dialog', d => d.accept());
  await adminRoute(pA);
  await pA.goto('http://localhost:9077/order-admin.html'); await pA.waitForTimeout(400);
  await pA.evaluate(c => { allCustomers = [c]; openEditCustomer('c1'); }, MOCK_C);
  await pA.waitForSelector('#custModal.show'); await pA.waitForTimeout(300);
  ck('admin:注文サイトカード表示', (await pA.$('.portal-card')) !== null);
  ck('admin:行全体トグル存在', (await pA.$('.portal-switch')) !== null);
  ck('admin:停止中表示', /停止中/.test(await pA.textContent('#cfPortalState')));
  await pA.screenshot({ path: SHOTS + '/after-admin-card-pc.png' });
  await pA.click('#cfPortalSwitch'); await pA.waitForTimeout(300);
  ck('admin:トグルで利用中(緑)', /利用中/.test(await pA.textContent('#cfPortalState')) && (await pA.$eval('#cfPortalSwitch', e => e.classList.contains('on'))));
  await pA.click('.portal-reissue'); await pA.waitForSelector('#pwIssueModal.show'); await pA.waitForTimeout(200);
  { const bd = await pA.textContent('#pwIssueBody'); ck('admin:完了画面 URL/ID/6桁/期限', /order\.html/.test(bd) && /c0001/.test(bd) && /042719/.test(bd) && /まで/.test(bd), bd.slice(0, 60)); }
  ck('admin:まとめ/LINE/印刷/閉じるボタン', (await pA.$('#pwIssueCopyBtn')) && (await pA.$('#pwIssueLineBtn')) && (await pA.$('button[onclick="pwIssuePrint()"]')) && (await pA.$('button[onclick="closePwIssue()"]')));
  await pA.screenshot({ path: SHOTS + '/after-admin-issue-pc.png' });
  await pA.click('button[onclick="closePwIssue()"]'); await pA.waitForTimeout(200);
  ck('admin:閉じたら6桁がDOMから消える', !/042719/.test((await pA.textContent('#pwIssueBody')) || ''));
  ck('admin:_pwIssueを破棄', await pA.evaluate(() => { try { return _pwIssue === null; } catch (e) { return true; } }));
  ck('admin:pageerror無し', errsA.length === 0, errsA[0]);
  await ctxA.close();

  // admin 390px（カード）
  const ctxA2 = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await ctxA2.addInitScript(() => { localStorage.setItem('tg_staff_key', 'K'); localStorage.setItem('tg_operator', 'テスト職員'); });
  const pA2 = await ctxA2.newPage(); pA2.on('dialog', d => d.accept()); await adminRoute(pA2);
  await pA2.goto('http://localhost:9077/order-admin.html'); await pA2.waitForTimeout(400);
  await pA2.evaluate(c => { allCustomers = [c]; openEditCustomer('c1'); }, MOCK_C);
  await pA2.waitForSelector('#custModal.show'); await pA2.waitForTimeout(300);
  ck('admin:390px 横スクロールなし', await noHScroll(pA2));
  ck('admin:390px カード内タップ44px以上', (await pA2.evaluate(() => { let min = 99; document.querySelectorAll('.portal-card button,.portal-card input').forEach(el => { if (el.offsetParent === null) return; const r = el.getBoundingClientRect(); if (r.height > 0) min = Math.min(min, r.height); }); return min; })) >= 44);
  await pA2.screenshot({ path: SHOTS + '/after-admin-card-390.png' });
  await ctxA2.close();

  // before admin（散在レイアウト）
  const ctxB2 = await b.newContext({ viewport: { width: 1280, height: 900 } });
  await ctxB2.addInitScript(() => { localStorage.setItem('tg_staff_key', 'K'); localStorage.setItem('tg_operator', 'テスト職員'); });
  const pB2 = await ctxB2.newPage();
  await pB2.route('**/rest/v1/**', route => { const j = jFill(route); const m = route.request().url().match(/\/rpc\/([a-z_0-9]+)/); if (m && m[1] === 'staff_key_ok') return j(true); return j([]); });
  await pB2.goto('http://localhost:9077/before/order-admin.html'); await pB2.waitForTimeout(400);
  await pB2.evaluate(c => { allCustomers = [c]; openEditCustomer('c1'); }, MOCK_C).catch(() => {});
  await pB2.waitForTimeout(300);
  await pB2.screenshot({ path: SHOTS + '/before-admin-edit-pc.png' });
  await ctxB2.close();

  await b.close(); srv.close();
  console.log(out.join('\n'));
  const fails = out.filter(l => l.startsWith('FAIL'));
  console.log('\n== ' + (out.length - fails.length) + '/' + out.length + ' PASS ==');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('E2E ERROR', e); process.exit(2); });
