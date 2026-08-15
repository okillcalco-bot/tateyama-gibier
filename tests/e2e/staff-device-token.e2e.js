// スタッフ認証: 端末には生キーを保存せず、失効可能な端末トークンを使う
// - 初回はスタッフキーで登録→トークン保存（生キーはlocalStorageに残さない）
// - 2回目以降は再入力なし（トークン再利用）
// - 「認証を解除」でトークン失効＋端末から削除
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/capture-form.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9093);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  const rpc = [];
  await p.route('**/rest/v1/**', route => {
    const req = route.request(); const url = decodeURIComponent(req.url());
    const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    if (url.includes('/rpc/')) {
      const fn = url.split('/rpc/')[1].split('?')[0];
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
      rpc.push({ fn, body });
      if (fn === 'staff_token_ok') return j(true);
      if (fn === 'staff_device_register') return j({ token: 'tok-abc', expires_at: '2026-09-14' });
      if (fn === 'staff_device_revoke') return j(true);
      if (fn === 'staff_key_ok') return j(true);
      return j({});
    }
    return j([]);
  });
  await p.goto('http://localhost:9093/capture-form.html'); await p.waitForTimeout(300);

  // 1) 初回: プロンプトでキー入力 → 端末登録 → トークン保存・生キーは保存しない
  const first = await p.evaluate(async () => {
    window.prompt = () => 'THE-STAFF-KEY-1234';
    const tok = await staffKeyEnsure();
    return { tok, deviceToken: localStorage.getItem('tg_device_token'), rawKey: localStorage.getItem('tg_staff_key') };
  });
  ck('初回でトークンを取得', first.tok === 'tok-abc', first.tok);
  ck('端末トークンをlocalStorageに保存', first.deviceToken === 'tok-abc', String(first.deviceToken));
  ck('生のスタッフキーは保存しない', !first.rawKey, String(first.rawKey));
  ck('登録RPC(staff_device_register)を呼ぶ', rpc.some(c => c.fn === 'staff_device_register'));

  // 2) 2回目: プロンプトを呼ばず、トークンを再利用
  const second = await p.evaluate(async () => {
    window._prompted = false; window.prompt = () => { window._prompted = true; return 'X'; };
    const tok = await staffKeyEnsure();
    return { tok, prompted: window._prompted };
  });
  ck('2回目は再入力なし（プロンプト呼ばれない）', second.prompted === false, JSON.stringify(second));
  ck('2回目もトークンを返す', second.tok === 'tok-abc', second.tok);
  ck('2回目はstaff_token_okで検証', rpc.some(c => c.fn === 'staff_token_ok'));

  // 3) 認証解除 → 失効RPC＋端末から削除
  const revoked = await p.evaluate(async () => {
    window.alert = () => {};
    await staffDeviceRevoke();
    return { deviceToken: localStorage.getItem('tg_device_token') };
  });
  ck('失効RPC(staff_device_revoke)を呼ぶ', rpc.some(c => c.fn === 'staff_device_revoke'));
  ck('解除後は端末トークンが消える', !revoked.deviceToken, String(revoked.deviceToken));

  // 4) 認証解除ボタンは認証中のみ表示
  const vis = await p.evaluate(() => {
    const el = document.getElementById('deviceRevokeBtn');
    const hiddenNow = el.style.display === 'none';
    localStorage.setItem('tg_device_token', 'tok-abc'); updateDeviceRevokeVis();
    const shown = el.style.display !== 'none';
    return { hiddenNow, shown };
  });
  ck('未認証では解除ボタン非表示', vis.hiddenNow);
  ck('認証中は解除ボタン表示', vis.shown);

  ck('JSエラーなし', errs.length === 0, errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
