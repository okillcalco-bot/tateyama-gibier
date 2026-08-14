// 加工処理→店頭在庫(袋SKU)自動反映のE2E
// - 完成品(種・厚さ/ミンチ・1パック重量)から正しい小売SKUを自動選択する
// - kkSubmit時に product_movements(完成) と products.stock_qty += 個数 が飛ぶ
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9074);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));

  // 小売SKU候補（loadKakouが読む products?category=eq.小売）
  const SKU = [
    { id: 'sku-sl5', name: 'シカスライス肉5mm 300g', unit: '袋', stock_qty: 6 },
    { id: 'sku-sl2', name: 'シカスライス肉2mm 300g', unit: '袋', stock_qty: 2 },
    { id: 'sku-mi', name: 'シカミンチ肉 250g', unit: '袋', stock_qty: 5 },
    { id: 'sku-boar', name: 'イノシシスライス肉5mm 300g', unit: '袋', stock_qty: 3 },
  ];
  // 原料ブロック（kkScanAddが在庫から引く）
  const INV = { id: 'inv-1', ident_code: 'TGC-SKB-1', part_name: 'モモ', weight: 2.0, weight_kg: 2.0, species: 'シカ', individual_id: 'TGC-08-T100', status: '在庫', tier: 2 };

  const posted = { movements: [], patches: [] };
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  await p.route('**/rest/v1/**', async route => {
    const req = route.request();
    const url = decodeURIComponent(req.url());
    const method = req.method();
    const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    if (url.includes('/products') && method === 'GET') return j(SKU);
    if (url.includes('/products') && method === 'PATCH') { posted.patches.push({ url, body: req.postDataJSON() }); return j([{}]); }
    if (url.includes('/product_movements') && method === 'POST') { posted.movements.push(req.postDataJSON()); return j([{}]); }
    if (url.includes('/inventory') && method === 'GET') {
      if (url.includes('ident_code=eq.')) return j([INV]);
      return j([]);
    }
    if (url.includes('/inventory') && method === 'POST') return j([{}]);
    if (url.includes('/inventory') && method === 'PATCH') return j([{}]);
    if (url.includes('/processing_log')) return j([{}]);
    if (url.includes('/freezers')) return j([]);
    // kkNextCodeBase等の採番参照
    return j([]);
  });
  await p.goto('http://localhost:9074/index.html'); await p.waitForTimeout(500);

  // 加工タブを開く（loadKakou→kkSkuProducts読込）
  await p.evaluate(async () => { await loadKakou(); });
  await p.waitForTimeout(200);

  // ヘルパ: 原料追加＋フォーム設定＋サマリ更新→#kk-skuの選択値を返す
  const matchFor = (type, thickMm, packWkg) => p.evaluate(async ({ type, thickMm, packWkg }) => {
    kkMaterials = [];
    document.getElementById('kk-scan').value = 'TGC-SKB-1';
    await kkScanAdd();
    document.getElementById('kk-type').value = type; kkTypeChange();
    if (type === 'スライス') { document.getElementById('kk-thick').value = String(thickMm); }
    document.getElementById('kk-pack-w').value = String(packWkg);
    document.getElementById('kk-pack-n').value = '10';
    kkUpdateSummary();
    return document.getElementById('kk-sku').value;
  }, { type, thickMm, packWkg });

  ck('シカ・5mm・0.3kg → シカスライス5mm 300g', await matchFor('スライス', 5, 0.3) === 'sku-sl5');
  ck('シカ・2mm・0.3kg → シカスライス2mm 300g', await matchFor('スライス', 2, 0.3) === 'sku-sl2');
  ck('シカ・ミンチ・0.25kg → シカミンチ 250g', await matchFor('ミンチ', null, 0.25) === 'sku-mi');
  ck('シカ・5mm・0.5kg（該当重量なし）→ 未選択', await matchFor('スライス', 5, 0.5) === '');
  ck('シカ・3mm・0.3kg（該当厚さなし）→ 未選択', await matchFor('スライス', 3, 0.3) === '');

  // 手動選択は自動マッチで上書きしない
  const manualKept = await p.evaluate(async () => {
    kkMaterials = [];
    document.getElementById('kk-scan').value = 'TGC-SKB-1'; await kkScanAdd();
    document.getElementById('kk-type').value = 'スライス'; kkTypeChange();
    document.getElementById('kk-thick').value = '5';
    document.getElementById('kk-pack-w').value = '0.3';
    document.getElementById('kk-pack-n').value = '10';
    kkUpdateSummary();                                   // 自動で sku-sl5
    document.getElementById('kk-sku').value = 'sku-sl2'; // 手動で別SKUへ
    kkSkuAuto = 'sku-sl5';
    kkUpdateSummary();                                   // 再計算しても手動選択を尊重
    return document.getElementById('kk-sku').value;
  });
  ck('手動選択(sku-sl2)は自動マッチで上書きされない', manualKept === 'sku-sl2', manualKept);

  // kkSubmit: 完成movement + stock_qty加算が飛ぶ
  posted.movements = []; posted.patches = [];
  await p.evaluate(async () => {
    window.confirm = () => true;
    document.getElementById('kk-sku').value = ''; kkSkuAuto = null;  // 前サブテストの手動選択をクリア
    kkMaterials = [];
    document.getElementById('kk-scan').value = 'TGC-SKB-1'; await kkScanAdd();
    document.getElementById('kk-operator').innerHTML = '<option value="白石">白石</option>';
    document.getElementById('kk-operator').value = '白石';
    document.getElementById('kk-type').value = 'スライス'; kkTypeChange();
    document.getElementById('kk-thick').value = '5';
    document.getElementById('kk-pack-w').value = '0.3';
    document.getElementById('kk-pack-n').value = '10';
    kkUpdateSummary();
    await kkSubmit();
  });
  await p.waitForTimeout(300);
  const mv = posted.movements.find(m => m && m.movement_type === '完成');
  ck('kkSubmit→ product_movements(完成) をPOST', !!mv, JSON.stringify(posted.movements));
  ck('  完成movementのqty=10・product_id=sku-sl5', !!mv && mv.qty === 10 && mv.product_id === 'sku-sl5', mv ? `${mv.qty}/${mv.product_id}` : 'なし');
  const patch = posted.patches.find(x => x.body && typeof x.body.stock_qty === 'number');
  ck('  products.stock_qty=16（6+10）にPATCH', !!patch && patch.body.stock_qty === 16, patch ? String(patch.body.stock_qty) : 'なし');
  ck('  PATCH先が sku-sl5', !!patch && patch.url.includes('id=eq.sku-sl5'), patch ? patch.url : 'なし');

  // SKU未選択なら在庫反映しない
  posted.movements = []; posted.patches = [];
  await p.evaluate(async () => {
    window.confirm = () => true;
    kkMaterials = [];
    document.getElementById('kk-scan').value = 'TGC-SKB-1'; await kkScanAdd();
    document.getElementById('kk-operator').value = '白石';
    document.getElementById('kk-type').value = 'スライス'; kkTypeChange();
    document.getElementById('kk-thick').value = '5';
    document.getElementById('kk-pack-w').value = '0.4';   // 該当SKUなし→未選択
    document.getElementById('kk-pack-n').value = '10';
    kkUpdateSummary();
    document.getElementById('kk-sku').value = '';         // 明示的に未選択
    kkSkuAuto = null;
    await kkSubmit();
  });
  await p.waitForTimeout(300);
  ck('SKU未選択時は完成movementを飛ばさない', !posted.movements.some(m => m && m.movement_type === '完成'), JSON.stringify(posted.movements));
  ck('SKU未選択時はstock_qtyをPATCHしない', !posted.patches.some(x => x.body && typeof x.body.stock_qty === 'number'));

  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
