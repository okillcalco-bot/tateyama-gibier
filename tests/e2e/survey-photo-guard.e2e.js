// Codex 4巡目 P1-4 (11)(12):
//  (11) svMakeSheets が survey_downloaded_at を現行RPCで保存する
//       - 登録直後: public_capture_update_survey(p_submission_token, patch.survey_downloaded_at)
//       - 後日スタッフ: staff_individual_update(dt_端末トークン, patch.survey_downloaded_at)
//  (12) private化前は capture-photos への実写真アップロードが拒否される（サーバ側403）ことを
//       クライアントが握り潰さず失敗として扱う（保存済みパスを返さない）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/capture-form.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9103);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  p.on('dialog', d => d.accept());   // alert等は自動でOK

  const rpc = []; let storageAttempts = 0; let storageDeny = false;
  await p.route('**/rest/v1/**', route => {
    const url = decodeURIComponent(route.request().url()); const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    if (url.includes('/rpc/')) {
      const fn = url.split('/rpc/')[1].split('?')[0];
      let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      rpc.push({ fn, body });
      if (fn === 'staff_token_ok') return j(true);
      return j({ id: 'x', label_id: (body.p_payload && body.p_payload.label_id) || 'L' });
    }
    return j([]);
  });
  await p.route('**/storage/v1/object/**', route => {
    storageAttempts++;
    if (storageDeny) return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security' }) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ Key: 'ok' }) });
  });

  await p.goto('http://localhost:9103/capture-form.html'); await p.waitForTimeout(300);
  await p.evaluate(() => { window.svOpenPrint = () => {}; });   // 印刷ウィンドウを開かない

  // (11a) 登録直後: submission_token 経由で survey_downloaded_at を保存
  await p.evaluate(() => {
    window._submissionToken = 'st_test';
    return svMakeSheets({ label_id: '仮-ABC123', capture_date: '2026-08-15', hunter_name: 'テスト' }, {});
  });
  await p.waitForTimeout(200);
  const surv = rpc.find(c => c.fn === 'public_capture_update_survey');
  ck('登録直後はpublic_capture_update_survey', !!surv, JSON.stringify(rpc.map(c => c.fn)));
  ck('submission_token を渡す', !!(surv && surv.body.p_submission_token === 'st_test'), JSON.stringify(surv && surv.body));
  ck('survey_downloaded_at を保存', !!(surv && surv.body.p_patch && surv.body.p_patch.survey_downloaded_at), JSON.stringify(surv && surv.body.p_patch));

  // (11b) 後日スタッフ: dt_端末トークンで staff_individual_update
  rpc.length = 0;
  await p.evaluate(() => {
    window._submissionToken = null;
    try { localStorage.setItem('tg_device_token', 'dt_test'); } catch (e) {}
    return svMakeSheets({ id: 'rec-1', label_id: 'TGC-08-T100', capture_date: '2026-08-15', hunter_name: 'テスト' }, {});
  });
  await p.waitForTimeout(200);
  const upd = rpc.find(c => c.fn === 'staff_individual_update');
  ck('後日スタッフはstaff_individual_update', !!upd, JSON.stringify(rpc.map(c => c.fn)));
  ck('dt_端末トークンを渡す', !!(upd && String(upd.body.p_staff_key || '').startsWith('dt_')), JSON.stringify(upd && upd.body.p_staff_key));
  ck('survey_downloaded_at を保存(スタッフ)', !!(upd && upd.body.p_patch && upd.body.p_patch.survey_downloaded_at), JSON.stringify(upd && upd.body.p_patch));

  // (12) private化前: capture-photos への実写真アップロードは 403 で拒否され、パスを返さない
  storageDeny = true;
  const uploadResult = await p.evaluate(async () => {
    svPhotos.before = { blob: new Blob(['x'], { type: 'image/jpeg' }) };   // 実バインディングを直接設定
    try { const r = await svUpload('仮-ABC123', 'before'); return { ok: true, path: r }; }
    catch (e) { return { ok: false, msg: String(e && e.message || e) }; }
  });
  ck('写真アップロードはサーバ側で拒否される(403)', uploadResult.ok === false, JSON.stringify(uploadResult));
  ck('拒否時にパスを保存しない', uploadResult.ok === false && !uploadResult.path, JSON.stringify(uploadResult));
  ck('アップロードを実際に試行した(=経路が生きている)', storageAttempts >= 1, 'attempts=' + storageAttempts);

  ck('JSエラーなし', errs.length === 0, errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
