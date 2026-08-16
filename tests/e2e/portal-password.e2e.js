// 注文サイト 仮パスワード方式のモックE2E（order.html 初回変更 / order-admin 平文消去）。
// Codex P1-6 対応: ハードコードした絶対パス・セッション固有のscratchpadを使わない。
//   ・リポジトリルートは __dirname から解決
//   ・Chromium は env(PW_CHROMIUM_PATH) → 既知の候補 → バンドル同梱の順で解決
//   ・成果物（スクショ）は env(PORTAL_E2E_ARTIFACTS) → なければ mkdtemp の一時ディレクトリ
//   ・実データ・実認証情報は使わない。Supabase RPC/REST は page.route で固定モックへ差し替える
// 実行: node tests/e2e/portal-password.e2e.js

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');            // tests/e2e/ から2つ上
const ARTIFACTS = process.env.PORTAL_E2E_ARTIFACTS
  || fs.mkdtempSync(path.join(os.tmpdir(), 'portal-pw-e2e-'));
try { fs.mkdirSync(ARTIFACTS, { recursive: true }); } catch (e) {}

// Playwright 本体の解決（プロジェクト依存 → 既知のグローバル）
function loadChromium() {
  const tries = [process.env.PLAYWRIGHT_PATH, 'playwright',
    '/opt/node22/lib/node_modules/playwright'].filter(Boolean);
  for (const m of tries) { try { return require(m).chromium; } catch (e) {} }
  console.error('playwright モジュールが見つかりません（PLAYWRIGHT_PATH で指定できます）');
  process.exit(2);
}
// Chromium 実行ファイルの解決（無ければ undefined＝バンドル同梱を使う）
function resolveChromePath() {
  const cands = [process.env.PW_CHROMIUM_PATH,
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean);
  return cands.find(p => { try { return fs.existsSync(p); } catch (e) { return false; } });
}

