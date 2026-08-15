// 共有リンク(#skey=…)でセンター端末を一度だけ認証（キー入力不要・生キーは保存しない）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/capture-form.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9094);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  p.on('dialog', d => d.accept());
  const reg = [];
  await p.route('**/rest/v1/**', route => {
    const req = route.request(); const url = decodeURIComponent(req.url());
    const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    if (url.includes('/rpc/staff_device_register')) { let b2 = {}; try { b2 = JSON.parse(req.postData() || '{}'); } catch (e) {} reg.push(b2); return j({ token: 'dt_shared', expires_at: '2026-09-14' }); }
    if (url.includes('/rpc/')) return j({});
    return j([]);
  });

  // 共有リンクで開く（#skey=センターキー）
  await p.goto('http://localhost:9094/capture-form.html#skey=THE-CENTER-KEY-1234'); await p.waitForTimeout(500);

  const st = await p.evaluate(() => ({
    token: localStorage.getItem('tg_device_token'),
    rawKey: localStorage.getItem('tg_staff_key'),
    hash: location.hash,
  }));
  ck('共有リンクで端末トークンを設定', st.token === 'dt_shared', String(st.token));
  ck('生のスタッフキーは端末に保存しない', !st.rawKey, String(st.rawKey));
  ck('URLからキー(#skey)を消す', st.hash === '' || !st.hash.includes('skey'), st.hash);
  ck('登録RPCへ正しいキーを渡す', reg.length === 1 && reg[0].p_staff_key === 'THE-CENTER-KEY-1234', JSON.stringify(reg[0] || {}));
  ck('認証解除ボタンが表示される', await p.evaluate(() => document.getElementById('deviceRevokeBtn').style.display !== 'none'));

  ck('JSエラーなし', errs.length === 0, errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
