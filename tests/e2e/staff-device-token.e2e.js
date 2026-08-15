// スタッフ認証: 端末トークン(dt_)の再利用と失効。現場端末は生スタッフキーを扱わない。
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
      if (fn === 'staff_device_revoke') return j(true);
      return j({});
    }
    return j([]);
  });
  await p.goto('http://localhost:9093/capture-form.html'); await p.waitForTimeout(300);

  // 1) 認証済み端末（dt_トークンあり）は再入力なしで再利用
  const reuse = await p.evaluate(async () => {
    localStorage.setItem('tg_device_token', 'dt_reuse');
    window.__prompted = false; window.prompt = () => { window.__prompted = true; return 'X'; };
    const tok = await staffKeyEnsure();
    return { tok, prompted: window.__prompted };
  });
  ck('端末トークンを再利用', reuse.tok === 'dt_reuse', reuse.tok);
  ck('再利用時にプロンプトを出さない', reuse.prompted === false, JSON.stringify(reuse));
  ck('再利用は staff_token_ok で検証', rpc.some(c => c.fn === 'staff_token_ok'));

  // 2) 認証解除 → 失効RPC＋端末から削除
  const revoked = await p.evaluate(async () => {
    window.alert = () => {};
    await staffDeviceRevoke();
    return { deviceToken: localStorage.getItem('tg_device_token') };
  });
  ck('失効RPC(staff_device_revoke)を呼ぶ', rpc.some(c => c.fn === 'staff_device_revoke'));
  ck('解除後は端末トークンが消える', !revoked.deviceToken, String(revoked.deviceToken));

  // 3) 未認証端末では生スタッフキーを要求しない（認証リンク案内のみ）
  const noraw = await p.evaluate(async () => {
    localStorage.removeItem('tg_device_token');
    window.__promptedRaw = false; window.prompt = () => { window.__promptedRaw = true; return 'RAWKEY'; };
    window.alert = () => {};
    const t = await staffKeyEnsure();
    return { t, prompted: window.__promptedRaw, rawKey: localStorage.getItem('tg_staff_key') };
  });
  ck('未認証時に生スタッフキーを要求しない', noraw.prompted === false && !noraw.t, JSON.stringify(noraw));
  ck('生スタッフキーを保存しない', !noraw.rawKey);

  // 4) 解除ボタンは認証中のみ表示
  const vis = await p.evaluate(() => {
    const el = document.getElementById('deviceRevokeBtn');
    const hiddenNow = el.style.display === 'none';
    localStorage.setItem('tg_device_token', 'dt_reuse'); updateDeviceRevokeVis();
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
