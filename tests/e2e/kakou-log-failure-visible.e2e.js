// 加工処理: 原料とのつながり（processing_log）の保存に失敗したら、黙らずに画面に出す（2026-09-30）
//
//   きっかけ
//     スライス3mm 20kg の加工処理で、原料ミンチ12点のうち3点しかつながっていなかった。
//     調べる中で、kkSubmit が processing_log の保存失敗を握り潰す作りだと分かった
//     （CLAUDE.md 約束4「サイレント失敗を作らない」／加工ログが1件も保存されていなかった事故）。
//
//   ここで測ること
//     1. processing_log の保存が失敗しても、加工処理そのもの（完成パックの登録）は止まらない
//     2. 失敗したことがトーストで画面に出る（「トレーサビリティ」を含む）
//     3. 成功したときは、そのエラーは出ない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9076);
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

  const INV = { id: 'inv-1', ident_code: 'TGC-08-T339-MU', part_name: 'ミンチ用', weight: 0.86, weight_kg: 0.86, species: 'イノシシ', individual_id: 'TGC-08-T339', status: '在庫', tier: 2 };
  let logFails = true; const posted = { packs: 0, logs: 0 };
  const p = await (await b.newContext()).newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  await p.route('**/rest/v1/**', route => {
    const req = route.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    if (url.includes('/processing_log') && m === 'POST') {
      posted.logs++;
      if (logFails) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' });
      return j([{}]);
    }
    if (url.includes('/inventory') && m === 'GET') return j(url.includes('ident_code=eq.') ? [INV] : []);
    if (url.includes('/inventory') && m === 'POST') { posted.packs++; return j([{}]); }
    return j([]);
  });
  await p.goto('http://localhost:9076/index.html'); await p.waitForTimeout(500);
  await p.evaluate(async () => { await loadKakou(); });

  const run = () => p.evaluate(async () => {
    window.__toasts = []; const orig = window.toast; window.toast = (msg, kind) => { window.__toasts.push([msg, kind]); try { orig(msg, kind); } catch (e) {} };
    window.confirm = () => true; window.print = () => {}; window.open = () => null;
    kkMaterials = [];
    document.getElementById('kk-scan').value = 'TGC-08-T339-MU'; await kkScanAdd();
    document.getElementById('kk-operator').innerHTML = '<option value="白石">白石</option>';
    document.getElementById('kk-operator').value = '白石';
    document.getElementById('kk-type').value = 'スライス'; kkTypeChange();
    document.getElementById('kk-thick').value = '3';
    document.getElementById('kk-pack-w').value = '0.5';
    document.getElementById('kk-pack-n').value = '2';
    kkUpdateSummary();
    await kkSubmit();
    return window.__toasts;
  });

  const t1 = await run();
  T('ログ保存が失敗しても完成パックは登録される', posted.packs === 1, String(posted.packs));
  T('ログ保存を試みている', posted.logs === 1, String(posted.logs));
  const err = t1.find(([m, k]) => k === 'error' && /トレーサビリティ/.test(m));
  T('失敗がエラーのトーストで画面に出る', !!err, JSON.stringify(t1));
  T('加工処理の完了トーストも出る（業務は止まらない）', t1.some(([m]) => /加工処理を記録しました/.test(m)), JSON.stringify(t1));

  logFails = false;
  const t2 = await run();
  T('成功時はトレーサビリティのエラーを出さない', !t2.some(([m]) => /トレーサビリティ/.test(m)), JSON.stringify(t2));

  T('ページエラーなし', errors.length === 0, errors.join(' / '));
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + got.slice(0, 250) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await b.close(); srv.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
