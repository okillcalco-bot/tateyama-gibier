// 全画面の見直し（2026-11-10）: 画面を機械で測って、はみ出し・JSエラー・押しにくい場所・読みにくい色を数える
//
//   きっかけ
//     「UIとか動作を全部見直して。データは壊さないように。」
//     目で1枚ずつ見るのではなく、全画面 × 画面の幅（スマホ390・タブレット820・PC1366）× 状態
//     （多めのデータ・0件・通信がすべて失敗）で開き、タブを順に押して測った。
//     データは架空（helpers/fake-supabase.js が列名からそれらしい値を作る）。本番のデータ・DBには触れない。
//
//   2026-11-10 に見つけて直したもの（このテストで次から数える）
//     ・JSエラー 4件（受注管理の請求書タブ・出店の読み込みが、通信失敗で未処理の例外）→ 0
//     ・画面の右へはみ出して切れる: 業務アプリの掲示板/出荷処理/書類タブ・精肉モード（スマホ）・売上の表（スマホ）→ 0
//     ・読みにくい色（白地に #9aa08c = 2.7:1）: 業務アプリ 518 か所 → 3（飾りの矢印だけ）
//     ・指で押しにくい場所（24px 未満）: 受注管理 278 → 15、会計 77 → 0、給与 49 → 1、精肉モードの 🖨/✕ 14px → 36px
//
//   ここで測ること（画面ごと）
//     1. 画面の右（左）にはみ出して切れている要素が無い・ページが横に動かない（全幅・全タブ）
//     2. JSエラー・未処理の例外が無い（多めのデータ・0件・通信がすべて失敗 のどれでも）
//     3. 指で押す端末で、24px 未満の押す場所が今より増えていない
//     4. 読みにくい色（コントラスト比 3 未満の字）が今より増えていない
//     5. 字が切れていない・10px 未満の字が無い
//
//   使い方
//     node tests/e2e/ui-audit.e2e.js                … 全画面
//     node tests/e2e/ui-audit.e2e.js index.html     … その画面だけ
//     REPORT=1 node tests/e2e/ui-audit.e2e.js       … 合否のほかに、画面ごとの実測値を出す（上限を見直すとき）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs'); const path = require('path');
const { respond, STUBS, measure } = require('./helpers/fake-supabase.js');
const ROOT = path.resolve(__dirname, '../..');

// 測らない画面: 404 / 外部サービスの戻り先 / 個人のページ /
//   record-list.html（文字化けしたまま残っている古い画面。どこからもリンクされていない。消すかどうかは本人に確認中）
// order-portal.html（お客様用の注文ポータル）は、ログイン前の画面だけを測る（ログイン後は別のテスト）
const SKIP = new Set(['404.html', 'base-callback.html', 'yoshiki2.html', 'manabu.html', 'record-list.html']);
const only = process.argv.slice(2).filter(a => a.endsWith('.html'));
const PAGES = (only.length ? only : fs.readdirSync(ROOT).filter(f => f.endsWith('.html') && !SKIP.has(f))).sort();
const VIEWPORTS = { phone: { w: 390, h: 844, touch: true }, tablet: { w: 820, h: 1180, touch: true }, pc: { w: 1366, h: 768, touch: false } };
// 何を開くか: 多めのデータは3つの幅、0件と通信失敗はスマホ幅
const RUNS = [['stress', 'phone'], ['stress', 'tablet'], ['stress', 'pc'], ['empty', 'phone'], ['error', 'phone']];

// 今の実測値（2026-11-10）。これより増えたら落とす。減らしたら、ここも下げる。
//   small = 指で押す端末（スマホ・タブレット）で 24px 未満の押す場所の数（タブごとの最大）
//   lowc  = コントラスト比 3 未満の字の数（タブごとの最大）
// 残っているものの中身:
//   index.html     small: 一覧の行のチェック（18px。行の間隔は空いている）/ lowc: ダッシュボードの飾りの矢印「→」
//   order-admin    small: 書類の一覧の行のチェック（18px）と文中のリンク
//   manual-app     lowc: カードの飾りの「›」
const LIMITS = {
  'index.html': { small: 14, lowc: 3 },
  'order-admin.html': { small: 14, lowc: 0 },
  'manual-app.html': { small: 0, lowc: 4 },
  'dishes.html': { small: 1, lowc: 0 },            // 文中のリンク「こちら」
  'payroll.html': { small: 1, lowc: 0 },           // 文中のリンク「punch.html」
  'public-analysis.html': { small: 3, lowc: 0 },   // 文中のリンク（ほかの分析ページへ）
};
const limitOf = pg => Object.assign({ small: 0, lowc: 0 }, LIMITS[pg] || {});

