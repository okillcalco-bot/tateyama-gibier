// P0-1: スタッフキー/招待発行が Edge Function(auth-gate) 経由で行われ、
// staff_key_ok 等へ直接到達しないこと。429(レート制限)がユーザーへ通知されること。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9101);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));

  const gateCalls = []; const directSensitive = [];
  let rateLimitNext = false;
  await p.route('**/functions/v1/auth-gate', route => {
    let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
    gateCalls.push(body);
    if (rateLimitNext) return route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'rate_limited', retry_after: 42 }) });
    if (body.action === 'staff_key_ok') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: true }) });
    if (body.action === 'create_enrollment') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: { enroll_token: 'et_test' } }) });
    if (body.action === 'rotate_key') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: true }) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ result: null }) });
  });
  await p.route('**/rest/v1/**', route => {
    const url = decodeURIComponent(route.request().url());
    // 認証系RPCへ直接到達したら記録（失敗条件）
    if (/rpc\/(staff_key_ok|admin_rotate_staff_key|staff_create_enrollment_token)/.test(url)) directSensitive.push(url);
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(url.includes('/rpc/') ? true : []) });
  });

  await p.goto('http://localhost:9101/index.html'); await p.waitForTimeout(300);

  // staffKeyEnsure: prompt に応答して staff_key_ok を auth-gate 経由で検証
  p.on('dialog', d => d.accept('this-is-a-long-staff-key-123'));
  const k = await p.evaluate(() => staffKeyEnsure());
  ck('staffKeyEnsureは値を返す', !!k, JSON.stringify(k));
  const skCall = gateCalls.find(c => c.action === 'staff_key_ok');
  ck('staff_key_okはauth-gate経由', !!skCall, JSON.stringify(gateCalls.map(c => c.action)));
  ck('auth-gateにstaff_keyを渡す', !!(skCall && skCall.staff_key), JSON.stringify(skCall));
  ck('staff_key_okへ直接到達しない', directSensitive.length === 0, directSensitive.join(','));

  // copyDeviceSetupLink: create_enrollment を auth-gate 経由で発行
  await p.evaluate(() => copyDeviceSetupLink());
  await p.waitForTimeout(200);
  const enrollCall = gateCalls.find(c => c.action === 'create_enrollment');
  ck('招待発行はauth-gate経由(create_enrollment)', !!enrollCall, JSON.stringify(gateCalls.map(c => c.action)));
  ck('招待発行RPCへ直接到達しない', directSensitive.length === 0, directSensitive.join(','));

  // 429: レート制限時に rate_limited エラーとして捕捉され、ユーザーへ通知（indexはtoast）
  rateLimitNext = true;
  const gotRL = await p.evaluate(async () => {
    try { await authGate('staff_key_ok', { staff_key: 'x' }); return false; }
    catch (e) { return !!e.rate_limited; }
  });
  ck('429はrate_limitedエラーとして捕捉', gotRL, '');
  await p.evaluate(() => { try { localStorage.removeItem('tg_staff_key'); sessionStorage.removeItem('tg_staff_key'); } catch (e) {} });
  p.removeAllListeners('dialog');
  p.on('dialog', d => d.accept('another-long-staff-key-456'));   // promptにキー投入
  await p.evaluate(() => staffKeyEnsure());
  await p.waitForTimeout(150);
  const toastTxt = await p.evaluate(() => (document.getElementById('toasts') || {}).textContent || '');
  ck('429でユーザーへ試行制限を通知(toast)', /試行回数/.test(toastTxt), toastTxt);

  ck('JSエラーなし', errs.length === 0, errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
