// 捕獲票: 書込がRPC経由（public_capture_submit）で行われ、直接INSERTしない（P0-2）
// キューはネット/5xxのみ再送・4xxは要確認として保持・client_request_idで冪等（P1-3）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/capture-form.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9091);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  p.on('dialog', d => d.accept());

  // 直接INSERT/PATCHが来たら記録（来てはいけない）
  const directWrites = []; const rpcCalls = [];
  await p.route('**/rest/v1/**', route => {
    const req = route.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    if (url.includes('/rest/v1/rpc/')) {
      const fn = url.split('/rpc/')[1].split('?')[0];
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
      rpcCalls.push({ fn, body });
      if (fn === 'public_capture_submit') return j({ id: 'new1', label_id: body.p_payload && body.p_payload.label_id, serial_number: 999 });
      if (fn === 'staff_key_ok') return j(true);
      return j({});
    }
    if (url.includes('/individuals') && (m === 'POST' || m === 'PATCH')) { directWrites.push(m + ' ' + url); return j([]); }
    if (url.includes('/app_settings')) return j([{ value: {} }]);
    if (url.includes('/area_master')) return j([]);
    return j([]);
  });
  await p.goto('http://localhost:9091/capture-form.html'); await p.waitForTimeout(500);

  // 最小限の有効入力で登録 → public_capture_submit が呼ばれ、直接INSERTは無し
  await p.evaluate(() => {
    state.species = 'イノシシ'; state.sex = 'オス';
    document.getElementById('indLabelId').value = 'TGC-08-T999';
    document.getElementById('indSerial').value = '999';
    window.receiveMode = false; window.hunterMode = false; editMode = false; editRecordId = null;
  });
  await p.evaluate(() => handleSubmit());
  await p.waitForTimeout(600);
  const submitCall = rpcCalls.find(c => c.fn === 'public_capture_submit');
  ck('登録はpublic_capture_submit経由', !!submitCall, JSON.stringify(rpcCalls.map(c => c.fn)));
  ck('payloadに捕獲票の項目が入る', !!(submitCall && submitCall.body.p_payload && submitCall.body.p_payload.label_id === 'TGC-08-T999'), JSON.stringify(submitCall && submitCall.body.p_payload || {}).slice(0, 80));
  ck('冪等用のp_request_idを送る', !!(submitCall && submitCall.body.p_request_id), JSON.stringify(submitCall && submitCall.body));
  ck('individualsへの直接INSERT/PATCHが無い', directWrites.length === 0, directWrites.join(' | '));

  // 買取金額など業務項目はpayloadに含めない（改ざん防止の一環：フォームが送らない）
  ck('payloadに買取金額を含めない', !(submitCall && 'buyback_amount' in (submitCall.body.p_payload || {})), '');

  // --- キュー再送: 成功でドレイン ---
  await p.evaluate(() => {
    localStorage.setItem('tgc_queue', JSON.stringify([
      { operation: 'submit', payload: { label_id: 'TGC-08-T111', species: 'イノシシ', hunter_name: '甲' }, client_request_id: 'req-a', queued_at: '2026-08-15T00:00:00Z', retry_count: 0, last_error: null },
    ]));
    updatePendingBadge();
  });
  await p.evaluate(() => syncPending());
  await p.waitForTimeout(300);
  const afterOk = await p.evaluate(() => JSON.parse(localStorage.getItem('tgc_queue') || '[]'));
  const resendCall = rpcCalls.find(c => c.fn === 'public_capture_submit' && c.body.p_request_id === 'req-a');
  ck('再送はclient_request_idを引き継ぐ（冪等）', !!resendCall, JSON.stringify(resendCall && resendCall.body));
  ck('成功でキューが空になる', afterOk.length === 0, JSON.stringify(afterOk));

  // --- キュー再送: 400は「要確認(blocked)」として保持し自動再送しない ---
  await p.route('**/rest/v1/rpc/public_capture_submit', route =>
    route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'invalid input' }) }), { times: 1 });
  await p.evaluate(() => {
    localStorage.setItem('tgc_queue', JSON.stringify([
      { operation: 'submit', payload: { label_id: 'TGC-08-T222', species: 'イノシシ' }, client_request_id: 'req-b', queued_at: '2026-08-15T00:00:00Z', retry_count: 0, last_error: null },
    ]));
  });
  await p.evaluate(() => syncPending());
  await p.waitForTimeout(300);
  const afterBad = await p.evaluate(() => JSON.parse(localStorage.getItem('tgc_queue') || '[]'));
  ck('4xxは保持される', afterBad.length === 1, JSON.stringify(afterBad));
  ck('4xxはblocked=trueで要確認', !!(afterBad[0] && afterBad[0].last_error && afterBad[0].last_error.blocked), JSON.stringify(afterBad[0] && afterBad[0].last_error));
  // blocked以降は自動再送されない
  const before = rpcCalls.filter(c => c.body.p_request_id === 'req-b').length;
  await p.evaluate(() => syncPending());
  await p.waitForTimeout(200);
  const after2 = rpcCalls.filter(c => c.body.p_request_id === 'req-b').length;
  ck('blockedは自動再送しない', after2 === before, `${before}->${after2}`);

  // --- 5xxは retry_count++ で保持（再送対象のまま） ---
  await p.route('**/rest/v1/rpc/public_capture_submit', route =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '{"message":"temporarily unavailable"}' }), { times: 1 });
  await p.evaluate(() => {
    localStorage.setItem('tgc_queue', JSON.stringify([
      { operation: 'submit', payload: { label_id: 'TGC-08-T333', species: 'イノシシ' }, client_request_id: 'req-c', queued_at: '2026-08-15T00:00:00Z', retry_count: 0, last_error: null },
    ]));
  });
  await p.evaluate(() => syncPending());
  await p.waitForTimeout(300);
  const after5 = await p.evaluate(() => JSON.parse(localStorage.getItem('tgc_queue') || '[]'));
  ck('5xxは保持・retry_count増加・blockedでない', after5.length === 1 && after5[0].retry_count === 1 && !(after5[0].last_error && after5[0].last_error.blocked), JSON.stringify(after5[0]));

  ck('JSエラーなし', errs.length === 0, errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
