// Stored XSS対策: 公開入力(hunter_name等)に悪意あるHTMLが登録されても、
// 一覧描画時に実行されず文字列として表示され、tg_device_token が盗まれないこと（P0-4）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const PAYLOAD = '<img src=x onerror="window.__xssExecuted=true;localStorage.setItem(\'stolen\',localStorage.getItem(\'tg_device_token\')||\'\')">';
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/capture-form.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9095);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.route('**/rest/v1/**', route => route.fulfill({ contentType: 'application/json', body: '[]' }));

  // ── capture-form: 搬入一覧カード ──
  await p.goto('http://localhost:9095/capture-form.html'); await p.waitForTimeout(400);
  const cf = await p.evaluate((PAYLOAD) => {
    localStorage.setItem('tg_device_token', 'dt_secret');
    window.__xssExecuted = undefined; localStorage.removeItem('stolen');
    todayData = [{ id: 'row1', species: 'シカ', label_id: PAYLOAD, hunter_name: PAYLOAD, capture_time: '09:00', weight_total: 20, quality: '良' }];
    document.querySelector('[data-tab="list"]') && document.querySelector('[data-tab="list"]').click();
    renderList();
    const html = document.getElementById('cardList').innerHTML;
    const text = document.getElementById('cardList').textContent;
    return { executed: window.__xssExecuted === true, hasImg: /<img[^>]+onerror/i.test(html), textHasPayload: text.includes('onerror'), stolen: localStorage.getItem('stolen') };
  }, PAYLOAD);
  await p.waitForTimeout(200);
  ck('捕獲票一覧: onerrorが実行されない', !cf.executed);
  ck('捕獲票一覧: 生の<img onerror>を挿入しない', !cf.hasImg);
  ck('捕獲票一覧: 文字列として表示される', cf.textHasPayload);
  ck('捕獲票一覧: 端末トークンが盗まれない', !cf.stolen);

  // ── record-list: 一覧テーブル ──
  await p.goto('http://localhost:9095/record-list.html'); await p.waitForTimeout(400);
  const rl = await p.evaluate((PAYLOAD) => {
    localStorage.setItem('tg_device_token', 'dt_secret');
    window.__xssExecuted = undefined; localStorage.removeItem('stolen');
    filteredData = [{ id: 'r1', species: 'シカ', label_id: PAYLOAD, hunter_name: PAYLOAD, capture_area: PAYLOAD, capture_date: '2026-08-16' }];
    renderTable();
    const html = document.getElementById('tableBody').innerHTML;
    const text = document.getElementById('tableBody').textContent;
    return { executed: window.__xssExecuted === true, hasImg: /<img[^>]+onerror/i.test(html), textHasPayload: text.includes('onerror'), stolen: localStorage.getItem('stolen') };
  }, PAYLOAD);
  await p.waitForTimeout(200);
  ck('搬入一覧: onerrorが実行されない', !rl.executed);
  ck('搬入一覧: 生の<img onerror>を挿入しない', !rl.hasImg);
  ck('搬入一覧: 文字列として表示される', rl.textHasPayload);
  ck('搬入一覧: 端末トークンが盗まれない', !rl.stolen);

  ck('JSエラーなし', errs.length === 0, errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
