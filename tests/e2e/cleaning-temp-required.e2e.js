// 清掃記録（HACCP）: 冷蔵・冷凍庫は庫内温度の入力を必須にする
//
//   きっかけ（2026-09-10）
//     南総食肉衛生検査所の立入検査に備えて、書類・帳票ハブの「冷蔵庫・冷凍庫温度記録表」
//     （HACCPの核となる帳票）を確認したところ、直近30日分の冷蔵・冷凍庫の清掃記録
//     69件のうち、庫内温度が入力されていたのは0件だった。温度欄が任意入力だったため、
//     チェック項目にはチェックが入っていても誰も温度を書かないまま記録だけが
//     積み上がっていた＝帳票を出しても真っ白になる状態。
//     この庫だけ温度を必須にして、未入力のまま記録できないようにした。
//
//   ここで測ること
//     1. 冷蔵・冷凍庫は温度が空欄だと保存できない（エラーで止まる）
//     2. 冷蔵・冷凍庫は温度を入れれば保存でき、payloadのtemperatureに入る
//     3. 温度欄が無い他の部屋（精肉室など）は従来どおり温度チェックなしで保存できる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const toasts = [];

  const posted = [];
  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = req.url(); const m = req.method();
    const J = x => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m === 'POST' && /\/cleaning_logs/.test(url)) { posted.push(JSON.parse(req.postData() || '{}')); return J({}, 201); }
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));

  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(600);
  await page.exposeFunction('__toast', () => {});
  await page.evaluate(() => { window.toast = (msg) => { window.__lastToast = msg; }; });

  const results = [];
  const ck = (name, cond, got) => results.push([name, cond, got]);

  // ① 冷蔵・冷凍庫: 温度が空欄だと保存できない
  await page.evaluate(() => { cleaningOpen('冷蔵・冷凍庫'); document.getElementById('clean-staff').value = PM_OPERATORS[0] || 'テスト'; });
  await page.waitForTimeout(100);
  ck('温度欄が表示される（この庫は必須項目）', await page.$eval('#clean-temp-row', el => el.style.display) === 'block', '');
  posted.length = 0;
  await page.evaluate(() => cleaningSave());
  await page.waitForTimeout(200);
  const msg1 = await page.evaluate(() => window.__lastToast || '');
  ck('温度未入力では保存されない', posted.length === 0, JSON.stringify(posted));
  ck('温度必須のエラーメッセージが出る', /温度を入力/.test(msg1), msg1);

  // ② 温度を入れれば保存できる
  await page.evaluate(() => { document.getElementById('clean-temp').value = '冷蔵3℃ / 冷凍-18℃'; });
  await page.evaluate(() => cleaningSave());
  await page.waitForTimeout(200);
  ck('温度を入れると保存される', posted.length === 1, JSON.stringify(posted));
  ck('保存内容に温度が入る', posted[0] && posted[0].temperature === '冷蔵3℃ / 冷凍-18℃', JSON.stringify(posted[0]));

  // ③ 温度欄の無い部屋（精肉室）は従来どおりチェックだけで保存できる
  posted.length = 0;
  await page.evaluate(() => { cleaningOpen('精肉室'); document.getElementById('clean-staff').value = PM_OPERATORS[0] || 'テスト'; });
  await page.waitForTimeout(100);
  ck('精肉室には温度欄が出ない', await page.$eval('#clean-temp-row', el => el.style.display) === 'none', '');
  await page.evaluate(() => cleaningSave());
  await page.waitForTimeout(200);
  ck('温度欄の無い部屋は温度なしで保存できる', posted.length === 1 && posted[0].temperature === null, JSON.stringify(posted));

  ck('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 160) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
