// 「1個体の一生が1本の線で繋がる」ための3点を守る。
//   ① 精肉パックラベルに「この肉の物語」QR（8桁がある時だけ）→ 食べた人の声への入口
//   ② 出荷先の無い「出荷済」を作らない：手動ステータス変更でも注文・出荷・紐付けを作る
//   ③ 個体の一生ビューに、届いた声が出て「こえ」の段階が灯る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9103);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const ctx = await b.newContext({ viewport: { width: 1200, height: 900 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));

  // 疑似DB
  const writes = { orders: [], order_items: [], shipments: [], invPatch: [], voiceGets: 0 };
  const INV = { id: 'inv-9', ident_code: 'TGC-08-T400-ED', part_name: '枝肉（全体）', species: 'イノシシ', weight: 28.5, weight_kg: 28.5, status: '在庫', scan_code: '10004000' };
  const VOICES = [
    { id: 'v1', scan_code: '10004000', individual_label: 'TGC-08-T400', nickname: '館山の田中', rating: 5, dish: 'ぼたん鍋', comment: 'やわらかくて驚いた', created_at: '2026-09-02T10:00:00Z', published_at: null },
    { id: 'v2', scan_code: null, individual_label: 'TGC-08-T400', nickname: null, rating: 4, dish: null, comment: null, created_at: '2026-09-01T10:00:00Z', published_at: '2026-09-02T00:00:00Z' },
  ];
  await p.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = (x, st) => rt.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (/\/rpc\/staff_lookup_customer_id/.test(url)) return J(null);
    if (m === 'POST' && /\/orders/.test(url)) { const b = JSON.parse(req.postData() || '{}'); writes.orders.push(b); return J([{ id: 'ord-1', ...b }], 201); }
    if (m === 'POST' && /\/order_items/.test(url)) { const b = JSON.parse(req.postData() || '[]'); writes.order_items.push(...(Array.isArray(b) ? b : [b])); return J([], 201); }
    if (m === 'POST' && /\/shipments/.test(url)) { const b = JSON.parse(req.postData() || '{}'); writes.shipments.push(b); return J([{ id: 'sh-1' }], 201); }
    if (m === 'PATCH' && /\/inventory/.test(url)) { writes.invPatch.push({ url, body: JSON.parse(req.postData() || '{}') }); return J([]); }
    if (m === 'GET' && /\/inventory/.test(url)) {
      if (/id=eq\.inv-9/.test(url)) return J([INV]);
      if (/individual_id=eq\.TGC-08-T400/.test(url)) return J([INV]);
      return J([]);
    }
    if (m === 'GET' && /\/individuals/.test(url)) return J([{ label_id: 'TGC-08-T400', species: 'イノシシ', capture_date: '2026-08-20', weight_total: 60 }]);
    // meal_voices は RLS が deny-all（public）なので画面からは直接読めない（読めても0件で静かに空になる）。
    // 一生ビューは物語ページと同じ RPC（公開済み）＋ 職員用 RPC（承認待ち）で引く
    if (/\/rpc\/story_get_individual/.test(url)) return J({ individual_label: 'TGC-08-T400', voices: VOICES.filter(v => v.published_at).map(v => ({ nickname: v.nickname, rating: v.rating, dish: v.dish, comment: v.comment, at: '2026/09/01' })) });
    if (/\/rpc\/staff_voices_list/.test(url)) return J(VOICES.filter(v => !v.published_at).map(v => ({ id: v.id, individual_label: v.individual_label, nickname: v.nickname, rating: v.rating, comment: v.comment, status: 'pending' })));
    if (m === 'GET' && /\/meal_voices/.test(url)) { writes.voiceGets++; return J([]); }   // RLSで空になる本番と同じ
    return J([]);
  });
  await p.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));
  await p.goto('http://localhost:9103/index.html'); await p.waitForTimeout(600);

  // ── ① ラベルのQR ──
  const lab = await p.evaluate(() => {
    const mk = (scan) => pmLabelHtml({
      origin: '館山産', speciesName: 'イノシシ肉', labelId: 'TGC-08-T312', partName: '枝肉（下）',
      labelWeight: 5.83, expiryStr: '2027/9/3', identCode: 'TGC-08-T312-EDS-3',
      barcodeSvg: makeCode128SVG(scan || 'T312-EDS-3'), barcodeThin: !scan, scanCode: scan || null,
      qrSvg: scan ? makeQRSVG(storyUrl(scan), 9.5) : null
    });
    return { withScan: mk('10003258'), noScan: mk(null), url: storyUrl('10003258') };
  });
  ck('8桁あり: QRを載せる', /class="qr"><svg/.test(lab.withScan), '');
  ck('8桁あり: 案内文「この肉の物語」', /この肉の物語/.test(lab.withScan), '');
  ck('QRの行き先は s.html?c=8桁', lab.url === 'https://tateyama-gibier.vercel.app/s.html?c=10003258', lab.url);
  ck('8桁なし: QRを載せない（飛び先が無いため）', !/class="qr"/.test(lab.noScan), '');
  // 実寸で 40mm×60mm に収まる
  const pg2 = await ctx.newPage({ viewport: { width: 151, height: 227 } });
  await pg2.setContent(lab.withScan); await pg2.waitForTimeout(200);
  const fit = await pg2.evaluate(() => ({ over: document.body.scrollHeight > document.body.clientHeight + 2, bottom: document.querySelector('.ad').getBoundingClientRect().bottom, h: document.body.clientHeight }));
  ck('QR付きでも60mmに収まる', !fit.over && fit.bottom <= fit.h, JSON.stringify(fit));
  await pg2.close();

  // ── ② 出荷先の無い「出荷済」を作らない ──
  await p.evaluate(() => { window.requireAdmin = () => true; window.loadInventory = () => {}; window.toast = () => {}; });
  // 出荷先を空で答える → 出荷済にしない（在庫PATCHも注文も発生しない）
  let promptQueue = ['出荷済', ''];
  await p.evaluate(() => { window.__pq = []; window.prompt = () => window.__pq.shift(); });
  await p.evaluate((q) => { window.__pq = q; }, promptQueue);
  await p.evaluate(async () => { await changeStatus('inv-9', 'TGC-08-T400-ED'); });
  ck('出荷先が空なら出荷済にしない（在庫PATCHなし）', writes.invPatch.length === 0, String(writes.invPatch.length));
  ck('出荷先が空なら注文を作らない', writes.orders.length === 0, String(writes.orders.length));

  // 出荷先を入れる → 注文・明細（在庫ID紐付け）・出荷・在庫出荷済 が揃う
  await p.evaluate(() => { window.__pq = ['出荷済', '那珂川町イノシシ肉加工施設']; });
  await p.evaluate(async () => { await changeStatus('inv-9', 'TGC-08-T400-ED'); });
  ck('注文が1件できる（DIR-・発送済・直販）', writes.orders.length === 1 && /^DIR-/.test(writes.orders[0].order_code) && writes.orders[0].status === '発送済' && writes.orders[0].channel === '直販（注文なし）', JSON.stringify(writes.orders[0] || {}));
  ck('注文の出荷先が入る', writes.orders[0] && writes.orders[0].customer_name === '那珂川町イノシシ肉加工施設', writes.orders[0] && writes.orders[0].customer_name);
  ck('明細が在庫IDで紐付く（線が切れない）', writes.order_items.length === 1 && writes.order_items[0].inventory_id === 'inv-9' && writes.order_items[0].part_name === '枝肉（全体）', JSON.stringify(writes.order_items));
  ck('出荷レコードができる', writes.shipments.length === 1 && writes.shipments[0].status === '出荷済', JSON.stringify(writes.shipments));
  ck('在庫が出荷済になる', writes.invPatch.length === 1 && writes.invPatch[0].body.status === '出荷済' && /id=eq\.inv-9/.test(writes.invPatch[0].url), JSON.stringify(writes.invPatch));

  // ── ③ 一生ビューに声が出て「こえ」が灯る ──
  await p.evaluate(async () => { await indLifeOpen('TGC-08-T400'); });
  await p.waitForTimeout(300);
  const life = await p.evaluate(() => document.getElementById('ind-life-body').innerHTML);
  ck('公開済みの声が表示される（物語ページと同じRPC）', /名前なし/.test(life) && /★★★★☆/.test(life), '');
  ck('未公開の声は本文を出さず、承認待ち件数と行き先を出す', !/やわらかくて驚いた/.test(life) && /承認待ちの感想が 1件/.test(life) && /食べた人の声で確認する/.test(life), '');
  ck('「準備中」の文言が消えている', !/準備中/.test(life), '');
  ck('「こえ」の段階に件数（公開1・待ち1）が出る', /こえ/.test(life) && /1件（待ち1）/.test(life), '');
  ck('meal_voices を画面から直接読まない（RLS deny-all のため）', writes.voiceGets === 0, String(writes.voiceGets));

  ck('JSエラーなし', !errs.some(e => /pmLabelHtml|changeStatus|recordDirectShipment|indLife/.test(e)), errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
