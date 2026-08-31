// P0-2 クライアント側ガード: 認証なし画面が staff/hunters 本体テーブルの
// 機微列を anon で読まないこと（公開VIEW/RPC経由に張り替わっていること）を測る。
//
//   背景（P0-A是正）
//     staff/hunters 本体は staff-key 必須RLSにし、氏名等の最小列は
//     公開VIEW(staff_public/hunters_public)で出す。認証を持たない
//     punch/outlet/capture-form は VIEW/RPC を使うよう改修した。
//     ここでは「本体テーブルへの直GETに戻っていないこと」を回帰として固定する。
//
//   測ること
//     1. punch.html は staff_public を読み、base staff を GET しない
//     2. outlet.html は staff_public を読み、base staff を GET しない
//     3. capture-form.html は hunters_public / staff_public を読み、
//        base hunters / base staff を GET しない
//     4. punch.html の休憩初期値の保存は rpc/staff_set_break_default を使う
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

function isBaseGet(u, table) {
  // /rest/v1/staff?...   （_public でない・rpc でない）を base 読みとみなす
  return new RegExp('/rest/v1/' + table + '\\?').test(u) && !u.includes(table + '_public');
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = [];
  const t = (n, ok, got) => results.push([n, ok, got]);

  async function loadPage(file, initScript) {
    const ctx = await browser.newContext();
    if (initScript) await ctx.addInitScript(initScript);
    const page = await ctx.newPage();
    const reqs = [];
    await page.route('**/*', r => {
      const u = r.request().url();
      reqs.push(u);
      if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};window.QRCode=function(){};' });
      if (u.startsWith('file:')) return r.continue();
      // すべての REST は空配列で返す（呼び出し先の確認が目的）
      return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('file://' + path.resolve(__dirname, '../../' + file));
    await page.waitForTimeout(700);
    await ctx.close();
    return reqs;
  }

  const okInit = () => { try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); } catch (e) {} };

  // 1. punch
  const punchReqs = await loadPage('punch.html', okInit);
  t('punch: staff_public を読む', punchReqs.some(u => u.includes('/staff_public')), '');
  t('punch: base staff を読まない', !punchReqs.some(u => isBaseGet(u, 'staff')), punchReqs.filter(u => isBaseGet(u, 'staff'))[0] || '');

  // 2. outlet（スタッフ選択は操作時の遅延ロードなので、ソース上で確認）
  const fsO = require('fs');
  const outletSrc = fsO.readFileSync(path.resolve(__dirname, '../../outlet.html'), 'utf8');
  t('outlet: staff_public を使う（ソース）', outletSrc.includes("'staff_public'"), '');
  t('outlet: base staff の直GETが無い（ソース）', !/sb\('GET', 'staff',/.test(outletSrc), '');

  // 3. capture-form
  const capReqs = await loadPage('capture-form.html', okInit);
  t('capture-form: hunters_public を読む', capReqs.some(u => u.includes('/hunters_public')), '');
  t('capture-form: staff_public を読む', capReqs.some(u => u.includes('/staff_public')), '');
  t('capture-form: base hunters を読まない', !capReqs.some(u => isBaseGet(u, 'hunters')), capReqs.filter(u => isBaseGet(u, 'hunters'))[0] || '');
  t('capture-form: base staff を読まない', !capReqs.some(u => isBaseGet(u, 'staff')), capReqs.filter(u => isBaseGet(u, 'staff'))[0] || '');

  // 4. punch: 休憩初期値の保存はRPC経由（source上の確認）
  const fs = require('fs');
  const punchSrc = fs.readFileSync(path.resolve(__dirname, '../../punch.html'), 'utf8');
  t('punch: 休憩初期値保存は rpc/staff_set_break_default を使う', punchSrc.includes("rpc/staff_set_break_default"), '');
  t('punch: staffへの直接PATCHが無い', !/sb\('PATCH', 'staff'/.test(punchSrc), '');
  // capture-form: 仮登録はRPC経由
  const capSrc = fs.readFileSync(path.resolve(__dirname, '../../capture-form.html'), 'utf8');
  t('capture-form: 仮登録は rpc/public_hunter_provisional を使う', capSrc.includes("rpc/public_hunter_provisional"), '');
  t('capture-form: huntersへの直接POSTが無い', !/sb\('POST', 'hunters'/.test(capSrc), '');

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
