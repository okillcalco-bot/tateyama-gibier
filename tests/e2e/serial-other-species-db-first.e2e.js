// キョン・シカ等の通し番号は端末カウンタではなくDBの最大+1を出す
//
//   きっかけ（2026-09-16）
//     タブレットでキョンを登録しようとすると「TGC-08-キ058 は既に登録されています（捕獲日 2026-09-11）」
//     で止まった。キ058（9/11）もキ059（9/12）も別の端末で登録済みだったが、このタブレットの
//     端末カウンタ（localStorage）が 58 のまま止まっていて、そのまま画面に出していた。
//     イノシシは 2026-08 にDB基準へ直していたが、他の獣種は端末カウンタ優先のままだった。
//
//   ここで測ること
//     1. 端末カウンタが古くても（58）、DBの最大（キ059）から 60 を出す
//     2. 端末カウンタがDBに合わせて自己修復される
//     3. 未送信キューに同じ獣種のAUTO登録があれば、そのぶん進めて表示する
//     4. オフライン（DB読取失敗）のときは端末カウンタで重複を避ける（回帰）
//     5. 管理番号も通し番号に追従する（TGC-08-キ060）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { localStorage.setItem('tgc_next_serial_キ', '58'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { await d.dismiss(); });

  let dbDown = false;
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (!/\/rest\/v1\//.test(u)) return r.fulfill({ status: 200, body: '[]' });
    if (/\/individuals/.test(u) && /label_id=like\.TGC-08-(%E3%82%AD|キ)/.test(u)) {
      if (dbDown) return r.abort();
      return J([{ serial_number: 59, label_id: 'TGC-08-キ059' }]);
    }
    if (/\/staff/.test(u)) return J([{ name: 'テスト' }]);
    return J([]);
  });

  await page.goto('file://' + path.resolve(__dirname, '../../capture-form.html'));
  await page.waitForTimeout(800);

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  // 1) 端末カウンタ58・DB最大キ059 → 60
  await page.evaluate(async () => { state.species = 'キョン'; state.capture_city = '館山市'; await refreshIndividualNumber(); });
  await page.waitForTimeout(200);
  const serial1 = await page.$eval('#indSerial', el => el.value);
  const label1 = await page.$eval('#indLabelId', el => el.value);
  T('端末カウンタが58でも、DBの最大キ059から60を出す', serial1 === '60', serial1);
  T('管理番号も TGC-08-キ060', label1 === 'TGC-08-キ060', label1);
  const lsAfter = await page.evaluate(() => localStorage.getItem('tgc_next_serial_キ'));
  T('端末カウンタがDBに合わせて自己修復される（60）', lsAfter === '60', lsAfter);

  // 3) 未送信キューに AUTO-キ が1件 → 61 を表示（実際の番号はDBトリガが確定）
  await page.evaluate(async () => {
    localStorage.setItem('tgc_queue', JSON.stringify([{ label_id: 'AUTO-キ', species: 'キョン' }]));
    await refreshIndividualNumber();
  });
  await page.waitForTimeout(200);
  const serial2 = await page.$eval('#indSerial', el => el.value);
  T('未送信キューに同じ獣種が1件あれば61を出す', serial2 === '61', serial2);
  await page.evaluate(() => localStorage.removeItem('tgc_queue'));

  // 4) オフライン（DB読取失敗）→ 端末カウンタ（自己修復後の60）と比較して重複を避ける
  dbDown = true;
  await page.evaluate(async () => { localStorage.setItem('tgc_next_serial_キ', '63'); await refreshIndividualNumber(); });
  await page.waitForTimeout(200);
  const serial3 = await page.$eval('#indSerial', el => el.value);
  T('オフラインなら端末カウンタ（63）で重複を避ける', serial3 === '63', serial3);
  dbDown = false;

  // 5) 別の獣種（シカ）は影響を受けない（同じ仕組みでDB基準）
  await page.evaluate(async () => { state.species = 'シカ'; await refreshIndividualNumber(); });
  await page.waitForTimeout(200);
  const serialShika = await page.$eval('#indSerial', el => el.value);
  T('シカはDBに無ければ1から', serialShika === '1', serialShika);

  T('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
