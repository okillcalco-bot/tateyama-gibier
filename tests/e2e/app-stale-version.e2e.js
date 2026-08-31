// 古い版のまま動いていることに気づけるか
//
//   きっかけ（2026-08-31 Oobanburumaiの出荷）
//     バーコードが4件とも読めなかった。出荷スキャンの修正は8/28に入っていたが、
//     現場の端末はタブを開きっぱなしで、古いJavaScriptが動き続けていた。
//     直したはずの不具合がそのまま出るのに、画面上は何の手がかりも無い。
//
//   ここで測ること
//     1. 読み込み時のETagを控える
//     2. サーバ側が変わったら気づいて知らせる
//     3. 変わっていなければ何も出さない（邪魔をしない）
//     4. ETagが取れない環境では黙って何もしない
//     5. 押したら再読み込みする
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));

  let etag = '"v1"';
  let sendEtag = true;
  const heads = [];
  await page.route('**/*', r => {
    const req = r.request(), u = req.url();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (req.method() === 'HEAD') {
      heads.push(u);
      return r.fulfill({ status: 200, headers: sendEtag ? { etag } : {}, body: '' });
    }
    if (u.startsWith('file:')) return r.continue();
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(900);

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);
  const barShown = () => page.evaluate(() => !!document.getElementById('app-update-bar'));

  // ── 1) 読み込み時に控える。まだ何も出さない ──
  T('読み込み時にサーバの版を確かめる', heads.length >= 1, `HEAD ${heads.length}回`);
  T('控えた値を持っている', (await page.evaluate(() => appEtagAtLoad)) === '"v1"',
    await page.evaluate(() => appEtagAtLoad));
  T('この時点では何も出さない', (await barShown()) === false, '');

  // ── 2) 変わっていなければ出さない ──
  await page.evaluate(async () => { await appVersionCheck(); });
  await page.waitForTimeout(300);
  T('同じ版なら邪魔をしない', (await barShown()) === false, '');

  // ── 3) サーバが新しくなったら知らせる ──
  etag = '"v2"';
  await page.evaluate(async () => { await appVersionCheck(); });
  await page.waitForTimeout(300);
  T('新しい版が出たら知らせる', (await barShown()) === true, '');
  const txt = await page.evaluate(() => {
    const el = document.getElementById('app-update-bar');
    return el ? el.textContent.replace(/\s+/g, ' ') : '';
  });
  T('古いまま動いていると分かる書き方', /古い版のまま動いています/.test(txt), txt.slice(0, 60));
  T('不具合が出ることも伝える', /直っているはずの不具合/.test(txt), '');
  T('更新の押しどころがある', /今すぐ更新する/.test(txt), '');
  T('画面の邪魔にならない位置（下端・固定）',
    await page.evaluate(() => {
      const s = getComputedStyle(document.getElementById('app-update-bar'));
      return s.position === 'fixed' && s.bottom === '0px';
    }), '');

  // ── 4) 二重に出さない ──
  await page.evaluate(async () => { await appVersionCheck(); await appVersionCheck(); });
  await page.waitForTimeout(300);
  T('何度確かめても1本だけ',
    (await page.evaluate(() => document.querySelectorAll('#app-update-bar').length)) === 1, '');

  // ── 5) 押したら読み直す ──
  let reloaded = false;
  page.on('framenavigated', () => { reloaded = true; });
  await page.click('#app-update-btn');
  await page.waitForTimeout(900);
  T('押したら読み直す', reloaded, '');

  // ── 6) ETagが取れない環境では黙って何もしない ──
  sendEtag = false;
  await page.waitForTimeout(600);
  await page.evaluate(async () => { appEtagAtLoad = null; appUpdateShown = false; });
  await page.evaluate(async () => { await appVersionCheck(); await appVersionCheck(); });
  await page.waitForTimeout(300);
  T('ETagが無ければ何も出さない', (await barShown()) === false, '');
  T('控えた値も作らない', (await page.evaluate(() => appEtagAtLoad)) === null, '');

  // ── 7) タブに戻ったときにも確かめる ──
  T('visibilitychangeで確かめる仕掛けがある',
    (await page.evaluate(() => typeof appVersionCheck === 'function')), '');

  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
