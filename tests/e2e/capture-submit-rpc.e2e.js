// 捕獲票: 公開登録(捕獲者)とセンター受入(スタッフ)の分離、submission_token、冪等キュー（v2）
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
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  p.on('dialog', d => d.accept());
  const directWrites = []; const rpc = [];
  await p.route('**/rest/v1/**', route => {
    const req = route.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    if (url.includes('/rest/v1/rpc/')) {
      const fn = url.split('/rpc/')[1].split('?')[0];
      let body = {}; try { body = JSON.parse(req.postData() || '{}'); } catch (e) {}
      rpc.push({ fn, body });
      if (fn === 'public_capture_submit') return j({ id: 'new1', label_id: '仮-ABC123', serial_number: null, submission_token: 'st_tok1' });
      if (fn === 'staff_capture_intake') return j({ id: 'new2', label_id: body.p_payload && body.p_payload.label_id, serial_number: 950, submission_token: 'st_tok2' });
      if (fn === 'staff_token_ok') return j(true);
      if (fn === 'staff_device_register') return j({ token: 'dt_x', expires_at: '2026-09-14' });
      return j({});
    }
    if (url.includes('/individuals') && (m === 'POST' || m === 'PATCH')) { directWrites.push(m + ' ' + url); return j([]); }
    if (url.includes('/app_settings')) return j([{ value: {} }]);
    if (url.includes('/area_master')) return j([]);
    return j([]);
  });
  await p.goto('http://localhost:9091/capture-form.html'); await p.waitForTimeout(400);

  // ── 一般捕獲者（hunterMode）: public_capture_submit・正式情報は送らない ──
  await p.evaluate(() => {
    window.hunterMode = true; editMode = false; editRecordId = null;
    state.species = 'イノシシ'; state.sex = 'オス'; state.quality = '良';
    document.getElementById('indLabelId').value = 'TGC-08-T999';
    document.getElementById('indSerial').value = '999';
    document.getElementById('receiveTime').value = '09:00';
  });
  await p.evaluate(() => handleSubmit());
  await p.waitForTimeout(500);
  const pub = rpc.find(c => c.fn === 'public_capture_submit');
  ck('捕獲者は public_capture_submit 経由', !!pub, JSON.stringify(rpc.map(c => c.fn)));
  ck('公開payloadに label_id を含めない', !!pub && !('label_id' in (pub.body.p_payload || {})), JSON.stringify(pub && pub.body.p_payload));
  ck('公開payloadに serial_number を含めない', !!pub && !('serial_number' in (pub.body.p_payload || {})));
  ck('公開payloadに quality/受入時刻を含めない', !!pub && !('quality' in pub.body.p_payload) && !('receive_time' in pub.body.p_payload));
  ck('冪等用 p_request_id を送る', !!(pub && pub.body.p_request_id));
  ck('直接INSERT/PATCHは無い', directWrites.length === 0, directWrites.join(' | '));

  // ── センター受入（staffモード）: staff_capture_intake・正式情報を送る ──
  rpc.length = 0;
  await p.evaluate(() => { try { localStorage.setItem('tg_device_token', 'dt_x'); } catch (e) {} });
  await p.evaluate(() => {
    window.hunterMode = false; window.receiveMode = false; editMode = false; editRecordId = null;
    state.species = 'イノシシ'; state.sex = 'オス';
    document.getElementById('indLabelId').value = 'TGC-08-T950';
    document.getElementById('indSerial').value = '950';
  });
  await p.evaluate(() => handleSubmit());
  await p.waitForTimeout(500);
  const intake = rpc.find(c => c.fn === 'staff_capture_intake');
  ck('スタッフは staff_capture_intake 経由', !!intake, JSON.stringify(rpc.map(c => c.fn)));
  ck('受入payloadに正式番号を送る', !!(intake && intake.body.p_payload && intake.body.p_payload.label_id === 'TGC-08-T950'));
  ck('受入は端末トークンで認証', !!(intake && String(intake.body.p_staff_key || '').startsWith('dt_')), JSON.stringify(intake && intake.body.p_staff_key));

  // ── キュー: 捕獲者オフライン→公開payloadで積む→復旧で public_capture_submit 再送 ──
  await p.evaluate(() => {
    localStorage.setItem('tgc_queue', JSON.stringify([
      { operation: 'submit', payload: { species: 'イノシシ', hunter_name: '甲' }, client_request_id: 'req-a', queued_at: '2026-08-16T00:00:00Z', retry_count: 0, last_error: null },
    ]));
  });
  rpc.length = 0;
  await p.evaluate(() => syncPending());
  await p.waitForTimeout(300);
  const resend = rpc.find(c => c.fn === 'public_capture_submit' && c.body.p_request_id === 'req-a');
  ck('キュー再送は公開RPC＋同一request_id', !!resend, JSON.stringify(rpc.map(c => c.fn)));
  const q = await p.evaluate(() => JSON.parse(localStorage.getItem('tgc_queue') || '[]'));
  ck('成功でキューが空になる', q.length === 0, JSON.stringify(q));

  ck('JSエラーなし', errs.length === 0, errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
