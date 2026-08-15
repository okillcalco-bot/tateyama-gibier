// 端末認証リンク(#enroll=<使い捨て招待>)でセンター端末を認証。
// 生スタッフキーがURL/localStorage/sessionStorage/DOMに残らないことを検証（P0-2）
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
  const bodies = [];
  await p.route('**/rest/v1/**', route => {
    const req = route.request(); const url = decodeURIComponent(req.url());
    const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    if (url.includes('/rpc/staff_enroll_device')) { let b2 = {}; try { b2 = JSON.parse(req.postData() || '{}'); } catch (e) {} bodies.push({ fn: 'enroll', body: b2 }); return j({ token: 'dt_enrolled', expires_at: '2026-09-14' }); }
    if (url.includes('/rpc/staff_device_register')) { bodies.push({ fn: 'register', body: {} }); return j({}); }  // 呼ばれてはいけない
    if (url.includes('/rpc/')) return j({});
    return j([]);
  });

  const ENROLL = 'et_oneTimeToken123';
  await p.goto('http://localhost:9094/capture-form.html#enroll=' + ENROLL); await p.waitForTimeout(500);

  const st = await p.evaluate(() => ({
    token: localStorage.getItem('tg_device_token'),
    rawKeyLS: localStorage.getItem('tg_staff_key'),
    rawKeySS: sessionStorage.getItem('tg_staff_key'),
    hash: location.hash,
    href: location.href,
    dom: document.documentElement.innerHTML,
  }));
  ck('招待リンクで端末トークンを取得', st.token === 'dt_enrolled', String(st.token));
  ck('交換RPCは staff_enroll_device', bodies.some(x => x.fn === 'enroll' && x.body.p_enroll_token === ENROLL), JSON.stringify(bodies));
  ck('staff_device_register は呼ばれない', !bodies.some(x => x.fn === 'register'));
  ck('URLから #enroll を即時除去', !/enroll=/.test(st.hash) && !/enroll=/.test(st.href), st.href);
  ck('生スタッフキーをlocalStorageに保存しない', !st.rawKeyLS, String(st.rawKeyLS));
  ck('生スタッフキーをsessionStorageに保存しない', !st.rawKeySS, String(st.rawKeySS));
  ck('招待トークンがDOMに残らない', !st.dom.includes(ENROLL));

  // 未認証端末では staffKeyEnsure は生キーを聞かず、認証リンク案内のみ（token返さない）
  const noPrompt = await p.evaluate(async () => {
    localStorage.removeItem('tg_device_token');
    window.prompt = () => { window.__promptedRawKey = true; return 'RAWKEY'; };
    window.__promptedRawKey = false;
    const t = await staffKeyEnsure();
    return { t, prompted: window.__promptedRawKey };
  });
  ck('未認証時に生スタッフキーを要求しない', noPrompt.prompted === false && !noPrompt.t, JSON.stringify(noPrompt));

  ck('JSエラーなし', errs.length === 0, errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
