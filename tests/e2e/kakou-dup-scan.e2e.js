// 加工処理: 同じ原料を2回入れない（2026-11-05 沖「被ってるのに登録される」）
//
//   きっかけ
//     ミンチの原料をスキャンしていたら、同じパック（〇〇-MU 2.33kg・〇〇-MU 1.71kg）が2行ずつ入り、
//     「原料 9点 / 合計 17.72kg」と水増しされた。10/27 のミンチでも同じ1パックが3回つながっていた。
//     原因: 二度読みの判定が「読んだ文字＝識別コード」の比較だった。ラベルのバーコードは数字キー
//     （scan_code・8桁）なので、同じパックを読んでも文字が違い、判定をすり抜けていた。
//     出荷処理・出店シートは在庫の id で見ていて、加工処理だけが文字で見ていた。
//
//   ここで測ること（在庫はすべて架空）
//     1. バーコード（数字）で2回読んでも1行だけ（2回目はエラーのトースト）
//     2. 数字で読んだ後に識別コードを打っても（逆も）1行だけ
//     3. 「在庫から選ぶ」でも、入っている原料は一覧に出ず、追加もできない
//     4. 別のパックは普通に入る・原料の点数と合計kgが正しい
//     5. 万一2行あっても記録しない（在庫・ログに書き込まない）でエラーを出す
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9078);
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

  const A = { id: 'inv-a', ident_code: 'TGC-08-T901-MU', scan_code: '10009001', part_name: 'ミンチ用', weight: 2.33, weight_kg: 2.33, species: 'イノシシ', individual_id: 'TGC-08-T901', status: '在庫', tier: 2 };
  const B = { id: 'inv-b', ident_code: 'TGC-08-T902-MU', scan_code: '10009002', part_name: 'ミンチ用', weight: 1.71, weight_kg: 1.71, species: 'イノシシ', individual_id: 'TGC-08-T902', status: '在庫', tier: 2 };
  const C = { id: 'inv-c', ident_code: 'TGC-08-M903-MU-2', scan_code: '10009003', part_name: 'ミンチ用', weight: 2.19, weight_kg: 2.19, species: 'イノシシ', individual_id: 'TGC-08-M903', status: '在庫', tier: 2 };
  const ALL = [A, B, C];
  const writes = [];
  const p = await (await b.newContext()).newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  await p.route('**/rest/v1/**', route => {
    const req = route.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    if (m !== 'GET') {
      const tbl = url.split('/rest/v1/')[1].split('?')[0];
      if (/^(inventory|processing_log|products|product_movements)$/.test(tbl)) writes.push(m + ' ' + tbl);   // 画面の裏で動く読み出し用RPCは数えない
      return j([{}]);
    }
    if (url.includes('/inventory')) {
      const sc = (url.match(/scan_code=eq\.(\d+)/) || [])[1];
      if (sc) return j(ALL.filter(x => x.scan_code === sc));
      const ic = (url.match(/ident_code=eq\.([^&]+)/) || [])[1];
      if (ic) return j(ALL.filter(x => x.ident_code === ic));
      if (url.includes('status=eq.在庫')) return j(ALL);   // 在庫から選ぶ
      return j([]);
    }
    return j([]);
  });
  await p.goto('http://localhost:9078/index.html'); await p.waitForTimeout(500);
  await p.evaluate(async () => {
    window.__toasts = []; const orig = window.toast; window.toast = (msg, kind) => { window.__toasts.push([msg, kind]); try { orig(msg, kind); } catch (e) {} };
    window.confirm = () => true; window.print = () => {}; window.open = () => null;
    await loadKakou(); kkMaterials = []; kkRenderMaterials();
  });
  const scan = code => p.evaluate(async c => { window.__toasts = []; document.getElementById('kk-scan').value = c; await kkScanAdd(); return { n: kkMaterials.length, ids: kkMaterials.map(m => m.id), toasts: window.__toasts }; }, code);

  // 1. 数字のバーコードで2回
  const s1 = await scan('10009001');
  T('1回目（数字のバーコード）は原料に入る', s1.n === 1, JSON.stringify(s1));
  const s2 = await scan('10009001');
  T('1. 同じパックを数字のバーコードで2回読んでも1行だけ', s2.n === 1, JSON.stringify(s2.ids));
  T('1. 2回目はエラーのトースト（識別コードつき）', s2.toasts.some(([m, k]) => k === 'error' && /すでに原料に入っています: TGC-08-T901-MU/.test(m)), JSON.stringify(s2.toasts));
  // 2. 数字 → 識別コード
  const s3 = await scan('TGC-08-T901-MU');
  T('2. 数字で読んだ後に識別コードを打っても1行だけ', s3.n === 1 && s3.toasts.some(([, k]) => k === 'error'), JSON.stringify(s3));
  // 識別コード → 数字
  const s4 = await scan('TGC-08-T902-MU');
  const s5 = await scan('10009002');
  T('2. 識別コードで入れた後に数字で読んでも1行だけ（2点のまま）', s4.n === 2 && s5.n === 2 && s5.toasts.some(([, k]) => k === 'error'), JSON.stringify([s4.ids, s5.ids]));

  // 3. 在庫から選ぶ
  const pick = await p.evaluate(async () => {
    await kkPickFromStock();
    const listed = [...document.querySelectorAll('#kk-stock-list button')].map(btn => (btn.getAttribute('onclick') || '').match(/'([^']+)'/)[1]);
    window.__toasts = [];
    kkAddFromStock('inv-a');
    const afterDup = kkMaterials.length;
    const dupToast = window.__toasts.slice();
    kkAddFromStock('inv-c');
    document.getElementById('kkStockModal').style.display = 'none';
    return { listed, afterDup, dupToast, after: kkMaterials.length, total: document.getElementById('kk-materials-total').textContent };
  });
  T('3. 「在庫から選ぶ」の一覧に、入っている原料は出ない（Cだけ）', pick.listed.join(',') === 'inv-c', JSON.stringify(pick.listed));
  T('3. 入っている原料を「在庫から選ぶ」で足そうとしても増えない・知らせる', pick.afterDup === 2 && pick.dupToast.some(([m, k]) => k === 'error' && /すでに原料に入っています/.test(m)), JSON.stringify(pick));
  // 4. 別のパックは入る・合計
  T('4. 別のパックは入る（3点）', pick.after === 3, String(pick.after));
  T('4. 原料の点数と合計kgが正しい（3点 / 6.23kg）', pick.total === '原料 3点 / 合計 6.23kg', pick.total);

  // 5. 万一2行あっても記録しない
  const sub = await p.evaluate(async (A) => {
    kkMaterials.push(Object.assign({}, A));   // 何らかの経路で同じ行が入った状態
    window.__toasts = [];
    document.getElementById('kk-operator').innerHTML = '<option value="白石">白石</option>';
    document.getElementById('kk-operator').value = '白石';
    document.getElementById('kk-type').value = 'ミンチ'; kkTypeChange();
    document.getElementById('kk-pack-w').value = '1';
    document.getElementById('kk-pack-n').value = '5';
    await kkSubmit();
    return { toasts: window.__toasts, n: kkMaterials.length };
  }, A);
  T('5. 同じ原料が2行あると記録しない（在庫・ログへの書き込みなし）', writes.length === 0, writes.join(' / '));
  T('5. エラーで「同じ原料が2回入っています」と識別コードを出す', sub.toasts.some(([m, k]) => k === 'error' && /同じ原料が2回入っています: TGC-08-T901-MU/.test(m)), JSON.stringify(sub.toasts));
  T('5. 原料の一覧はそのまま（勝手に消さない）', sub.n === 4, String(sub.n));

  T('ページエラーなし', errors.length === 0, errors.join(' / '));
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + got.slice(0, 250) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await b.close(); srv.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
