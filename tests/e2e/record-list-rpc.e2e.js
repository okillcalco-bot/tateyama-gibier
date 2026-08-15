// record-list: 個体の登録・削除がスタッフ認証つきRPC経由で行われる（P0-2）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/record-list.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9092);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  const rpc = []; const directWrites = [];
  await p.route('**/rest/v1/**', route => {
    const req = route.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    if (url.includes('/rpc/')) {
      const fn = url.split('/rpc/')[1].split('?')[0];
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
      rpc.push({ fn, body });
      if (fn === 'staff_key_ok') return j(true);
      return j({ id: 'x', label_id: (body.p_payload && body.p_payload.label_id) || 'L' });
    }
    if (url.includes('/individuals') && (m === 'POST' || m === 'PATCH')) { directWrites.push(m); return j([]); }
    return j([]);
  });
  await p.goto('http://localhost:9092/record-list.html'); await p.waitForTimeout(400);
  await p.evaluate(() => { try { localStorage.setItem('tg_staff_key', 'test-key'); } catch (e) {} });

  // 削除: 論理削除RPCで来る
  await p.evaluate(() => { pendingDeleteIds = ['id-1', 'id-2']; return confirmDelete(); });
  await p.waitForTimeout(300);
  const dels = rpc.filter(c => c.fn === 'staff_individual_soft_delete');
  ck('削除は staff_individual_soft_delete RPC', dels.length === 2, JSON.stringify(rpc.map(c => c.fn)));
  ck('削除RPCに p_id とキーを渡す', dels[0] && dels[0].body.p_id === 'id-1' && !!dels[0].body.p_staff_key, JSON.stringify(dels[0] && dels[0].body));

  // 登録: staff_individual_create RPCで来る
  await p.evaluate(() => {
    document.getElementById('qDate').value = '2026-08-15';
    document.getElementById('qSerial').value = '500';
    document.getElementById('qMgmt').value = 'TGC-08-T500';
    document.getElementById('qSpecies').value = 'イノシシ';
    return submitQuick();
  });
  await p.waitForTimeout(300);
  const cr = rpc.find(c => c.fn === 'staff_individual_create');
  ck('登録は staff_individual_create RPC', !!cr, JSON.stringify(rpc.map(c => c.fn)));
  ck('登録RPCに label_id を渡す', !!(cr && cr.body.p_payload && cr.body.p_payload.label_id === 'TGC-08-T500'), JSON.stringify(cr && cr.body.p_payload));
  ck('individualsへの直接POST/PATCHが無い', directWrites.length === 0, directWrites.join(','));

  ck('JSエラーなし', errs.length === 0, errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
