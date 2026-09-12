// 全タブをスマホ幅（390px）・タブレット幅（820px）で実寸描画し、横はみ出しと押しにくい部品を数える
//
//   きっかけ（2026-09-12）
//     「軸をぶらさず全体のUIを見直して、使いづらい所を直して」。勘で直さず全タブを測ったところ、
//     スマホ幅（左ナビ112pxが残るので本文は約230px）で 24タブ中 9タブが横にはみ出し、
//     ボタン（.btn）が高さ27px・チェックボックスが13pxで指では押しにくかった。
//     直したこと: 長い文言のボタンは折り返す／指で押す端末ではボタン38px以上・チェック18px／
//     幅指定のグリッド列を画面幅までに丸める／ダッシュボードの2列を1列に／表をスクロール枠に入れる。
//
//   ここで測ること
//     1. どのタブも documentElement.scrollWidth が画面幅を超えない（390px・820px）
//     2. 指で押す端末（pointer:coarse）では .btn が 34px以上、チェックボックスが 18px以上
//     3. ページエラーなし
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  for (const W of [390, 820]) {
    const ctx = await browser.newContext({ viewport: { width: W, height: 844 }, hasTouch: true });
    await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); } catch (e) {} });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', r => {
      const u = r.request().url();
      if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
      if (u.startsWith('file:')) return r.continue();
      return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
    await page.waitForTimeout(500);
    const coarse = await page.evaluate(() => matchMedia('(pointer:coarse)').matches);
    T(`${W}px: hasTouch で pointer:coarse が効く（前提）`, coarse, String(coarse));

    const tabs = await page.$$eval('.tab-btn[data-tab]', bs => bs.filter(b => b.style.display !== 'none').map(b => b.dataset.tab));
    const bad = []; const smallBtns = []; const smallChecks = [];
    for (const t of tabs) {
      await page.evaluate(t => document.querySelector(`.tab-btn[data-tab="${t}"]`).click(), t);
      await page.waitForTimeout(300);
      const r = await page.evaluate(t => {
        const W = document.documentElement.clientWidth;
        const panel = document.getElementById('panel-' + t);
        const vis = el => { const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
        const btns = panel ? [...panel.querySelectorAll('button.btn, a.btn')].filter(vis).map(b => Math.round(b.getBoundingClientRect().height)) : [];
        const checks = panel ? [...panel.querySelectorAll('input[type=checkbox]')].filter(vis).map(b => Math.round(b.getBoundingClientRect().height)) : [];
        return { over: document.documentElement.scrollWidth - W, minBtn: btns.length ? Math.min(...btns) : null, minCheck: checks.length ? Math.min(...checks) : null };
      }, t);
      if (r.over > 1) bad.push(`${t}:+${r.over}px`);
      if (r.minBtn != null && r.minBtn < 34) smallBtns.push(`${t}:${r.minBtn}px`);
      if (r.minCheck != null && r.minCheck < 18) smallChecks.push(`${t}:${r.minCheck}px`);
    }
    T(`${W}px: 全${tabs.length}タブで横にはみ出さない`, bad.length === 0, bad.join(', ') || 'ok');
    T(`${W}px: 指で押す端末ではボタン(.btn)が34px以上`, smallBtns.length === 0, smallBtns.join(', ') || 'ok');
    T(`${W}px: チェックボックスが18px以上`, smallChecks.length === 0, smallChecks.join(', ') || 'ok');
    T(`${W}px: ページエラーなし`, errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
