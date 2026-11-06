// 精肉の取消で「個体→パックの線」を消さない（改善指示書03・2026-11-06）
//
//   きっかけ
//     同じパック（肩ロース 1.140kg）が1分で5回登録され、4件を取り消したとき、実物に貼ってあるラベルの
//     番号まで取り消していた。出荷で読むと「記録無し」。さらに取消は加工記録（processing_log）を物理削除
//     していたので、削除履歴から在庫を戻しても個体とつながらないパックになった。
//
//   ここで測ること（在庫・個体はすべて架空）
//     1. 取消は在庫に「消えた印」を付けるだけ。加工記録へ DELETE を送らない
//     2. 取消の前に「捨てるラベル」の8桁を読ませる。別のパックのラベルなら取り消さず、どの行のラベルかを出す
//     3. ラベル未印刷（空でOK）は、番号を示した確認を経たときだけ取り消す
//     4. 出荷済・加工済のパックは取り消さない／在庫の状態を読めないときも取り消さない
//     5. 確かめた後に状態が変わっていた（PATCHが0件）ら、取り消したことにしない（一覧に残す）
//     6. 削除履歴から戻すと、加工記録が無いパックだけ元の登録時刻で記録を書き足す（加工品・記録ありは書かない）
//     7. 一覧（ダッシュボードの最近の精肉・加工工程記録）で、取り消したパックの記録に「取消」と出る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9093);
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

  // 架空の在庫（同じ個体・同じ重さのパックが3つ）
  const INV = {
    'TGC-08-T901-KR':   { id: 'i1', ident_code: 'TGC-08-T901-KR',   scan_code: '10009101', status: '在庫' },
    'TGC-08-T901-KR-2': { id: 'i2', ident_code: 'TGC-08-T901-KR-2', scan_code: '10009102', status: '在庫' },
    'TGC-08-T901-KR-3': { id: 'i3', ident_code: 'TGC-08-T901-KR-3', scan_code: '10009103', status: '出荷済' },
  };
  const net = { writes: [], invGetFail: false, patchEmpty: false };
  const TRASH = {
    t1: { id: 't1', ident_code: 'TGC-08-T902-RO', individual_id: 'TGC-08-T902', weight_kg: 1.2, weight: 1.2, processed_by: '架空太郎', processed_at: '2026-11-01T01:00:00+00:00', created_at: '2026-11-01T01:00:00+00:00', scan_code: '10009201', deleted_at: '2026-11-01T02:00:00+00:00' },
    t2: { id: 't2', ident_code: 'TGC-08-T903-HI', individual_id: 'TGC-08-T903', weight_kg: 0.5, weight: 0.5, operator: '架空花子', created_at: '2026-11-02T01:00:00+00:00', deleted_at: '2026-11-02T02:00:00+00:00' },
    t3: { id: 't3', ident_code: 'TGC-MIB-20261101-001-P1', individual_id: null, weight_kg: 1, created_at: '2026-11-03T01:00:00+00:00', deleted_at: '2026-11-03T02:00:00+00:00' },
  };
  const LOGS_EXIST = new Set(['TGC-08-T903-HI']);

  const p = await (await b.newContext()).newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  await p.route('**/rest/v1/**', route => {
    const req = route.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const tbl = url.split('/rest/v1/')[1].split('?')[0];
    const j = (x, status) => route.fulfill({ status: status || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m !== 'GET') {
      if (/^(inventory|processing_log)$/.test(tbl)) net.writes.push({ m, tbl, url, body: req.postDataJSON ? (() => { try { return req.postDataJSON(); } catch (e) { return null; } })() : null });
      if (m === 'PATCH' && tbl === 'inventory' && net.patchEmpty) return j([]);
      return j([{}]);
    }
    if (tbl === 'inventory') {
      if (net.invGetFail && url.includes('ident_code=eq.')) return j({ message: 'boom' }, 500);
      const ic = (url.match(/ident_code=eq\.([^&]+)/) || [])[1];
      if (ic) return j(INV[ic] ? [INV[ic]] : []);
      const id = (url.match(/[?&]id=eq\.([^&]+)/) || [])[1];
      if (id) return j(TRASH[id] ? [TRASH[id]] : []);
      const inl = (url.match(/ident_code=in\.\(([^)]*)\)/) || [])[1];
      if (inl) {   // 取消済みの判定用
        const codes = inl.split(',').map(s => s.replace(/"/g, ''));
        return j(codes.filter(c => c === 'TGC-08-T950-SP').map(c => ({ ident_code: c, deleted_at: '2026-11-05T03:04:00+00:00' }))
          .concat(codes.filter(c => c === 'TGC-08-T951-SP').map(c => ({ ident_code: c, deleted_at: null }))));
      }
      if (url.includes('deleted_at=not.is.null')) return j(Object.values(TRASH));
      return j([]);
    }
    if (tbl === 'processing_log') {
      const cc = (url.match(/child_ident_code=eq\.([^&]+)/) || [])[1];
      if (cc) return j(LOGS_EXIST.has(cc) ? [{ id: 'l1' }] : []);
      if (url.includes('order=created_at.desc&limit=10')) return j([
        { created_at: '2026-11-05T03:00:00+00:00', parent_ident_code: 'TGC-08-T950', child_ident_code: 'TGC-08-T950-SP', weight: 1.1, operator: '架空太郎' },
        { created_at: '2026-11-05T03:01:00+00:00', parent_ident_code: 'TGC-08-T951', child_ident_code: 'TGC-08-T951-SP', weight: 0.9, operator: '架空太郎' },
      ]);
      if (url.includes('created_at=gte.')) return j([
        { created_at: '2026-11-05T03:00:00+00:00', parent_ident_code: 'TGC-08-T950', child_ident_code: 'TGC-08-T950-SP', weight: 1.1, operator: '架空太郎' },
        { created_at: '2026-11-05T03:01:00+00:00', parent_ident_code: 'TGC-08-T951', child_ident_code: 'TGC-08-T951-SP', weight: 0.9, operator: '架空太郎' },
      ]);
      return j([]);
    }
    return j([]);
  });
  await p.goto('http://localhost:9093/index.html'); await p.waitForTimeout(500);
  await p.evaluate(() => {
    window.__alerts = []; window.alert = (m) => window.__alerts.push(String(m));
    window.__prompts = []; window.__promptAns = null; window.prompt = (m) => { window.__prompts.push(String(m)); return window.__promptAns; };
    window.__confirms = []; window.__confirmAns = true; window.confirm = (m) => { window.__confirms.push(String(m)); return window.__confirmAns; };
    window.print = () => {}; window.open = () => null;
    try { sessionStorage.setItem('tg_role_v1', 'admin'); } catch (e) {}
  });
  const setup = () => p.evaluate(() => {
    pmIndividual = { label_id: 'TGC-08-T901', species: 'イノシシ', weight_total: 30 };
    pmRetail = false; pmSelectedPart = null; pmLastAction = null;
    pmCompletedParts = [
      { part_name: '肩ロース', weight_kg: 1.14, lot_code: 'L1', ident_code: 'TGC-08-T901-KR', scan_code: '10009101', grade: '並', bone_in: false },
      { part_name: '肩ロース', weight_kg: 1.14, lot_code: 'L2', ident_code: 'TGC-08-T901-KR-2', scan_code: '10009102', grade: '並', bone_in: false },
      { part_name: '肩ロース', weight_kg: 1.14, lot_code: 'L3', ident_code: 'TGC-08-T901-KR-3', scan_code: '10009103', grade: '並', bone_in: false },
    ];
    document.getElementById('pmMain').style.display = 'flex';
    pmRenderCompleted();
    window.__alerts = []; window.__prompts = []; window.__confirms = [];
  });
  const del = (idx, ans, conf = true) => p.evaluate(async ([idx, ans, conf]) => {
    window.__promptAns = ans; window.__confirmAns = conf;
    await pmDeleteCompleted(idx);
    return { left: pmCompletedParts.map(c => c.ident_code), alerts: window.__alerts.slice(), prompts: window.__prompts.slice(), confirms: window.__confirms.slice() };
  }, [idx, ans, conf]);
  const patches = () => net.writes.filter(w => w.m === 'PATCH' && w.tbl === 'inventory' && w.body && w.body.deleted_at);
  const deletesLog = () => net.writes.filter(w => w.m === 'DELETE' && w.tbl === 'processing_log');

  // 1+2. 正しいラベルを読むと取り消す（加工記録は消さない）
  await setup(); net.writes = [];
  const r1 = await del(1, '10009102');
  T('1. 捨てるラベルの8桁を読ませる（プロンプトに「捨てるラベル」）', r1.prompts.length === 1 && /捨てるラベル/.test(r1.prompts[0]), r1.prompts[0]);
  T('1. 正しいラベルなら在庫に消えた印（status=在庫のときだけ）', patches().length === 1 && /ident_code=eq\.TGC-08-T901-KR-2/.test(patches()[0].url) && /status=eq\.在庫/.test(patches()[0].url), patches().map(x => x.url).join(' | '));
  T('1. 加工記録（processing_log）へ DELETE を送らない', deletesLog().length === 0, deletesLog().map(x => x.url).join(' | '));
  T('1. 一覧から外れる（2件）', r1.left.join(',') === 'TGC-08-T901-KR,TGC-08-T901-KR-3', r1.left.join(','));

  // 2. 別のパックのラベル → 取り消さない・どの行かを出す
  await setup(); net.writes = [];
  const r2 = await del(1, '10009101');
  T('2. 別のパックのラベルなら取り消さない（書き込みなし）', net.writes.length === 0 && r2.left.length === 3, JSON.stringify(net.writes));
  T('2. 読んだラベルがどの行のものかを知らせる', r2.alerts.some(a => /取り消していません/.test(a) && /TGC-08-T901-KR）/.test(a)), r2.alerts.join(' / '));
  // 識別コードを打っても照合できる
  await setup(); net.writes = [];
  await del(0, 'TGC-08-T901-KR');
  T('2. ラベルの識別コードを打っても照合できる', patches().length === 1 && /ident_code=eq\.TGC-08-T901-KR&/.test(patches()[0].url), patches().map(x => x.url).join(' | '));

  // 3. ラベル未印刷（空でOK）
  await setup(); net.writes = [];
  const r3a = await del(0, '', false);
  T('3. 空でOK→番号つきの確認で「キャンセル」なら取り消さない', net.writes.length === 0 && r3a.confirms.some(c => /10009101/.test(c) && /貼られていない/.test(c)), r3a.confirms.join(' / '));
  await setup(); net.writes = [];
  await del(0, '', true);
  T('3. 空でOK→確認でOKなら取り消す', patches().length === 1, String(patches().length));
  // プロンプトのキャンセル
  await setup(); net.writes = [];
  await del(0, null);
  T('3. ラベル読み取りをキャンセルしたら何もしない', net.writes.length === 0, JSON.stringify(net.writes));

  // 4. 出荷済は取り消さない／状態を読めないときも
  await setup(); net.writes = [];
  const r4 = await del(2, '10009103');
  T('4. 出荷済のパックは取り消さない（書き込みなし・ラベルも聞かない）', net.writes.length === 0 && r4.prompts.length === 0 && r4.alerts.some(a => /出荷済/.test(a) && /取り消せません/.test(a)), r4.alerts.join(' / '));
  await setup(); net.writes = []; net.invGetFail = true;
  const r4b = await del(0, '10009101');
  net.invGetFail = false;
  T('4. 在庫の状態を読めないときは取り消さない', net.writes.length === 0 && r4b.alerts.some(a => /確かめられなかった/.test(a)) && r4b.left.length === 3, r4b.alerts.join(' / '));

  // 5. PATCH が0件（確かめた後に状態が変わった）
  await setup(); net.writes = []; net.patchEmpty = true;
  const r5 = await del(0, '10009101');
  net.patchEmpty = false;
  T('5. PATCHが0件なら取り消したことにしない（一覧に残す・知らせる）', r5.left.length === 3 && r5.alerts.some(a => /取り消していません/.test(a)), JSON.stringify(r5));

  // 6. 削除履歴から戻す
  net.writes = [];
  const r6 = await p.evaluate(async () => { window.__toasts = []; const o = window.toast; window.toast = (m, k) => { window.__toasts.push(m); }; await invRestore('t1'); await invRestore('t2'); await invRestore('t3'); window.toast = o; return window.__toasts; });
  const logPosts = net.writes.filter(w => w.m === 'POST' && w.tbl === 'processing_log');
  const restores = net.writes.filter(w => w.m === 'PATCH' && w.tbl === 'inventory' && w.body && w.body.deleted_at === null);
  T('6. 3件とも在庫を戻す', restores.length === 3, String(restores.length));
  T('6. 加工記録が無い精肉パックだけ記録を書き足す（1件）', logPosts.length === 1, JSON.stringify(logPosts.map(x => x.body)));
  const lp = logPosts[0] && logPosts[0].body || {};
  T('6. 書き足す記録は 個体→パック・重さ・担当・元の登録時刻', lp.parent_ident_code === 'TGC-08-T902' && lp.individual_id === 'TGC-08-T902' && lp.child_ident_code === 'TGC-08-T902-RO' && lp.weight === 1.2 && lp.operator === '架空太郎' && lp.created_at === '2026-11-01T01:00:00+00:00', JSON.stringify(lp));
  T('6. 戻したことを知らせる（つながりも戻した）', r6.some(m => /個体とのつながりも戻しました/.test(m)), r6.join(' / '));
  const trashHtml = await p.evaluate(async () => { await invShowTrash(); return document.getElementById('inv-trash-body').innerHTML; });
  T('6. 削除履歴にラベルの8桁も出す（実物と見比べられる）', /ラベル 10009201/.test(trashHtml), trashHtml.slice(0, 200));

  // 7. 一覧で「取消」と出る
  const dash = await p.evaluate(async () => { await loadDashboard(); return document.getElementById('dash-proc-body') ? document.getElementById('dash-proc-body').innerHTML : (document.querySelector('#dashboard tbody') || {}).innerHTML; });
  const rowsHtml = await p.evaluate(() => [...document.querySelectorAll('tr')].map(t => t.innerHTML).filter(h => /TGC-08-T95[01]-SP/.test(h)));
  T('7. ダッシュボードの最近の精肉: 取り消したパックに（取消）', rowsHtml.some(h => /TGC-08-T950-SP/.test(h) && /（取消）/.test(h)), rowsHtml.join(' || ').slice(0, 300));
  T('7. ダッシュボード: 生きているパックには付けない', rowsHtml.some(h => /TGC-08-T951-SP/.test(h) && !/（取消）/.test(h)), '');
  const doc = await p.evaluate(async () => { const d = DOC_DEFS.find(x => x.key === 'process_record'); return await d.gen('2026-11'); });
  const r950 = (doc.rows || []).find(r => /TGC-08-T950-SP/.test(r[2])); const r951 = (doc.rows || []).find(r => /TGC-08-T951-SP/.test(r[2]));
  T('7. 加工工程記録: 取り消したパックは消さずに「取消」と書き分ける', r950 && /取消/.test(r950[1]), JSON.stringify(r950));
  T('7. 加工工程記録: 生きているパックは「精肉（分割）」のまま', r951 && r951[1] === '精肉（分割）', JSON.stringify(r951));

  T('ページエラーなし', errors.length === 0, errors.join(' / '));
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + got.slice(0, 250) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await b.close(); srv.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