async function auditOne(browser, pg, mode, vpName) {
  const vp = VIEWPORTS[vpName];
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1, hasTouch: vp.touch, timezoneId: 'Asia/Tokyo', locale: 'ja-JP' });
  await ctx.addInitScript(() => {
    try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); sessionStorage.setItem('tg_ptoken', 'T'); localStorage.setItem('tg_staff_key', 'TESTKEY'); localStorage.setItem('tg_finance_key', 'VIEW'); } catch (e) {}
    window.__dlg = []; window.alert = m => window.__dlg.push('alert:' + String(m).slice(0, 120)); window.confirm = m => { window.__dlg.push('confirm:' + String(m).slice(0, 120)); return false; }; window.prompt = () => null;
    window.print = () => {}; window.open = () => null;
    window.__rej = []; window.addEventListener('unhandledrejection', e => { window.__rej.push(String(e.reason && e.reason.message || e.reason).slice(0, 160)); });
  });
  const page = await ctx.newPage();
  const errs = []; page.on('pageerror', e => errs.push(String(e.message).slice(0, 200)));
  await page.route('**/*', route => {
    const req = route.request(); const u = req.url();
    if (u.startsWith('file:')) return route.continue();
    if (/supabase\.co|\/rest\/v1\/|\/auth\/v1\/|\/storage\/v1\/|\/functions\/v1\//.test(u)) return route.fulfill(respond(u, req.method(), mode));
    for (const [re, js] of STUBS) if (re.test(u) && /\.js(\?|$)|supabase-js|chart\.js$/i.test(u)) return route.fulfill({ status: 200, contentType: 'application/javascript', body: js });
    if (/fonts\.(googleapis|gstatic)/.test(u)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    if (/\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(u)) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"/>' });
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
  });
  const out = [];
  const grab = async state => {
    const m = await page.evaluate(measure).catch(e => ({ measureError: String(e.message).slice(0, 120) }));
    const rej = await page.evaluate(() => { const r = (window.__rej || []).slice(); if (window.__rej) window.__rej.length = 0; window.__dlg.length = 0; return r; }).catch(() => []);
    out.push({ page: pg, mode, vp: vpName, state, hscroll: m.hscroll || 0, offN: m.offN || 0, off: m.off || [], smallTapN: m.smallTapN || 0, smallTap: m.smallTap || [], lowcN: m.lowcN || 0, lowc: m.lowc || [],
      clipN: m.clipN || 0, clip: m.clip || [], tinyN: m.tinyN || 0, tiny: m.tiny || [], errs: errs.splice(0).concat(rej), measureError: m.measureError });
  };
  try {
    await page.goto('file://' + path.join(ROOT, pg), { waitUntil: 'load', timeout: 20000 });
    await page.waitForTimeout(900);
    await grab('load');
    // タブを順に開く（data-tab のボタン、switchTab('x') / showTab('x') の onclick）
    const tabs = await page.evaluate(() => { const o = []; document.querySelectorAll('[data-tab]').forEach(b => { if (b.tagName !== 'A') o.push({ k: 'data', v: b.dataset.tab }); }); document.querySelectorAll('[onclick]').forEach(b => { const m = (b.getAttribute('onclick') || '').match(/^\s*(switchTab|showTab|showPanel|setTab|openTab)\('([^']+)'\)/); if (m) o.push({ k: m[1], v: m[2] }); }); const seen = new Set(); return o.filter(t => { const key = t.k + ':' + t.v; if (seen.has(key)) return false; seen.add(key); return true; }); });
    for (const t of tabs.slice(0, 40)) {
      await page.evaluate(t => { try { if (t.k === 'data') { const b = document.querySelector('[data-tab="' + t.v + '"]'); if (b) b.click(); } else window[t.k](t.v); } catch (e) { window.__rej.push('tab ' + t.v + ': ' + e.message); } }, t);
      await page.waitForTimeout(400);
      await grab('tab:' + t.v);
    }
    // 重ねて出る画面（精肉モード）も測る
    if (await page.evaluate(() => typeof window.openProcessingMode === 'function').catch(() => false)) {
      await page.evaluate(() => { try { openProcessingMode(); } catch (e) {} }); await page.waitForTimeout(450); await grab('精肉モード（個体を選ぶ）');
      await page.evaluate(() => { try { const pc = document.querySelector('.pm-setup-ind-card'); pmCurrentOperator = 'テスト'; if (pc) pc.click(); } catch (e) {} }); await page.waitForTimeout(550); await grab('精肉モード（計量）');
    }
  } catch (e) { out.push({ page: pg, mode, vp: vpName, state: 'load', fatal: String(e.message).slice(0, 200), errs: errs.splice(0), hscroll: 0, offN: 0, off: [], smallTapN: 0, smallTap: [], lowcN: 0, lowc: [], clipN: 0, clip: [], tinyN: 0, tiny: [] }); }
  await ctx.close();
  return out;
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const jobs = []; for (const pg of PAGES) for (const [mode, vp] of RUNS) jobs.push([pg, mode, vp]);
  const rows = []; let next = 0;
  const worker = async () => { while (next < jobs.length) { const [pg, mode, vp] = jobs[next++]; rows.push(...await auditOne(browser, pg, mode, vp)); } };
  await Promise.all(Array.from({ length: +(process.env.JOBS || 4) }, worker));
  await browser.close();

  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);
  const where = r => `${r.mode === 'stress' ? '' : (r.mode === 'empty' ? '0件・' : '通信失敗・')}${r.vp}・${r.state}`;
  for (const pg of PAGES) {
    const rs = rows.filter(r => r.page === pg); const lim = limitOf(pg);
    const fatal = rs.filter(r => r.fatal || r.measureError);
    T(`${pg}: 開ける（${rs.length}の状態を測った）`, rs.length >= RUNS.length && fatal.length === 0, fatal.map(r => where(r) + ' ' + (r.fatal || r.measureError)).join(' / '));
    const off = rs.filter(r => r.offN > 0 || r.hscroll > 0);
    T(`${pg}: 1. はみ出して切れている要素なし・横に動かない`, off.length === 0, off.slice(0, 3).map(r => `${where(r)}: ${r.offN}か所/横${r.hscroll}px ${r.off.slice(0, 2).join(' ; ')}`).join(' ｜ '));
    const er = rs.filter(r => r.errs.length);
    T(`${pg}: 2. JSエラー・未処理の例外なし`, er.length === 0, er.slice(0, 3).map(r => `${where(r)}: ${r.errs.slice(0, 2).join(' / ')}`).join(' ｜ '));
    const touch = rs.filter(r => r.mode === 'stress' && VIEWPORTS[r.vp].touch);
    const sMax = touch.reduce((a, r) => (r.smallTapN > a.smallTapN ? r : a), { smallTapN: 0, smallTap: [] });
    T(`${pg}: 3. 指で押しにくい場所（24px未満）が ${lim.small} か所以下`, sMax.smallTapN <= lim.small, sMax.smallTapN ? `${where(sMax)}: ${sMax.smallTapN}か所 ${sMax.smallTap.slice(0, 4).join(' ; ')}` : '0');
    const st = rs.filter(r => r.mode === 'stress');
    const cMax = st.reduce((a, r) => (r.lowcN > a.lowcN ? r : a), { lowcN: 0, lowc: [] });
    T(`${pg}: 4. 読みにくい色の字が ${lim.lowc} か所以下`, cMax.lowcN <= lim.lowc, cMax.lowcN ? `${where(cMax)}: ${cMax.lowcN}か所 ${cMax.lowc.slice(0, 4).join(' ; ')}` : '0');
    const cut = st.filter(r => r.clipN > 0 || r.tinyN > 0);
    T(`${pg}: 5. 字が切れていない・10px未満の字なし`, cut.length === 0, cut.slice(0, 2).map(r => `${where(r)}: 切れ${r.clipN} 小${r.tinyN} ${r.clip.concat(r.tiny).slice(0, 3).join(' ; ')}`).join(' ｜ '));
    if (process.env.REPORT) console.log(`  [実測] ${pg}: 状態${rs.length} small=${sMax.smallTapN} lowc=${cMax.lowcN}`);
  }
  let pass = 0;
  for (const [n, ok, got] of results) { if (!ok || process.env.VERBOSE) console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 420) + ']' : '')); if (ok) pass++; }
  console.log(`\n${PAGES.length}画面 × ${RUNS.length}通り（計${rows.length}の状態）を測った`);
  console.log(`${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
