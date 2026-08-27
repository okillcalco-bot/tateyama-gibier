// 持込日が「画面を開いた日」のまま古くならないこと
//   事故: 2026-08-26に捕獲票を開いたまま放置し、翌8/27の1件目(TGC-08-T297)を登録したら
//   持込日が8/26で保存された。8/26は登録が1件も無く、resetFormも走っていなかったため、
//   画面を開いたときの日付が丸一日残っていた。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const YESTERDAY = '2026-08-26T23:50:00+09:00';   // 前日の夜に画面を開く
const TODAY_JST = '2026-08-27';

async function boot(fakeNowISO) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  // 端末の時計を固定する（あとから進められるようにフックも置く）
  await ctx.addInitScript(fixed => {
    const RealDate = Date;
    window.__now = new RealDate(fixed).getTime();
    window.__advance = ms => { window.__now += ms; };
    function FakeDate(...a) {
      if (a.length === 0) return new RealDate(window.__now);
      return new RealDate(...a);
    }
    FakeDate.prototype = RealDate.prototype;
    FakeDate.now = () => window.__now;
    FakeDate.parse = RealDate.parse; FakeDate.UTC = RealDate.UTC;
    window.Date = FakeDate;
  }, fakeNowISO);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.goto('file://' + path.resolve(__dirname, '../../capture-form.html'));
  await page.waitForTimeout(700);
  return { browser, page, errors };
}

(async () => {
  const results = [];

  // ── 1) 前日に開いた画面を、日付をまたいでから使う ──
  {
    const { browser, page, errors } = await boot(YESTERDAY);
    results.push(['開いた時点では前日の日付が入る',
      await page.$eval('#captureDate', el => el.value) === '2026-08-26',
      await page.$eval('#captureDate', el => el.value)]);
    results.push(['自動入力の印がつく',
      await page.$eval('#captureDate', el => el.dataset.autofill) === '1', '']);

    // 日付をまたぐ（20分進める）→ 画面が復帰したことにする
    await page.evaluate(() => window.__advance(20 * 60 * 1000));
    await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(200);
    results.push(['復帰すると今日の日付に入れ替わる',
      await page.$eval('#captureDate', el => el.value) === TODAY_JST,
      await page.$eval('#captureDate', el => el.value)]);
    results.push(['入れ替えたことを画面に出す',
      /持込日を 2026-08-27 に更新しました/.test(await page.$eval('#captureDateStale', el => el.textContent)),
      await page.$eval('#captureDateStale', el => el.textContent)]);
    results.push(['pageerrorなし(1)', errors.length === 0, errors.join(' / ')]);
    await browser.close();
  }

  // ── 2) 人が手で入れた日付は、勝手に書き換えない ──
  {
    const { browser, page, errors } = await boot(YESTERDAY);
    await page.evaluate(() => {
      const d = document.getElementById('captureDate');
      d.value = '2026-08-20';                       // 前日搬入をあとから登録する場合
      d.dispatchEvent(new Event('input'));
    });
    results.push(['手入力すると自動の印が外れる',
      await page.$eval('#captureDate', el => el.dataset.autofill) !== '1', '']);
    await page.evaluate(() => window.__advance(20 * 60 * 1000));
    await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForTimeout(200);
    results.push(['手入力した日付は書き換えない',
      await page.$eval('#captureDate', el => el.value) === '2026-08-20',
      await page.$eval('#captureDate', el => el.value)]);
    results.push(['pageerrorなし(2)', errors.length === 0, errors.join(' / ')]);
    await browser.close();
  }

  // ── 3) 保存の直前にも、今日でなければ確認する（自動更新をすり抜けた場合の最後の砦） ──
  {
    const { browser, page, errors } = await boot('2026-08-27T10:31:00+09:00');
    const asked = [];
    page.on('dialog', async d => { asked.push(d.message()); await d.dismiss(); });   // キャンセルする
    await page.evaluate(() => {
      state.species = 'イノシシ'; state.capture_city = '館山市'; state.sex = 'オス';
      state.capture_method = 'くくり罠'; state.finishing_method = '銃';
      const d = document.getElementById('captureDate');
      d.value = '2026-08-26'; d.dataset.autofill = '';       // 前日の日付が残っている状態
      document.getElementById('captureTime').value = '09:30';
      document.getElementById('captureArea').value = '山本';
      document.getElementById('hunterName').value = '渡邉利男';
      document.getElementById('weight').value = '35.1';
      const rec = document.getElementById('recorder'); if (rec && rec.options.length) rec.selectedIndex = rec.options.length - 1;
    });
    await page.evaluate(async () => { await handleSubmit(); });
    await page.waitForTimeout(600);
    results.push(['今日でない日付は確認を出す',
      asked.some(a => /持込日が今日（2026-08-27）ではなく 2026-08-26/.test(a)), asked.join(' / ').slice(0, 80)]);
    results.push(['何日前かを出す', asked.some(a => /1日前/.test(a)), '']);
    results.push(['既存の確認ダイアログに混ぜる（増やさない）',
      asked.filter(a => /持込日が今日/.test(a)).length === 1
      && asked.some(a => /確認してください/.test(a) && /持込日が今日/.test(a)), String(asked.length)]);
    results.push(['キャンセルすれば保存しない',
      await page.$eval('#submitBtn', el => !el.disabled && el.textContent.includes('搬入登録')), '']);

    // 今日の日付なら確認は出ない（毎回聞かれて慣れてしまうのを防ぐ）
    asked.length = 0;
    await page.evaluate(() => { document.getElementById('captureDate').value = '2026-08-27'; });
    await page.evaluate(async () => { await handleSubmit(); });
    await page.waitForTimeout(600);
    results.push(['今日の日付なら確認しない',
      !asked.some(a => /持込日が今日/.test(a)), asked.join(' / ').slice(0, 60)]);
    results.push(['pageerrorなし(3)', errors.length === 0, errors.join(' / ')]);
    await browser.close();
  }

  // ── 4) 保存のたびに日付が入れ直される（従来の動き） ──
  {
    const { browser, page, errors } = await boot('2026-08-27T10:31:00+09:00');
    await page.evaluate(() => {
      const d = document.getElementById('captureDate');
      d.value = '2026-08-20'; d.dataset.autofill = '';
      resetForm();
    });
    await page.waitForTimeout(200);
    results.push(['resetFormで今日に戻る',
      await page.$eval('#captureDate', el => el.value) === TODAY_JST,
      await page.$eval('#captureDate', el => el.value)]);
    results.push(['resetFormで自動の印も戻る',
      await page.$eval('#captureDate', el => el.dataset.autofill) === '1', '']);
    results.push(['pageerrorなし(4)', errors.length === 0, errors.join(' / ')]);
    await browser.close();
  }

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' && got != null ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
