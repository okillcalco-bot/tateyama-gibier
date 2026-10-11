// マスタの変更申請 → 責任者の承認（index.html 事務作業 ④・✅）（2026-10-11）
//
//   きっかけ: 「マスタ関係は全てベースをバイトさんにお願いしたい。バイトさんが作業したものを僕はチェックすればいいだけにして」（沖）
//     これまでは各画面から台帳を直接書き換えていて、確認待ちも変更履歴も無かった。
//
//   ここで測ること（DBの動きは migrations/20261011_master_change_requests.sql をロールバック付きで本番DBに流して確認済み）
//     1. 申請に入るのは「変えた項目だけ」。作業者名・照らした資料が無ければ止める
//     2. 口座番号は画面に出さない（下2桁だけ）。空欄なら申請に入れない。入れたら先頭0のまま文字で送る。数字以外は止める
//     3. 新規で似た登録があれば候補を見せて止め、「別のもの」を押したときだけ confirm_dup で申請
//     4. 申請に失敗したら画面に出し、ボタンを戻す（黙って消えない）
//     5. 申請の一覧（変更前→変更後）と取り下げ
//     6. 責任者: キーが違えば開かない。承認・差戻し（差戻しは理由が必要）。責任者キーは端末に保存しない
//     7. 責任者キーの設定: 2回の入力が違えば送らない。初回は「今のキー」なし
//     8. 日報に申請件数と申請の中身（口座番号なし）が入る
//     9. iPhone幅: 申請フォームが枠からはみ出さない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const CUST = { id: 'c1', code: 'C0101', name: 'テスト食堂', kana: null, phone: '0470-00-0000', address: '〒294-0000 館山市', is_active: true };
const HUNT = { id: 'h1', name: '猟師一郎', furigana: 'りょうしいちろう', bank_name: '館山信金', bank_branch: '本店', account_type: '普通', account_number: '0012345', account_holder: 'リョウシ イチロウ', has_gun: false };
const AKEY = 'good-approver-key';

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);
  const st = { calls: [], failNext: false, writesDirect: [] };
  const LIST = [
    { id: 'r1', table: 'customers', record_id: 'c1', action: 'update', label: 'テスト食堂', before: { kana: null }, after: { kana: 'てすとしょくどう' }, reason: '', source_doc: '注文書', requested_by: '花子', requested_at: '2026/10/11 10:00', status: '確認待ち' },
    { id: 'r2', table: 'hunters', record_id: 'h1', action: 'update', label: '猟師一郎', before: { account_number: '*****45' }, after: { account_number: '*****99' }, source_doc: '口座の届出書', requested_by: '花子', requested_at: '2026/10/11 10:05', status: '確認待ち' }
  ];

  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.setItem('tg_staff_key', 'k'); localStorage.setItem('tg_clk_by', '花子'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => { const a = st.dialog ? st.dialog.shift() : undefined; if (a === null) d.dismiss(); else d.accept(a === undefined ? '' : a); });
  await page.route('**/*', rt => {
    const req = rt.request(), u = req.url(), m = req.method();
    if (/^file:/.test(u)) return rt.continue();
    const J = (x, s = 200) => rt.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(x) });
    const rpc = (u.match(/rpc\/(\w+)/) || [])[1];
    if (rpc) {
      const b = JSON.parse(req.postData() || '{}');
      st.calls.push({ rpc, b });
      if (rpc === 'staff_master_request') {
        if (st.failNext) { st.failNext = false; return J({ code: 'P0001', message: 'テスト用の失敗' }, 400); }
        if (b.p.record_id == null && !b.p.confirm_dup) return J({ ok: false, need_confirm: true, dup: [{ id: 's9', label: 'ラップ（業務用）' }], error: '似た登録がすでにあります。同じものでないか確認してください' });
        return J({ ok: true, id: 'new' + st.calls.length });
      }
      if (rpc === 'staff_master_requests') return J(LIST);
      if (rpc === 'staff_master_withdraw') return J({ ok: true });
      if (rpc === 'admin_master_requests') return b.p_approver_key === AKEY ? J(LIST.map(r => r.id === 'r2' ? Object.assign({}, r, { before: { account_number: '0012345' }, after: { account_number: '0098799' } }) : r)) : J({ code: 'P0001', message: '責任者キーが違います' }, 400);
      if (rpc === 'admin_master_review') return J({ ok: true });
      if (rpc === 'admin_set_approver_key') return J({ ok: true, first: true });
      return J([]);
    }
    if (m !== 'GET') st.writesDirect.push(m + ' ' + u);
    if (/\/rest\/v1\/individuals/.test(u)) return new Promise(r => setTimeout(r, 700)).then(() => J([]));   // ①の読み込みを遅くする（画面の取り違えを測る）
    if (/\/rest\/v1\/customers/.test(u)) return J([CUST]);
    if (/\/rest\/v1\/hunters/.test(u)) return J([HUNT]);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(800);
  // 起動時の4桁コードの画面はこのテストの対象外なので外す（実際のクリックで操作するため）
  await page.evaluate(() => { const g = document.getElementById('passcode-gate'); if (g) g.remove();
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active')); const p = document.getElementById('panel-clerk'); p.classList.add('active'); p.style.display = 'block'; clerkLoad(); });
  await page.waitForTimeout(300);
  const calls = n => st.calls.filter(c => c.rpc === n);

  // ── ①の読み込みが終わる前に②③から「変更を申請」を開いても、①が上書きしない ──
  await page.evaluate(() => clerkShow('meat'));
  await page.evaluate(() => clkReqOpen('hunters', 'h1')); await page.waitForTimeout(1200);
  T('読み込みの遅い前の画面が、開いた申請フォームを上書きしない（エラーも出ない）', !!(await page.$('#mr-form #mrf-furigana')) && !/Cannot set|開けません/.test(await page.$eval('#toasts', e => e.textContent)), await page.$eval('#toasts', e => e.textContent));

  // ── 顧客: 探す → 変更を申請 → ふりがなだけ ──
  await page.evaluate(() => { mrState.table = 'customers'; mrState.cur = null; clerkShow('req'); }); await page.waitForTimeout(300);
  T('④ タブに申請の一覧が出る（変更前→変更後）', /てすとしょくどう/.test(await page.$eval('#mr-list', e => e.textContent)) && /（空欄）/.test(await page.$eval('#mr-list', e => e.textContent)), '');
  await page.fill('#mr-q', 'テスト'); await page.click('#clk-body button:has-text("探す")'); await page.waitForTimeout(300);
  await page.click('#mr-found button'); await page.waitForTimeout(200);
  await page.fill('#mrf-kana', 'てすとしょくどう');
  await page.click('#mr-send'); await page.waitForTimeout(200);
  T('照らした資料が無ければ申請しない', calls('staff_master_request').length === 0 && /照らした資料/.test(await page.$eval('#mr-msg', e => e.textContent)), '');
  await page.fill('#mrf-_src', '注文書 DIR-20261011-155644');
  st.failNext = true;
  await page.click('#mr-send'); await page.waitForTimeout(300);
  T('申請に失敗したら画面に出し、ボタンを戻す', /申請できませんでした.*テスト用の失敗/.test(await page.$eval('#mr-msg', e => e.textContent)) && !(await page.$eval('#mr-send', e => e.disabled)), await page.$eval('#mr-msg', e => e.textContent));
  await page.click('#mr-send'); await page.waitForTimeout(300);
  const c1 = calls('staff_master_request').slice(-1)[0].b.p;
  T('申請は変えた項目だけ（ふりがな）・対象の行・資料・作業者', JSON.stringify(c1.after) === '{"kana":"てすとしょくどう"}' && c1.record_id === 'c1' && c1.table === 'customers' && /DIR-20261011/.test(c1.source_doc) && c1.requested_by === '花子', JSON.stringify(c1));
  T('申請しても台帳を直接書き換えない', st.writesDirect.length === 0, st.writesDirect.join(' / '));

  // ── 捕獲者: 口座番号 ──
  await page.evaluate(() => clkReqOpen('hunters', 'h1')); await page.waitForTimeout(400);
  const html = await page.$eval('#clk-body', e => e.innerHTML + [...e.querySelectorAll('input,textarea,select')].map(i => i.value).join('|'));
  T('捕獲者: 口座番号を画面に出さない（下2桁だけ）', !/0012345|12345/.test(html) && /\*\*\*\*\*45/.test(html), '');
  await page.fill('#mrf-furigana', 'りょうし いちろう'); await page.fill('#mrf-_src', '口座の届出書');
  await page.click('#mr-send'); await page.waitForTimeout(300);
  const c2 = calls('staff_master_request').slice(-1)[0].b.p;
  T('捕獲者: 口座番号が空欄なら申請に入れない（消さない）', c2.table === 'hunters' && !('account_number' in c2.after) && c2.after.furigana === 'りょうし いちろう', JSON.stringify(c2.after));
  await page.evaluate(() => clkReqOpen('hunters', 'h1')); await page.waitForTimeout(400);
  await page.fill('#mrf-account_number', '12ab'); await page.fill('#mrf-_src', '通帳の写し');
  const n0 = calls('staff_master_request').length;
  await page.click('#mr-send'); await page.waitForTimeout(200);
  T('捕獲者: 口座番号に数字以外は止める', calls('staff_master_request').length === n0 && /数字だけ/.test(await page.$eval('#mr-msg', e => e.textContent)), '');
  await page.fill('#mrf-account_number', '0098799');
  await page.click('#mr-send'); await page.waitForTimeout(300);
  const c3 = calls('staff_master_request').slice(-1)[0].b.p;
  T('捕獲者: 口座番号は先頭の0のまま文字で送る', c3.after.account_number === '0098799' && typeof c3.after.account_number === 'string', JSON.stringify(c3.after));

  // ── 新規: 似た登録 ──
  await page.evaluate(() => { mrState.table = 'supplies'; mrState.cur = null; clerkShow('req'); }); await page.waitForTimeout(300);
  await page.evaluate(() => mrOpen(null)); await page.waitForTimeout(100);
  await page.fill('#mrf-name', 'ラップ'); await page.fill('#mrf-unit', '本'); await page.fill('#mrf-min_qty', '3'); await page.fill('#mrf-_src', '納品書');
  await page.click('#mr-send'); await page.waitForTimeout(300);
  const m1 = await page.$eval('#mr-msg', e => e.textContent);
  T('新規: 似た登録があれば候補を見せて止める', /似た登録/.test(m1) && /ラップ（業務用）/.test(m1), m1);
  await page.click('#mr-msg button'); await page.waitForTimeout(300);
  const c4 = calls('staff_master_request').slice(-1)[0].b.p;
  T('新規: 「別のもの」を押したときだけ confirm_dup で申請・数値は数字で', c4.confirm_dup === true && c4.record_id === null && c4.after.min_qty === 3 && c4.after.name === 'ラップ', JSON.stringify(c4));

  // ── 取り下げ ──
  st.dialog = [''];
  await page.click('#mr-list button'); await page.waitForTimeout(300);
  T('取り下げ', calls('staff_master_withdraw').length === 1 && calls('staff_master_withdraw')[0].b.p_id === 'r1', '');

  // ── 日報 ──
  await page.evaluate(() => clerkShow('report')); await page.waitForTimeout(200);
  const rep = await page.$eval('#clk-report', e => e.value);
  T('日報: 申請件数と中身（口座番号は入らない）', /【作業内容】.*マスタの変更申請（4件）/.test(rep) && /【更新件数】4件（変更を申請したもの/.test(rep) && /顧客「C0101 テスト食堂」ふりがな/.test(rep) && /口座番号/.test(rep) && !/0098799/.test(rep), rep);

  // ── 責任者 ──
  await page.evaluate(() => clerkShow('review')); await page.waitForTimeout(200);
  await page.fill('#mr-akey', 'wrong'); await page.click('#clk-body button:has-text("開く")'); await page.waitForTimeout(300);
  T('責任者: キーが違えば開かない', /責任者キーが違います/.test(await page.$eval('#mr-amsg', e => e.textContent)) && !(await page.$('#mr-rlist')), '');
  await page.fill('#mr-akey', AKEY); await page.click('#clk-body button:has-text("開く")'); await page.waitForTimeout(400);
  const rl = await page.$eval('#mr-rlist', e => e.textContent);
  T('責任者: 申請の一覧（口座番号は全桁で確認できる）と承認ボタン', /0012345/.test(rl) && /0098799/.test(rl) && (await page.$$('#mr-rlist button')).length === 4, rl.slice(0, 120));
  const stored = await page.evaluate(() => JSON.stringify(Object.assign({}, localStorage)) + JSON.stringify(Object.assign({}, sessionStorage)));
  T('責任者キーを端末に保存しない', !stored.includes(AKEY), '');
  await page.click('#mr-rlist button:has-text("承認")'); await page.waitForTimeout(400);
  const rv = calls('admin_master_review');
  T('責任者: 承認（申請ID・確認者名・キー）', rv.length === 1 && rv[0].b.p_decision === '承認' && rv[0].b.p_id === 'r1' && rv[0].b.p_by === '花子' && rv[0].b.p_approver_key === AKEY, JSON.stringify(rv));
  st.dialog = [''];
  await page.click('#mr-rlist button:has-text("差戻し")'); await page.waitForTimeout(300);
  T('責任者: 差戻しは理由が無ければ送らない', calls('admin_master_review').length === 1, '');
  st.dialog = ['資料の写真が無いので添付して再申請'];
  await page.click('#mr-rlist button:has-text("差戻し")'); await page.waitForTimeout(400);
  const rv2 = calls('admin_master_review').slice(-1)[0].b;
  T('責任者: 差戻し（理由つき）', rv2.p_decision === '差戻し' && /再申請/.test(rv2.p_note), JSON.stringify(rv2));

  // ── 責任者キーの設定 ──
  await page.click('#clk-body button:has-text("閉じる")'); await page.waitForTimeout(200);
  await page.click('summary:has-text("責任者キーを設定")');
  await page.fill('#mr-knew', 'new-approver-1'); await page.fill('#mr-knew2', 'new-approver-2');
  await page.click('#clk-body button:has-text("設定する")'); await page.waitForTimeout(200);
  T('責任者キーの設定: 2回の入力が違えば送らない', calls('admin_set_approver_key').length === 0 && /違います/.test(await page.$eval('#mr-kmsg', e => e.textContent)), '');
  await page.fill('#mr-knew2', 'new-approver-1');
  await page.click('#clk-body button:has-text("設定する")'); await page.waitForTimeout(300);
  const sk = calls('admin_set_approver_key')[0];
  T('責任者キーの設定: 初回は今のキーなし・スタッフキーと一緒に送る', sk && sk.b.p_current === null && sk.b.p_new === 'new-approver-1' && sk.b.p_staff_key === 'k' && /設定しました/.test(await page.$eval('#mr-kmsg', e => e.textContent)), JSON.stringify(sk));
  T('pageerrorなし', errors.length === 0, errors.join(' / '));
  await ctx.close();

  // ── iPhone幅 ──
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.addInitScript(() => { try { localStorage.setItem('tg_staff_key', 'k'); } catch (e) {} });
    const page = await ctx.newPage();
    await page.route('**/*', rt => /^file:/.test(rt.request().url()) ? rt.continue() : rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(/hunters/.test(rt.request().url()) ? [HUNT] : []) }));
    await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
    await page.waitForTimeout(800);
    await page.evaluate(() => { document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active')); const p = document.getElementById('panel-clerk'); p.classList.add('active'); p.style.display = 'block'; });
    await page.evaluate(() => clkReqOpen('hunters', 'h1')); await page.waitForTimeout(500);
    const ov = await page.evaluate(() => { const f = document.querySelector('#mr-form .section').getBoundingClientRect();
      return [...document.querySelectorAll('#mr-form input,#mr-form select,#mr-form textarea')].map(i => [i.id, Math.round(i.getBoundingClientRect().right - f.right)]).filter(x => x[1] > 0)
        .concat(document.documentElement.scrollWidth > 390 ? [['page', document.documentElement.scrollWidth]] : []); });
    T('iPhone幅: 申請フォームの入力欄が枠からはみ出さない・横スクロールなし', ov.length === 0, JSON.stringify(ov));
    await ctx.close();
  }

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
