// 捕獲票: カメラが開けなかったとき、理由ごとに何をすればよいかを出す（2026-11-05 iPadで撮影できなくなった）
//   測ること（端末のカメラは偽物で、失敗のしかたを作る）
//     1. 許可されていない（NotAllowedError）→「許可されていません」と許可の直し方（iPadは「Webサイトの設定」）
//     2. 別のアプリが使っている（NotReadableError）→「別のアプリかタブが使っています」
//     3. 外側カメラの指定で失敗（OverconstrainedError）→ 指定なしでもう一度開き、開ければエラーは出さない
//     4. エラーの文は3.5秒で消えずに残る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = path.resolve(__dirname, '../..');
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/capture-form.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9083);
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const R = []; const ck = (n, c, g) => R.push([n, !!c, g == null ? '' : String(g)]);
  const REC = { id: 'r1', label_id: 'TGC-08-T901', serial_number: 1, species: 'イノシシ', capture_date: '2026-11-05', hunter_name: '架空太郎', capture_city: '館山市', capture_area: '神余' };
  const run = async (ua, mode) => {
    const ctx = await b.newContext({ viewport: { width: 820, height: 1180 }, userAgent: ua });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(String(e)));
    await p.route('**/rest/v1/**', rt => rt.fulfill({ contentType: 'application/json', body: '[]' }));
    await p.addInitScript(m => {
      window.__calls = [];
      const fake = () => { const c = document.createElement('canvas'); c.width = 64; c.height = 48; c.getContext('2d').fillRect(0, 0, 64, 48); return c.captureStream(5); };
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async (cons) => {
        window.__calls.push(JSON.stringify(cons.video));
        const err = n => { const e = new Error(n); e.name = n; return e; };
        if (m === 'denied') throw err('NotAllowedError');
        if (m === 'busy') throw err('NotReadableError');
        if (m === 'overconstrained' && cons.video && cons.video.facingMode) throw err('OverconstrainedError');
        return fake();
      } } });
    }, mode);
    await p.goto('http://localhost:9083/capture-form.html'); await p.waitForTimeout(400);
    await p.evaluate(r => { showBoard(r, false); }, REC);
    await p.evaluate(() => arStart()); await p.waitForTimeout(500);
    const now = await p.evaluate(() => ({ msg: document.getElementById('arMsg').textContent, shown: document.getElementById('arMsg').style.display !== 'none', calls: window.__calls }));
    await p.waitForTimeout(3800);
    const later = await p.evaluate(() => document.getElementById('arMsg').style.display !== 'none');
    await ctx.close();
    return { ...now, later, errs };
  };
  const IPAD = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const d = await run(IPAD, 'denied');
  ck('1. 許可なし → 「許可されていません」と出る', /カメラの使用が許可されていません/.test(d.msg), d.msg);
  ck('1. iPadでは「Webサイトの設定」→「カメラ」→「許可」と直し方を出す', /Webサイトの設定/.test(d.msg) && /設定アプリ→Safari/.test(d.msg), d.msg);
  ck('4. エラーの文は3.5秒たっても消えない', d.shown && d.later, JSON.stringify([d.shown, d.later]));
  const bz = await run(IPAD, 'busy');
  ck('2. 別のアプリが使用中 → 「別のアプリかタブが使っています」', /別のアプリかタブが使っています/.test(bz.msg), bz.msg);
  const oc = await run(IPAD, 'overconstrained');
  ck('3. 外側カメラの指定で失敗 → 指定なしでもう一度開く（2回呼ぶ・2回目は video:true）', oc.calls.length === 2 && oc.calls[1] === 'true', JSON.stringify(oc.calls));
  ck('3. 開けたらエラーは出さない', !/カメラ/.test(oc.msg) || !oc.later, oc.msg);
  const ok = await run(IPAD, 'ok');
  ck('ふつうに開けるときは1回だけ・外側カメラ指定', ok.calls.length === 1 && /environment/.test(ok.calls[0]), JSON.stringify(ok.calls));
  ck('pageerrorなし', [d, bz, oc, ok].every(x => !x.errs.length), [d, bz, oc, ok].map(x => x.errs.join('/')).join(' | '));
  await b.close(); srv.close();
  let pass = 0; for (const [n, okk, g] of R) { console.log((okk ? 'PASS' : 'FAIL') + ' : ' + n + (g ? '  [' + g.slice(0, 200) + ']' : '')); if (okk) pass++; }
  console.log(`\n${pass}/${R.length} passed`); process.exit(pass === R.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
