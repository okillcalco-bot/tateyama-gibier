// 捕獲票: 未送信（端末内キュー）をバッジから確認・削除できる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/capture-form.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9084);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  p.on('dialog', d => d.accept());   // confirm を承諾
  await p.route('**/rest/v1/**', route => route.fulfill({ contentType: 'application/json', body: '[]' }));
  await p.goto('http://localhost:9084/capture-form.html'); await p.waitForTimeout(500);

  // 未送信キューを2件仕込む
  await p.evaluate(() => {
    localStorage.setItem('tgc_queue', JSON.stringify([
      { hunter_name: '加藤茂', species: 'イノシシ', weight_total: '34', capture_date: '2026-08-15', capture_city: '館山市', capture_area: '神余' },
      { hunter_name: '沖浩志', species: 'イノシシ', weight_total: '22', capture_date: '2026-08-15', capture_city: '南房総市', capture_area: '宮下' },
    ]));
    updatePendingBadge();
  });
  const badge = await p.evaluate(() => ({ text: document.getElementById('pendingBadge').textContent, shown: document.getElementById('pendingBadge').classList.contains('show') }));
  ck('バッジに未送信件数(2件)', badge.shown && badge.text.includes('2'), JSON.stringify(badge));

  // バッジから一覧を開く
  const modal = await p.evaluate(() => { showPendingModal(); const m = document.getElementById('pendingModal'); return { shown: !!m, text: m ? m.textContent : '' }; });
  ck('タップで未送信一覧が開く', modal.shown, String(modal.shown));
  ck('一覧に捕獲者名が出る', modal.text.includes('加藤茂') && modal.text.includes('沖浩志'), modal.text.slice(0, 60));

  // 1件目を削除（confirmは承諾）
  await p.evaluate(() => deletePending(0));
  await p.waitForTimeout(100);
  const after = await p.evaluate(() => JSON.parse(localStorage.getItem('tgc_queue') || '[]'));
  ck('削除で1件減る', after.length === 1, JSON.stringify(after.map(x => (x.payload || x).hunter_name)));
  // P1-3: キューは {operation,payload,client_request_id,...} 形式に正規化される
  ck('残るのは沖浩志', after[0] && after[0].payload && after[0].payload.hunter_name === '沖浩志', JSON.stringify(after));
  ck('正規化: client_request_idを持つ', !!(after[0] && after[0].client_request_id), JSON.stringify(after[0]));
  const badge2 = await p.evaluate(() => document.getElementById('pendingBadge').textContent);
  ck('バッジが1件に更新', badge2.includes('1'), badge2);

  // 残り1件も削除するとバッジが消える
  await p.evaluate(() => deletePending(0));
  await p.waitForTimeout(100);
  const badge3 = await p.evaluate(() => ({ shown: document.getElementById('pendingBadge').classList.contains('show'), q: JSON.parse(localStorage.getItem('tgc_queue') || '[]').length }));
  ck('全削除でバッジ非表示・キュー0', badge3.shown === false && badge3.q === 0, JSON.stringify(badge3));

  ck('JSエラーなし', errs.length === 0, errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
