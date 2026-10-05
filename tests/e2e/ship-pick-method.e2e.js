// 出荷で「どうやってパックを選んだか」を残し、ラベルを読まずに選んだ分を要確認に出す（2026-10-05）
//
//   きっかけ
//     「出荷済の記録なのに現物がセンターに残っていた」が3回続いた
//     （a La Bouteille のヒレ T300-HI/T328-HI、石川恵理のミンチ TGC-MI-20260918-010 など）。
//     ラベルを読まず、同じ重さ・同じロットの番号を一覧やドロップダウンから選ぶと記録と現物がずれる。
//
//   ここで測ること
//     1. バーコードリーダーの速さ（1文字数ms）で入った番号は scan、人の速さ（1文字100ms超）は typed
//     2. 貼り付けは typed（機械で読んだ扱いにしない）
//     3. 個体の在庫一覧からタップで選んだら picker
//     4. 直販出荷の確定で order_items.pick_method に scan / typed / picker が保存される
//     5. 注文の出荷画面のドロップダウン割当は dropdown で保存される
//     6. 「現物確認が必要な出荷」に picker/dropdown の行が出て、✓で pick_checked_at を保存する
//     7. 一覧が読めないときは赤字で理由を出す（黙って空にしない）。0件なら何も出さない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9131);
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const out = []; const ck = (n, c, e) => out.push([n, !!c, e == null ? '' : String(e)]);
  const p = await b.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));

  const INV = {
    '10004354': { id: 'inv-scan', ident_code: 'TGC-MI-20260918-010', part_name: 'ミンチ肉（粗挽き）', weight: 1, species: 'イノシシ', individual_id: null, status: '在庫', grade: '並' },
    'TGC-08-T271-HI': { id: 'inv-typed', ident_code: 'TGC-08-T271-HI', part_name: 'ヒレ', weight: 0.35, species: 'イノシシ', individual_id: 'TGC-08-T271', status: '在庫', grade: '並' },
    'TGC-08-T328-HI': { id: 'inv-pick', ident_code: 'TGC-08-T328-HI', part_name: 'ヒレ', weight: 0.46, species: 'イノシシ', individual_id: 'TGC-08-T328', status: '在庫', grade: '並' },
  };
  const writes = { order_items: [], patches: [] };
  let pickRows = [], pickFail = false;
  await p.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = (x, st) => rt.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m === 'GET' && /\/inventory\?/.test(url)) {
      if (/or=\(individual_code/.test(url)) return J([{ ident_code: 'TGC-08-T328-HI', part_name: 'ヒレ', weight: 0.46 }]);   // 個体の在庫一覧
      const hit = Object.keys(INV).find(k => url.includes(k));
      return J(hit ? [INV[hit]] : []);
    }
    if (m === 'GET' && /\/order_items\?pick_method=in\.\(picker,dropdown\)/.test(url)) return pickFail ? J({ message: 'boom' }, 500) : J(pickRows);
    if (/\/rpc\/staff_lookup_customer_id/.test(url)) return J('cust-a');
    if (m === 'GET' && /\/customers/.test(url)) return J([{ id: 'cust-a', price_rank: 'standard' }]);
    if (m === 'GET' && /\/price_master/.test(url)) return J([{ species: 'イノシシ', part_name: 'ヒレ', grade: '並', price_standard: 3800 }]);
    if (m === 'POST' && /\/orders/.test(url)) return J([{ id: 'ord-1', ...JSON.parse(req.postData() || '{}') }], 201);
    if (m === 'POST' && /\/order_items/.test(url)) { const body = JSON.parse(req.postData() || '[]'); writes.order_items.push(...(Array.isArray(body) ? body : [body])); return J([], 201); }
    if (m === 'PATCH' && /\/order_items/.test(url)) { writes.patches.push({ url, body: JSON.parse(req.postData() || '{}') }); return J([]); }
    if (m === 'POST' && /\/shipments/.test(url)) return J([{ id: 'sh-1' }], 201);
    return J([]);
  });
  await p.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));
  await p.goto('http://localhost:9131/index.html'); await p.waitForTimeout(700);
  await p.evaluate(() => { window.__toasts = []; window.toast = (msg, type) => window.__toasts.push({ msg, type }); });

  // 入力欄に1文字ずつ input イベントを起こす（間隔 ms を指定）
  const typeInto = (id, text, gap, paste) => p.evaluate(async ({ id, text, gap, paste }) => {
    const el = document.getElementById(id); el.value = '';
    if (paste) { el.value = text; el.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', bubbles: true })); return; }
    for (const ch of text) {
      el.value += ch; el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true }));
      if (gap) await new Promise(r => setTimeout(r, gap));
    }
  }, { id, text, gap, paste });

  // 1. 機械の速さ → scan
  await typeInto('ship-direct-code', '10004354', 0);
  await p.evaluate(() => shipDirectScan()); await p.waitForTimeout(200);
  // 2. 人の速さ → typed
  await typeInto('ship-direct-code', 'TGC-08-T271-HI', 110);
  await p.evaluate(() => shipDirectScan()); await p.waitForTimeout(200);
  let vias = await p.evaluate(() => shipDirectItems.map(i => i.ident_code + ':' + i._via));
  ck('リーダーの速さで入った番号は scan', vias[0] === 'TGC-MI-20260918-010:scan', vias.join(','));
  ck('人の速さで打った番号は typed', vias[1] === 'TGC-08-T271-HI:typed', vias.join(','));

  // 3. 個体番号を入れて一覧からタップ → picker
  await typeInto('ship-direct-code', 'TGC-08-T328', 0);
  await p.evaluate(() => shipDirectScan()); await p.waitForTimeout(300);
  await p.evaluate(() => [...document.querySelectorAll('#ship-direct-pick button')].find(b => b.textContent.includes('TGC-08-T328-HI')).click()); await p.waitForTimeout(300);
  vias = await p.evaluate(() => shipDirectItems.map(i => i._via));
  ck('個体の在庫一覧からタップで選んだら picker（入力が速くても）', vias[2] === 'picker', vias.join(','));

  // 2b. 貼り付けは typed
  const pv = await p.evaluate(() => { const el = document.getElementById('ship-scan-code'); el.value = 'TGC-08-T300-HI';
    el.dispatchEvent(new InputEvent('input', { inputType: 'insertFromPaste', bubbles: true })); return scanVia('ship-scan-code'); });
  ck('貼り付けは typed（機械で読んだ扱いにしない）', pv === 'typed', pv);

  // 4. 確定で pick_method が保存される
  await p.evaluate(() => recordDirectShipment(shipDirectItems, 'A店', {}));
  const pm = writes.order_items.map(i => i.inventory_id + ':' + i.pick_method).join(',');
  ck('直販出荷の明細に pick_method（scan/typed/picker）が保存される', pm === 'inv-scan:scan,inv-typed:typed,inv-pick:picker', pm);

  // 5. ドロップダウン割当 → dropdown
  await p.evaluate(() => shipOrderConfirmed('ord-x', [{ orderItemId: 'oi-1', inventoryId: 'inv-d' }]).catch(() => {}));
  await p.waitForTimeout(300);
  const dd = writes.patches.find(x => /id=eq\.oi-1/.test(x.url));
  ck('注文出荷のドロップダウン割当は dropdown で保存', dd && dd.body.pick_method === 'dropdown' && dd.body.inventory_id === 'inv-d', JSON.stringify(dd && dd.body));

  // 6. 現物確認が必要な出荷
  pickRows = [
    { id: 'oi-p1', part_name: 'ヒレ', weight: 0.46, pick_method: 'picker', created_at: '2026-10-05T03:00:00Z', inventory: { ident_code: 'TGC-08-T328-HI' }, orders: { order_code: 'DIR-1', customer_name: '柿沼', order_date: '2026-10-05', status: '発送済' } },
    { id: 'oi-p2', part_name: 'ミンチ肉（粗挽き）', weight: 1, pick_method: 'dropdown', created_at: '2026-10-04T03:00:00Z', inventory: { ident_code: 'TGC-MI-20260918-018' }, orders: { order_code: 'ORD-2', customer_name: '石川恵理', order_date: '2026-09-23', status: '発送済' } },
    { id: 'oi-p3', part_name: 'ヒレ', weight: 0.3, pick_method: 'picker', created_at: '2026-10-03T03:00:00Z', inventory: { ident_code: 'X' }, orders: { order_code: 'C-3', customer_name: 'キャンセル客', order_date: '2026-10-03', status: 'キャンセル' } },
  ];
  await p.evaluate(() => shipPickCheckLoad()); await p.waitForTimeout(300);
  const txt = await p.$eval('#ship-pick-check', el => el.innerText);
  ck('要確認に picker/dropdown の行が出る（キャンセル注文は除く）', /現物確認が必要な出荷 2件/.test(txt) && /TGC-08-T328-HI/.test(txt) && /一覧から選択/.test(txt) && /ドロップダウンで選択/.test(txt) && !/キャンセル客/.test(txt), txt.slice(0, 200));
  pickRows = pickRows.slice(1);
  await p.evaluate(() => document.querySelector('#ship-pick-check .pick-row button').click()); await p.waitForTimeout(400);
  const okp = writes.patches.find(x => /id=eq\.oi-p1/.test(x.url));
  ck('✓で pick_checked_at を保存して一覧から消える', okp && okp.body.pick_checked_at && /1件/.test(await p.$eval('#ship-pick-check', el => el.innerText)), JSON.stringify(okp && okp.body));

  // 7. 読めない／0件
  pickFail = true; await p.evaluate(() => shipPickCheckLoad()); await p.waitForTimeout(300);
  ck('一覧が読めないときは赤字で理由を出す', /読めませんでした/.test(await p.$eval('#ship-pick-check', el => el.innerText)), '');
  pickFail = false; pickRows = []; await p.evaluate(() => shipPickCheckLoad()); await p.waitForTimeout(300);
  ck('0件なら何も出さない', (await p.$eval('#ship-pick-check', el => el.innerHTML)) === '', '');
  ck('pageerror なし', errs.length === 0, errs.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of out) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${out.length} passed`);
  await b.close(); srv.close();
  process.exit(pass === out.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
