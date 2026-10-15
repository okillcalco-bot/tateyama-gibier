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
//     4. punch.html は staff に一切書き込まない（休憩初期値は管理アプリのみ）
//     5. （2026-10-15 再適用で追加）capture-form は hunters を直接 PATCH せず、
//        「名前を出すか」の既定は rpc/public_hunter_set_name_public を使う
//     6. （同）buyback / public-analysis はスタッフキーの無い端末で hunters 本体を GET しない
//     7. （同）index.html の staff/hunters 本体の読み書きは、直前に staffKeyEnsure() を呼ぶ
//     8. （同）index.html はスタッフキーの無い端末で起動してもキー入力を求めない
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

  // 4. punch: staff への書き込みが一切ない（P0-1: 無認証writeの廃止）
  const fs = require('fs');
  const punchSrc = fs.readFileSync(path.resolve(__dirname, '../../punch.html'), 'utf8');
  t('punch: staffへの直接PATCHが無い', !/sb\('PATCH', 'staff'/.test(punchSrc), '');
  t('punch: staff_set_break_default RPCを使わない（無認証write廃止）', !punchSrc.includes('staff_set_break_default'), '');
  // capture-form: 仮登録はRPC経由
  const capSrc = fs.readFileSync(path.resolve(__dirname, '../../capture-form.html'), 'utf8');
  t('capture-form: 仮登録は rpc/public_hunter_provisional を使う', capSrc.includes("rpc/public_hunter_provisional"), '');
  t('capture-form: huntersへの直接POSTが無い', !/sb\('POST', 'hunters'/.test(capSrc), '');

  // 5. capture-form: 「名前を出すか」の既定は列固定RPC経由
  t('capture-form: huntersへの直接PATCHが無い', !/sb\('PATCH', 'hunters'/.test(capSrc), '');
  t('capture-form: name_public は rpc/public_hunter_set_name_public で覚える', capSrc.includes('rpc/public_hunter_set_name_public'), '');

  // 6. buyback / public-analysis: スタッフキーの無い端末では hunters 本体を読まない（読めない理由を画面に出す）
  const bbReqs = await loadPage('buyback.html', okInit);
  t('buyback: キー無しで base hunters を読まない', !bbReqs.some(u => isBaseGet(u, 'hunters')), bbReqs.filter(u => isBaseGet(u, 'hunters'))[0] || '');
  const paReqs = await loadPage('public-analysis.html', okInit);
  const paSrc = fs.readFileSync(path.resolve(__dirname, '../../public-analysis.html'), 'utf8');
  const paMain = (paSrc.match(/const \[ps, src, inds, dist\] = await Promise\.all\(\[[\s\S]*?\]\);/) || [''])[0];
  t('public-analysis: hunters は任意読み（失敗しても他の解析は出る）', /opt\('捕獲者台帳/.test(paSrc) && paMain !== '' && !paMain.includes("'hunters'"), '');
  t('public-analysis: 読み込みが走る', paReqs.some(u => u.includes('/public_stats')), '');

  // 7. index.html: staff/hunters 本体への sb() 呼び出しは、同じ処理の直前（10行以内）に staffKeyEnsure() がある
  const idxLines = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8').split('\n');
  const missing = [];
  idxLines.forEach((l, i) => {
    if (/sb\('(GET|POST|PATCH|DELETE)', '(staff|hunters)'/.test(l) && !idxLines.slice(Math.max(0, i - 10), i + 1).some(x => x.includes('staffKeyEnsure()'))) missing.push((i + 1) + ': ' + l.trim().slice(0, 80));
  });
  t('index: staff/hunters 本体の前に staffKeyEnsure', missing.length === 0, missing.join(' | '));

  // 8. index.html: スタッフキーの無い端末で起動しても、キー入力を求めない（求めるのは台帳・精算などを開いた時だけ）
  {
    const ctx = await browser.newContext();
    await ctx.addInitScript(okInit);
    const page = await ctx.newPage();
    const dialogs = [];
    page.on('dialog', d => { dialogs.push(d.message()); d.dismiss().catch(() => {}); });
    await page.route('**/*', r => {
      const u = r.request().url();
      if (u.startsWith('file:')) return r.continue();
      if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
      return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
    await page.waitForTimeout(1500);
    const asked = dialogs.filter(m => m.includes('スタッフキー'));
    t('index: 起動時にスタッフキーを聞かない', asked.length === 0, asked.length + '回');
    await ctx.close();
  }

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