(async () => {
  const chromium = loadChromium();
  const chromePath = resolveChromePath();

  // 静的サーバ（リポジトリのHTMLをそのまま配信）。空きポートを自動割当。
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]);
    if (p === '/') p = '/order.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(ROOT, p.replace(/^\/+/, '')))); }
    catch (e) { r.statusCode = 404; r.end('nf'); }
  });
  await new Promise(res => srv.listen(0, res));
  const BASE = 'http://127.0.0.1:' + srv.address().port;

  const b = await chromium.launch(chromePath ? { executablePath: chromePath } : {})
    .catch(() => chromium.launch());

  const out = [];
  const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (!c && e ? ' — ' + String(e).slice(0, 120) : ''));
  const jFill = (route, x) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
  const FUTURE = new Date(Date.now() + 20 * 60000).toISOString();

  // ───────── order.html: 仮パスワード → 初回変更 ─────────
  const CUSTOMER_PII = { code: 'C0001', name: 'モック商店', honorific: '様', price_rank: 'standard',
    portal_login_id: 'c0001', phone: '0470-00-1234', address: '館山市テスト1-2-3', building: '', default_time_zone: '0000' };
  const CATALOG = [
    { product_id: 'p1', display_name: 'ロース', species: 'イノシシ', grade_label: '', mark: '◎',
      unit_price: 3800, is_orderable: true, min_order_kg: 0.5, step_kg: 0.5, is_favorite: false, description: '' }
  ];
  const CHANGE_TOKEN = 'CHANGE_ONLY_TOKEN_mock';
  const REAL_TOKEN = 'REAL_SESSION_TOKEN_mock';
  const TEMP_PW = '123456';

  async function newOrderPage(loginResponder) {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', e => errs.push(String(e)));
    page.on('dialog', d => d.accept().catch(() => {}));
    // 注: Playwright は「後から登録したルートが優先」。汎用フォールバックを先に、
    //     RPC専用を後に登録して RPC を確実に横取りする。
    await page.route('**/rest/v1/**', route => jFill(route, []));
    await page.route('**/rest/v1/rpc/**', async route => {
      const fn = route.request().url().split('/rpc/')[1].split('?')[0];
      let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      if (fn === 'portal_login_v2') return jFill(route, loginResponder(body));
      if (fn === 'portal_complete_temp_password') {
        if (body.p_temp_token === CHANGE_TOKEN && String(body.p_new || '').length >= 8)
          return jFill(route, [{ status: 'ok', token: REAL_TOKEN, expires_at: FUTURE }]);
        return jFill(route, [{ status: 'invalid', token: null, expires_at: null }]);
      }
      if (fn === 'portal_me') return jFill(route, [CUSTOMER_PII]);
      if (fn === 'portal_catalog') return jFill(route, CATALOG);
      if (fn === 'portal_usual_items') return jFill(route, []);
      if (fn === 'portal_last_order') return jFill(route, null);
      if (fn === 'portal_logout') return jFill(route, null);
      return jFill(route, []);
    });
    return { ctx, page, errs };
  }

  // A) 仮パスワードでログイン → 変更画面。PIIは出さない・トークンは保存しない（P1-1/P1-5）
  {
    const { ctx, page, errs } = await newOrderPage(body =>
      (body.p_login === 'c0001' && body.p_password === TEMP_PW)
        ? [{ status: 'ok', token: CHANGE_TOKEN, must_change: true, code: null, name: null,
             honorific: null, price_rank: null, portal_login_id: null, phone: null,
             address: null, building: null, default_time_zone: null }]
        : [{ status: 'invalid', token: null, must_change: null }]);
    await page.goto(BASE + '/order.html');
    await page.fill('#lg-id', 'c0001'); await page.fill('#lg-pw', TEMP_PW);
    await page.click('#lg-btn');
    await page.waitForSelector('#scr-changepw:not(.hidden)', { timeout: 5000 }).catch(() => {});
    const changeVisible = await page.isVisible('#scr-changepw');
    const listHidden = !(await page.isVisible('#scr-list'));
    ck('A1 仮pwログインで初回変更画面が表示される', changeVisible && listHidden);

    // PII（顧客名・住所・電話）がDOMに出ていない
    const bodyText = await page.evaluate(() => document.body.innerText);
    const noPii = !bodyText.includes('モック商店') && !bodyText.includes('館山市テスト') && !bodyText.includes('0470-00-1234');
    ck('A2 変更前はPIIを表示しない', noPii);

    // 変更専用トークンは sessionStorage/localStorage に保存されていない（メモリのみ）
    const storage = await page.evaluate(() => ({
      ss: JSON.stringify(sessionStorage), ls: JSON.stringify(localStorage) }));
    const tokenNotStored = !storage.ss.includes(CHANGE_TOKEN) && !storage.ls.includes(CHANGE_TOKEN);
    ck('A3 変更専用トークンを永続化しない（P1-5）', tokenNotStored, storage.ss);

    // クライアント側バリデーション: 短いpw / 不一致
    await page.fill('#cp-new', 'short'); await page.fill('#cp-confirm', 'short');
    await page.click('#cp-btn');
    const weakMsg = await page.textContent('#cp-err');
    ck('A4 8文字未満はクライアントで弾く', /8文字/.test(weakMsg || ''), weakMsg);
    await page.fill('#cp-new', 'GoodPass123'); await page.fill('#cp-confirm', 'GoodPass999');
    await page.click('#cp-btn');
    const mismatchMsg = await page.textContent('#cp-err');
    ck('A5 確認不一致を弾く', /一致しません/.test(mismatchMsg || ''), mismatchMsg);

    // 正常変更 → 一覧へ。新トークンだけを保存し、平文/変更トークンは残さない
    await page.fill('#cp-new', 'GoodPass123'); await page.fill('#cp-confirm', 'GoodPass123');
    await page.click('#cp-btn');
    await page.waitForSelector('#scr-list:not(.hidden)', { timeout: 5000 }).catch(() => {});
    const listShown = await page.isVisible('#scr-list');
    ck('A6 変更成功で商品一覧へ遷移', listShown);
    const nameShown = await page.textContent('#h-name');
    ck('A7 変更後にPII(顧客名)を取得表示', /モック商店/.test(nameShown || ''), nameShown);

    const post = await page.evaluate((keys) => {
      const ss = JSON.stringify(sessionStorage), ls = JSON.stringify(localStorage);
      const cpNew = document.getElementById('cp-new');
      return { ss, ls, tok: sessionStorage.getItem('tg_ptoken') || '', cpVal: cpNew ? cpNew.value : '' };
    });
    ck('A8 変更後は本セッショントークンを保存', post.tok === REAL_TOKEN, post.tok);
    const noResidue = !post.ss.includes('GoodPass123') && !post.ls.includes('GoodPass123')
      && !post.ss.includes(CHANGE_TOKEN) && !post.ls.includes(CHANGE_TOKEN) && post.cpVal === '';
    ck('A9 平文パスワード/変更トークンの残存なし（P1-5）', noResidue);
    ck('A10 JSエラーなし', errs.length === 0, errs[0]);
    await page.screenshot({ path: path.join(ARTIFACTS, 'order-changepw.png') }).catch(() => {});
    await ctx.close();
  }

  // B) ログイン失敗は理由を区別せず単一メッセージ（列挙防止＝P1-2）
  {
    const { ctx, page } = await newOrderPage(() =>
      [{ status: 'invalid', token: null, must_change: null }]);
    await page.goto(BASE + '/order.html');
    await page.fill('#lg-id', 'c0001'); await page.fill('#lg-pw', '000000');
    await page.click('#lg-btn');
    await page.waitForTimeout(300);
    const err = await page.textContent('#lg-err');
    const stillLogin = await page.isVisible('#scr-login');
    ck('B1 失敗は汎用メッセージ（理由を区別しない）', /ログインできませんでした/.test(err || '') && stillLogin, err);
    // ロック相当（サーバは同じ invalid を返す）でも同じ文面
    ck('B2 メッセージに具体的な失敗理由（ロック/停止等）を含めない',
      !/ロック|停止|無効|存在しない/.test(err || ''), err);
    await ctx.close();
  }

  // ───────── order-admin.html: 発行した平文の消去（P1-5） ─────────
  {
    const ctx = await b.newContext({ viewport: { width: 1200, height: 900 }, acceptDownloads: true });
    const page = await ctx.newPage();
    const errs = []; page.on('pageerror', e => errs.push(String(e)));
    page.on('dialog', d => d.accept().catch(() => {}));
    // スタッフキーを事前投入して prompt を出さない（実キーではないモック値）
    await page.addInitScript(() => { try { localStorage.setItem('tg_staff_key', 'MOCK_STAFF_KEY'); } catch (e) {} });

    const CUST = { id: 'cust-1', code: 'C0001', name: 'モック商店', kana: 'モックショウテン',
      honorific: '様', portal_login_id: 'c0001', portal_enabled: true, is_active: true,
      phone: '0470-00-1234', email: '', address: '館山市テスト1-2-3', building: '', price_rank: 'standard' };
    const ISSUED_PW = '654321';

    // 後勝ちのため 汎用→customers→rpc の順で登録（rpc を最優先に）
    await page.route('**/rest/v1/**', route => jFill(route, []));
    await page.route('**/rest/v1/customers**', route => jFill(route, [CUST]));
    await page.route('**/rest/v1/rpc/**', async route => {
      const fn = route.request().url().split('/rpc/')[1].split('?')[0];
      if (fn === 'staff_key_ok') return jFill(route, true);
      if (fn === 'staff_issue_portal_passwords')
        return jFill(route, [{ customer_id: 'cust-1', code: 'C0001', name: 'モック商店', login_id: 'c0001', password: ISSUED_PW }]);
      if (fn === 'admin_issue_customer_link')
        return jFill(route, [{ customer_id: 'cust-1', token: 'LINK_TOKEN_mock' }]);
      return jFill(route, []);
    });

    await page.goto(BASE + '/order-admin.html');
    await page.waitForTimeout(300);

    // 顧客を読み込み、CSV発行（平文を含む）→ finally で消去されることを確認
    const res = await page.evaluate(async () => {
      await loadCustomers();
      renderCustomers();
      // 発行→CSV書き出し（confirm は自動 accept）
      await exportPortalCsv();
      // 名簿オブジェクトから平文が消えていること
      const anyPw = (window.allCustomers || []).some(c => c.__issuedPw || c.__issuedLink);
      return { anyPw, ss: JSON.stringify(sessionStorage), ls: JSON.stringify(localStorage) };
    });
    ck('C1 CSV発行後、名簿メモリから平文を消去（P1-5）', res.anyPw === false);
    const noPwInStorage = !res.ss.includes(ISSUED_PW) && !res.ls.includes(ISSUED_PW)
      && !res.ss.includes('LINK_TOKEN_mock') && !res.ls.includes('LINK_TOKEN_mock');
    ck('C2 平文パスワード/リンクを storage に保存しない', noPwInStorage);

    // コピー1件→ finally 消去
    const res2 = await page.evaluate(async () => {
      await portalCopyOne('cust-1');
      return (window.allCustomers || []).some(c => c.__issuedPw || c.__issuedLink);
    });
    ck('C3 案内文コピー後も平文を消去', res2 === false);

    ck('C4 JSエラーなし（admin）', errs.length === 0, errs[0]);
    await page.screenshot({ path: path.join(ARTIFACTS, 'order-admin-portal.png') }).catch(() => {});
    await ctx.close();
  }

  await b.close();
  srv.close();

  console.log('\n=== portal-password E2E ===');
  out.forEach(l => console.log('  ' + l));
  console.log('  artifacts: ' + ARTIFACTS);
  const failed = out.filter(l => l.startsWith('FAIL')).length;
  console.log(failed ? ('\n' + failed + ' FAILED') : '\nALL PASS (' + out.length + ')');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
