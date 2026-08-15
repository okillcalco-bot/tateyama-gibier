// 精肉モード: 誤登録の取消（✕/直前取消）と二重登録の警告
// - pmDeleteCompleted: 在庫を deleted_at でソフト削除し一覧から除去
// - pmUndoLast: 直前登録をワンタップ取消
// - pmRenderCompleted: 同一重量に ⚠同重量 を表示
// - pmFinishIndividual: 同一重量があると確認ダイアログに二重登録警告を出す
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9075);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));

  const rest = { patches: [], deletes: [] };
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  await p.route('**/rest/v1/**', async route => {
    const req = route.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    // 個体書込はRPC経由（P0-2）。精肉完了は staff_individual_update_by_label で来る
    if (url.includes('/rpc/staff_key_ok')) return j(true);
    if (url.includes('/rpc/staff_token_ok')) return j(false);           // 端末未登録→登録へ
    if (url.includes('/rpc/staff_device_register')) return j({ token: 'tok-1', expires_at: '2026-09-14' });
    if (url.includes('/rpc/staff_individual_update_by_label')) {
      const a = req.postDataJSON() || {};
      rest.patches.push({ url: '/individuals(rpc)', body: a.p_patch, label: a.p_label });
      return j({ id: 'x', label_id: a.p_label });
    }
    if (url.includes('/inventory') && m === 'PATCH') { rest.patches.push({ url, body: req.postDataJSON() }); return j([{}]); }
    if (url.includes('/processing_log') && m === 'DELETE') { rest.deletes.push(url); return route.fulfill({ status: 204, body: '' }); }
    if (url.includes('/individuals') && m === 'PATCH') { rest.patches.push({ url, body: req.postDataJSON() }); return j([{}]); }
    return j([]);
  });
  await p.goto('http://localhost:9075/index.html'); await p.waitForTimeout(500);
  await p.evaluate(() => { try { localStorage.setItem('tg_staff_key', 'test-key'); } catch (e) {} });

  // 精肉メイン画面の前提globalを用意（pmRenderParts等が参照）
  const setup = async (parts) => p.evaluate((parts) => {
    pmIndividual = { label_id: 'TGC-08-T100', species: 'イノシシ', weight_total: 30 };
    pmRetail = false; pmSelectedPart = null; pmLastAction = null;
    pmCompletedParts = parts.map(x => ({ part_name: x.pn, weight_kg: x.w, lot_code: x.lot, ident_code: x.ic, grade: '並', bone_in: false }));
    document.getElementById('pmMain').style.display = 'flex';
    pmRenderCompleted();
  }, parts);

  // 1) ✕削除：在庫をソフト削除し一覧から消える
  rest.patches = []; rest.deletes = [];
  await setup([{ pn: 'モモ', w: 1.2, lot: 'L1', ic: 'TGC-08-T100-01' }]);
  await p.evaluate(async () => { window.confirm = () => true; await pmDeleteCompleted(0); });
  await p.waitForTimeout(150);
  const delPatch = rest.patches.find(x => x.url.includes('/inventory') && x.body && x.body.deleted_at);
  ck('✕削除 → inventoryをdeleted_atでソフト削除', !!delPatch && delPatch.url.includes('ident_code=eq.TGC-08-T100-01'), delPatch ? delPatch.url : 'なし');
  ck('✕削除 → processing_logもDELETE', rest.deletes.some(u => u.includes('child_ident_code=eq.TGC-08-T100-01')));
  ck('✕削除 → 一覧から除去（0件）', (await p.evaluate(() => pmCompletedParts.length)) === 0);

  // 2) 同一重量 → ⚠同重量 表示
  await setup([
    { pn: 'モモ', w: 1.2, lot: 'L1', ic: 'TGC-08-T100-01' },
    { pn: 'ロース', w: 1.2, lot: 'L2', ic: 'TGC-08-T100-02' },
    { pn: 'バラ', w: 0.8, lot: 'L3', ic: 'TGC-08-T100-03' },
  ]);
  const html = await p.evaluate(() => document.getElementById('pmCompletedGrid').innerHTML);
  ck('同一重量(1.2×2)に ⚠同重量 を表示', (html.match(/⚠同重量/g) || []).length === 2, String((html.match(/⚠同重量/g) || []).length));
  ck('異なる重量(0.8)には印を付けない', (html.match(/⚠同重量/g) || []).length === 2);
  ck('各行に✕削除ボタン', (html.match(/pmDeleteCompleted\(/g) || []).length === 3);

  // 3) 全部位完了：同一重量ありで確認に二重登録警告
  let msg = '';
  await p.evaluate(() => { window._m = ''; window.confirm = (t) => { window._m = t; return false; }; });
  await p.evaluate(async () => { await pmFinishIndividual(); });
  msg = await p.evaluate(() => window._m);
  ck('全部位完了の確認に二重登録警告', msg.includes('二重登録の可能性') && msg.includes('1.200kg × 2件'), msg.slice(0, 40));

  // 4) 二重登録なしなら警告なし＆完了PATCH
  rest.patches = [];
  await setup([{ pn: 'モモ', w: 1.2, lot: 'L1', ic: 'TGC-08-T100-01' }, { pn: 'バラ', w: 0.8, lot: 'L2', ic: 'TGC-08-T100-02' }]);
  await p.evaluate(() => { window._m = ''; window.confirm = (t) => { window._m = t; return true; }; });
  await p.evaluate(async () => { window.closeProcessingMode = () => {}; await pmFinishIndividual(); });
  await p.waitForTimeout(150);
  msg = await p.evaluate(() => window._m);
  ck('二重登録なし → 警告文なし', !msg.includes('二重登録の可能性'), msg.slice(0, 30));
  ck('二重登録なし → 精肉完了をRPC(staff_individual_update_by_label)で保存', rest.patches.some(x => x.url.includes('individuals') && x.body && x.body.processing_done_at), JSON.stringify(rest.patches.map(x => x.url)));

  // 5) 直前取消（pmUndoLast）：直前identを削除
  rest.patches = [];
  await setup([{ pn: 'モモ', w: 1.2, lot: 'L1', ic: 'TGC-08-T100-01' }, { pn: 'ロース', w: 0.9, lot: 'L2', ic: 'TGC-08-T100-02' }]);
  await p.evaluate(async () => {
    window.confirm = () => true;
    pmShowLastAction({ part: 'ロース', weight: 0.9, ident: 'TGC-08-T100-02', printed: true });
    await pmUndoLast();
  });
  await p.waitForTimeout(150);
  const undoPatch = rest.patches.find(x => x.url.includes('/inventory') && x.body && x.body.deleted_at);
  ck('直前取消 → 直前identをソフト削除', !!undoPatch && undoPatch.url.includes('ident_code=eq.TGC-08-T100-02'), undoPatch ? undoPatch.url : 'なし');
  const remain = await p.evaluate(() => pmCompletedParts.map(c => c.ident_code));
  ck('直前取消 → 直前のみ削除・残りは保持', remain.length === 1 && remain[0] === 'TGC-08-T100-01', JSON.stringify(remain));

  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
