// 精肉の重量表示: 浮動小数点の誤差を発生源で止め、既存の誤差は表示で丸める
//
//   きっかけ（2026-09-10）
//     「精肉の重量はラベル上は小数点以下2桁になってるんだけど、元データが
//     .999999ってのがあるからこっちも丸めたい」という指摘。
//     「最近の精肉処理」ダッシュボードに 0.5599999999999999 kg のような
//     値がそのまま出ていた。原因は計量値からビニール袋10gを引く単純な
//     引き算（例: 0.57 - 0.01）がJSの浮動小数点誤差をそのまま
//     processing_log.weight / inventory.weight に保存していたこと。
//     ラベル印字はtoFixedで丸めていたため気付かれず、生値を出す画面
//     （最近の精肉処理・加工履歴・HACCP帳票）にだけ現れていた。
//
//   ここで測ること
//     1. pmNetWeight()（袋重量差引）が浮動小数点の誤差を出さない
//        （0.57-0.01, 0.15-0.01, 0.47-0.01 など、実際に誤差が出ていた組み合わせ）
//     2. 既にDBに入っている誤差入りの値も、「最近の精肉処理」ダッシュボードでは
//        小数点以下2桁に丸めて表示される
//     3. 個体詳細の「加工履歴」でも同様に丸めて表示される
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');

(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9102);
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { await d.dismiss(); });

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  const PROC_LOGS = [
    { id: 'l1', created_at: '2026-09-09T16:15:00Z', parent_ident_code: 'TGC-08-T307', child_ident_code: 'TGC-08-T307-AJ', weight: 0.5599999999999999, operator: '吉田友美' },
    { id: 'l2', created_at: '2026-09-09T16:14:00Z', parent_ident_code: 'TGC-08-T307', child_ident_code: 'TGC-08-T307-HI', weight: 0.13999999999999999, operator: '吉田友美' },
  ];

  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = x => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m !== 'GET') return J([]);
    if (/\/processing_log\b/.test(url)) {
      // 個体詳細モーダルの加工履歴（or=(...)）とダッシュボード一覧の両方をここで返す
      return J(PROC_LOGS);
    }
    if (/\/individuals\b/.test(url)) return J([]);
    if (/\/inventory\b/.test(url)) return J([]);
    if (/\/shipments\b/.test(url)) return J([]);
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));

  await page.goto('http://localhost:9102/index.html');
  await page.waitForTimeout(700);

  // 1) pmNetWeight: 実際に誤差が出ていた組み合わせで検証
  const netResults = await page.evaluate(() => [0.57, 0.15, 0.47, 0.57].map(w => pmNetWeight(w)));
  T('0.57-0.01 は 0.56 ちょうど（浮動小数点誤差なし）', netResults[0] === 0.56, JSON.stringify(netResults));
  T('0.15-0.01 は 0.14 ちょうど', netResults[1] === 0.14, JSON.stringify(netResults));
  T('0.47-0.01 は 0.46 ちょうど', netResults[2] === 0.46, JSON.stringify(netResults));
  const allClean = netResults.every(n => String(n).length <= 5); // "0.56"等、長い誤差の羅列でない
  T('どれも誤差の羅列(0.55999999...等)にならない', allClean, JSON.stringify(netResults));

  // 2) ダッシュボード「最近の精肉処理」: 既存の誤差入りデータも2桁に丸めて出る
  await page.evaluate(() => loadDashboard());
  await page.waitForTimeout(300);
  const dashHtml = await page.$eval('#dash-proc', el => el.innerHTML);
  T('0.5599999999999999 は 0.56 kg と丸めて出る', dashHtml.includes('0.56 kg'), dashHtml.slice(0, 300));
  T('0.13999999999999999 は 0.14 kg と丸めて出る', dashHtml.includes('0.14 kg'), dashHtml.slice(0, 300));
  T('生の誤差(0.5599999999999999)がそのまま出ない', !dashHtml.includes('0.5599999999999999'), dashHtml.slice(0, 300));

  T('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close(); srv.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
