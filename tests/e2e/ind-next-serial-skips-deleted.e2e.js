// 個体登録: 「次に使う通し番号」の案内と個体QRラベルのプリセットは、削除済みを数えない
//
//   きっかけ（2026-09-12）
//     9/9 に M191 を通し番号532で登録して同日削除、9/11 の T326 が同じ532で登録された。
//     保存時の重複チェックは削除済みを無視するので532の再利用は通るのに、
//     「次に使う番号」の案内と個体QRラベルのプリセットは削除済みも数えていたため
//     「次は537」と1つ多い番号を案内していた（食い違いに気づいた本人が「536が被ってない？」と確認）。
//     運用は「削除した番号は詰めて使う」で確定。案内側を保存時のチェックと同じ基準（生きている行だけ）に揃える。
//
//   ここで測ること
//     1. 案内の問い合わせが species=イノシシ かつ deleted_at=is.null で最大値を取る
//     2. 削除済みに540があっても、生きている最大536の次＝537を案内する
//     3. 個体QRラベル（KML-506）の開始番号プリセットも同じ基準で537になる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));

  const serialQueries = [];
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    const qs = decodeURIComponent(u.split('?')[1] || '');
    if (/\/rest\/v1\/individuals/.test(u) && /serial_number=not\.is\.null/.test(qs) && /order=serial_number\.desc/.test(qs)) {
      serialQueries.push(qs);
      // 生きている最大は536。削除済みに540が残っている（登録ミスで消した番号）
      const alive = /deleted_at=is\.null/.test(qs);
      return J([{ serial_number: alive ? 536 : 540 }]);
    }
    if (/\/rest\/v1\/individuals/.test(u) && /label_id=like\.TGC-08-T/.test(qs)) return J([{ label_id: 'TGC-08-T330' }]);
    if (/\/rest\/v1\/individuals/.test(u) && /label_id=like\.TGC-08-M/.test(qs)) return J([{ label_id: 'TGC-08-M191' }]);
    return J([]);
  });

  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(600);

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  // 1) 新規登録の「次に使う番号」
  serialQueries.length = 0;
  await page.evaluate(() => indShowNextNumbers());
  await page.waitForTimeout(300);
  const hint = await page.$eval('#ind-next-hint', el => el.innerHTML);
  T('案内は生きている行だけで最大値を取る（deleted_at=is.null）', serialQueries.length > 0 && serialQueries.every(q => /deleted_at=is\.null/.test(q)), serialQueries.join(' | ').slice(0, 160));
  T('案内はイノシシだけで数える', serialQueries.every(q => /species=eq\.イノシシ/.test(q)), '');
  T('削除済みの540は数えず、次は537と案内する', /通し番号 <strong>537<\/strong>/.test(hint), hint.replace(/<[^>]+>/g, '').slice(0, 80));

  // 2) 個体QRラベルの開始番号プリセット
  serialQueries.length = 0;
  await page.evaluate(() => { document.getElementById('qrSpecies').value = 'イノシシ'; return qrLabelPrefill(); });
  await page.waitForTimeout(300);
  const from = await page.$eval('#qrFrom', el => el.value);
  T('QRラベルのプリセットも生きている行だけで最大値を取る', serialQueries.length > 0 && serialQueries.every(q => /deleted_at=is\.null/.test(q) && /species=eq\.イノシシ/.test(q)), serialQueries.join(' | ').slice(0, 160));
  T('QRラベルの開始番号は537', from === '537', from);

  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
