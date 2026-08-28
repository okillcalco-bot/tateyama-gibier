// 出店の記録（どこに・何を持って行き・いくら売れたか）
//   いちばん大事なのは「一頭ずつ分かるお肉」と「小分けパック」を混ぜないこと。
//   小分けは◯個のうちのどれが誰かを特定できないので、個体には紐づけない。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const VENUES = [
  { id: 'v1', name: '館山なぎさ市', kind: 'マルシェ', address: '館山市北条', sort_order: 10, deleted_at: null },
  { id: 'v2', name: '枇杷倶楽部', kind: '施設', address: '南房総市富浦町', sort_order: 20, deleted_at: null },
];
const INV2 = [
  { id: 'p1', ident_code: 'TGC-08-M169-KG', scan_code: '10000974', individual_id: 'TGC-08-M169', species: 'イノシシ', part_name: '唐揚げ用', weight: 1.31, processed_at: '2026-08-27T03:34:06+00:00', created_at: '2026-08-27T03:34:06+00:00' },
  { id: 'p2', ident_code: 'TGC-08-M168-KG', scan_code: '10000930', individual_id: 'TGC-08-M168', species: 'イノシシ', part_name: '唐揚げ用', weight: 1.62, processed_at: '2026-08-27T01:05:03+00:00', created_at: '2026-08-27T01:05:03+00:00' },
  { id: 'p3', ident_code: 'TGC-08-M169-RO', scan_code: '10000975', individual_id: 'TGC-08-M169', species: 'イノシシ', part_name: 'ロース', weight: 2.10, processed_at: '2026-08-27T03:40:00+00:00', created_at: '2026-08-27T03:40:00+00:00' },
];
const INV3 = [
  { id: 's1', ident_code: 'TGC-SL-20260825-001', individual_code: 'TGC-SLB-20260825-001', part_name: 'スライス用', process_type: 'スライス肉（3mm）', weight: 0.3, processed_at: '2026-08-25T01:43:41+00:00' },
  { id: 's2', ident_code: 'TGC-SL-20260825-002', individual_code: 'TGC-SLB-20260825-001', part_name: 'スライス用', process_type: 'スライス肉（3mm）', weight: 0.3, processed_at: '2026-08-25T01:43:41+00:00' },
  { id: 's3', ident_code: 'TGC-SL-20260825-003', individual_code: 'TGC-SLB-20260825-001', part_name: 'スライス用', process_type: 'スライス肉（3mm）', weight: 0.3, processed_at: '2026-08-25T01:43:41+00:00' },
  { id: 'm1', ident_code: 'TGC-MI-20260826-001', individual_code: 'TGC-MIB-20260826-001', part_name: 'ミンチ用', process_type: 'ミンチ肉（粗挽き）', weight: 0.5, processed_at: '2026-08-26T04:53:32+00:00' },
];
const LOGS = [
  { child_ident_code: 'TGC-SLB-20260825-001', individual_id: 'TGC-08-M159' },
  { child_ident_code: 'TGC-SLB-20260825-001', individual_id: 'TGC-08-M160' },
  { child_ident_code: 'TGC-SLB-20260825-001', individual_id: 'TGC-08-M161' },
  { child_ident_code: 'TGC-MIB-20260826-001', individual_id: 'TGC-08-T260' },
];
const INDS = [
  { label_id: 'TGC-08-M169', species: 'イノシシ', sex: 'オス', weight_total: 41.1, capture_date: '2026-08-13', capture_city: '南房総市', capture_area: '川谷', capture_method: '箱罠', radiation_test_date: '2026-08-21', radiation_result: '検出下限値以下', processing_done_at: '2026-08-27T03:36:26+00:00' },
  { label_id: 'TGC-08-M168', species: 'イノシシ', sex: 'メス', weight_total: 29.2, capture_date: '2026-08-13', capture_city: '南房総市', capture_area: '下堀', capture_method: '箱罠', radiation_test_date: '2026-08-20', radiation_result: '検出下限値以下', processing_done_at: '2026-08-27T01:13:59+00:00' },
];

// 確定済みの過去の出店（傾向の材料）
const PAST = {
  id: 'e0', event_date: '2026-07-20', end_date: null, venue_id: 'v1', venue_name: '館山なぎさ市',
  title: '夏市', status: '実績確定', booth_fee: 3000, other_cost: 1000, visitors: 60,
  cash_total: null, note: null, deleted_at: null,
};
const PAST_ITEMS = [
  { id: 'i0a', event_id: 'e0', kind: 'inventory', part_name: '唐揚げ用', qty_taken: 1, qty_sold: 1, amount: 3900 },
  { id: 'i0b', event_id: 'e0', kind: 'lot', item_name: 'ミンチ肉（粗挽き）', match_key: 'ミンチ肉（粗挽き）', qty_taken: 30, qty_sold: 24, amount: 24000 },
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const asked = []; let dialogAnswer = true;
  page.on('dialog', async d => { asked.push(d.message()); dialogAnswer ? await d.accept() : await d.dismiss(); });

  // 小さな偽サーバー（この画面が実際に投げる形をそのまま受ける）
  const db = { events: [Object.assign({}, PAST)], items: PAST_ITEMS.slice(), venues: VENUES.slice(), seq: 0 };
  const rpcCalls = [];
  const uid = () => 'x' + (++db.seq);

  await page.route('**/*', async r => {
    const u = r.request().url(), m = r.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    let body = null; try { body = JSON.parse(r.request().postData() || 'null'); } catch (e) {}
    const idOf = re => { const mm = decodeURIComponent(u).match(re); return mm ? mm[1] : null; };

    if (/\/rpc\/sale_event_(takeout|settle|reopen)/.test(u)) {
      const fn = u.match(/sale_event_(\w+)/)[1];
      rpcCalls.push({ fn, body });
      const ev = db.events.find(e => e.id === body.p_event_id);
      if (fn === 'takeout') ev.status = '持ち出し済';
      if (fn === 'settle') ev.status = '実績確定';
      if (fn === 'reopen') ev.status = '準備中';
      const total = db.items.filter(i => i.event_id === ev.id).reduce((a, i) => a + (i.amount || 0), 0);
      return J(fn === 'settle'
        ? { ok: true, sold: 1, lot_sold: 5, returned: 1, total, short: [], status: ev.status }
        : { ok: true, moved: 2, returned: 2, status: ev.status });
    }
    if (/\/rest\/v1\/event_venues/.test(u)) {
      if (m === 'POST') { const v = Object.assign({ id: uid(), sort_order: 100, deleted_at: null }, body); db.venues.push(v); return J([v]); }
      if (m === 'PATCH') { const id = idOf(/id=eq\.([^&]+)/); db.venues = db.venues.filter(v => v.id !== id); return J([]); }
      return J(db.venues.filter(v => !v.deleted_at));
    }
    if (/\/rest\/v1\/sale_events/.test(u)) {
      if (m === 'POST') { const e = Object.assign({ id: uid(), status: '準備中', deleted_at: null }, body); db.events.push(e); return J([e]); }
      if (m === 'PATCH') { const id = idOf(/id=eq\.([^&]+)/); Object.assign(db.events.find(e => e.id === id), body); return J([]); }
      const id = idOf(/id=eq\.([^&]+)/);
      let rows = db.events.filter(e => !e.deleted_at);
      if (id) rows = rows.filter(e => e.id === id);
      if (/sale_event_items\(/.test(decodeURIComponent(u))) {
        rows = rows.map(e => Object.assign({}, e, { sale_event_items: db.items.filter(i => i.event_id === e.id) }));
      }
      return J(rows);
    }
    if (/\/rest\/v1\/sale_event_items/.test(u)) {
      if (m === 'POST') {
        const arr = Array.isArray(body) ? body : [body];
        const made = arr.map(x => Object.assign({ id: uid(), qty_taken: 1, qty_sold: 0, unit_price: 0, price_basis: 'kg' }, x));
        made.forEach(x => {
          x.amount = x.price_basis === 'kg'
            ? Math.round((x.unit_price || 0) * (x.weight_kg || 0) * (x.qty_sold || 0))
            : Math.round((x.unit_price || 0) * (x.qty_sold || 0));
          db.items.push(x);
        });
        return J(made);
      }
      if (m === 'PATCH') {
        const id = idOf(/id=eq\.([^&]+)/); const it = db.items.find(i => i.id === id);
        Object.assign(it, body);
        it.amount = it.price_basis === 'kg'
          ? Math.round((it.unit_price || 0) * (it.weight_kg || 0) * (it.qty_sold || 0))
          : Math.round((it.unit_price || 0) * (it.qty_sold || 0));
        return J([it]);
      }
      if (m === 'DELETE') { const id = idOf(/id=eq\.([^&]+)/); db.items = db.items.filter(i => i.id !== id); return J([]); }
      const one = idOf(/[?&]id=eq\.([^&]+)/);
      if (one) return J(db.items.filter(i => i.id === one));
      const ev = idOf(/event_id=eq\.([^&]+)/);
      if (ev) return J(db.items.filter(i => i.event_id === ev));
      const inl = decodeURIComponent(u).match(/event_id=in\.\(([^)]*)\)/);
      if (inl) { const want = inl[1].split(',').map(x => x.replace(/"/g, '')); return J(db.items.filter(i => want.includes(i.event_id))); }
      return J([]);
    }
    if (/\/rest\/v1\/inventory/.test(u)) {
      if (/tier=eq\.3/.test(u)) return J(INV3);
      if (/tier=eq\.2/.test(u)) return J(INV2);
      return J([]);
    }
    if (/\/rest\/v1\/processing_log/.test(u)) {
      const want = (decodeURIComponent(u).match(/child_ident_code=in\.\(([^)]*)\)/) || [, ''])[1]
        .split(',').map(x => x.replace(/"/g, ''));
      return J(LOGS.filter(l => want.includes(l.child_ident_code)));
    }
    if (/\/rest\/v1\/individuals/.test(u)) {
      const mm = decodeURIComponent(u).match(/label_id=in\.\(([^)]*)\)/);
      if (mm) { const want = mm[1].split(',').map(x => x.replace(/"/g, '')); return J(INDS.filter(i => want.includes(i.label_id))); }
      return J([]);
    }
    return J([]);
  });

  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(700);

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  // ── 1) タブを開くと出店の一覧と傾向が出る ──
  await page.click('.tab-btn[data-tab="event"]');
  await page.waitForTimeout(800);
  const listTxt = await page.$eval('#ev-list-body', el => el.textContent);
  T('過去の出店が一覧に出る', /館山なぎさ市/.test(listTxt) && /実績確定/.test(listTxt), listTxt.replace(/\s+/g, ' ').slice(0, 70));
  T('確定した出店は売上が出る', /27,900/.test(listTxt), listTxt.replace(/\s+/g, ' ').slice(0, 90));
  const trend = await page.$eval('#ev-trend', el => el.textContent.replace(/\s+/g, ' '));
  T('傾向に出店回数と売上が出る', /出店した回数 1回/.test(trend) && /¥27,900/.test(trend), trend.slice(0, 110));
  T('傾向は差引まで出す', /差引/.test(trend) && /¥23,900/.test(trend), '');

  // ── 2) 出店先を選んで新しい出店を作る ──
  await page.click('button[onclick="evNewOpen()"]');
  await page.waitForTimeout(200);
  const venueOpts = await page.$eval('#ev-n-venue', el => [...el.options].map(o => o.textContent).join(','));
  T('出店先を毎回選べる', venueOpts.includes('館山なぎさ市') && venueOpts.includes('枇杷倶楽部'), venueOpts);

  asked.length = 0;
  await page.evaluate(() => {
    document.getElementById('ev-n-venue').value = 'v2';
    document.getElementById('ev-n-date').value = '2026-08-29';
    document.getElementById('ev-n-end').value = '2026-08-20';    // わざと開催日より前
    document.getElementById('ev-n-title').value = '夏の出店';
  });
  await page.click('button[onclick="evNewSave()"]');
  await page.waitForTimeout(300);
  T('最終日が開催日より前なら止める', asked.some(a => /最終日が開催日より前/.test(a)), asked.join(' / '));

  await page.evaluate(() => { document.getElementById('ev-n-end').value = '2026-08-30'; });
  await page.click('button[onclick="evNewSave()"]');
  await page.waitForTimeout(900);
  T('出店を作ると明細画面が開く', await page.$eval('#ev-view-detail', el => el.style.display !== 'none'), '');
  T('見出しに出店先と日付が出る', /枇杷倶楽部/.test(await page.$eval('#ev-d-head', el => el.textContent)),
    await page.$eval('#ev-d-head', el => el.textContent).then(t => t.replace(/\s+/g, ' ')));
  T('はじめは準備中', /準備中/.test(await page.$eval('#ev-d-head', el => el.textContent)), '');

  // ── 3) 一頭ずつ分かるお肉を在庫から選ぶ ──
  await page.click('#ev-add-ind');
  await page.waitForTimeout(600);
  const pickTxt = await page.$eval('#ev-pick-list', el => el.textContent);
  T('在庫ピッカーに精肉が出る', /TGC-08-M169/.test(pickTxt) && /唐揚げ用/.test(pickTxt), '');
  T('ピッカーに加工品は出ない', !/スライス肉/.test(pickTxt) && !/ミンチ肉/.test(pickTxt), '');
  await page.click('#ev-pick-all');
  await page.fill('#ev-pick-price', '3000');
  await page.click('button[onclick="evPickAdd()"]');
  await page.waitForTimeout(600);
  const indBody = await page.$eval('#ev-d-ind-body', el => el.textContent.replace(/\s+/g, ' '));
  T('一頭ものの表に入る', /TGC-08-M169/.test(indBody) && /TGC-08-M168/.test(indBody), indBody.slice(0, 80));
  T('獲れた場所も出る', /川谷/.test(indBody) && /下堀/.test(indBody), '');
  const addedInd = await page.evaluate(() => evItems.filter(i => i.kind === 'inventory').length);
  T('選んだパックが3点入る', addedInd === 3, addedInd);

  // 二重に積まない
  await page.click('#ev-add-ind');
  await page.waitForTimeout(600);
  T('すでに積んだ在庫はピッカーに出ない',
    !/TGC-08-M169/.test(await page.$eval('#ev-pick-list', el => el.textContent)), '');
  await page.click('#ev-pick-modal .modal-close');

  // ── 4) 小分けパックは個体に紐づけない ──
  await page.click('#ev-add-lot');
  await page.waitForTimeout(700);
  const lotTxt = await page.$eval('#ev-lot-list', el => el.textContent.replace(/\s+/g, ' '));
  T('加工品が商品ごとにまとまる', /スライス肉（3mm）/.test(lotTxt) && /ミンチ肉（粗挽き）/.test(lotTxt), lotTxt.slice(0, 90));
  T('在庫の個数が出る', /3個/.test(lotTxt), lotTxt.slice(0, 90));
  T('入っている頭数が出る', /3頭/.test(lotTxt), lotTxt.slice(0, 120));
  await page.evaluate(() => {
    const n = (window.evLotList || []).findIndex(o => o.key === 'スライス肉（3mm）');
    document.getElementById('ev-lot-q-' + n).value = '3';
    document.getElementById('ev-lot-p-' + n).value = '1200';
    evLotAdd(n);
  });
  await page.waitForTimeout(600);
  const lot = await page.evaluate(() => evItems.find(i => i.kind === 'lot'));
  T('小分けは kind=lot で入る', lot && lot.kind === 'lot', lot && lot.kind);
  T('小分けは個体番号を持たない', lot && !lot.individual_label, String(lot && lot.individual_label));
  T('小分けは在庫のパックに紐づかない', lot && !lot.inventory_id, String(lot && lot.inventory_id));
  T('小分けは入っている頭だけを記録する', lot && lot.member_labels && lot.member_labels.length === 3,
    lot && (lot.member_labels || []).join('・'));
  T('小分けは円/個で数える', lot && lot.price_basis === 'unit' && lot.qty_taken === 3, JSON.stringify(lot && [lot.price_basis, lot.qty_taken]));
  const lotBody = await page.$eval('#ev-d-lot-body', el => el.textContent.replace(/\s+/g, ' '));
  T('小分けは別の表に出る', /スライス肉（3mm）/.test(lotBody) && !/スライス肉（3mm）/.test(await page.$eval('#ev-d-ind-body', el => el.textContent)), '');
  T('小分けの表に「入っている頭」が出る', /3頭/.test(lotBody), lotBody.slice(0, 90));

  // ── 5) 持ち出し → 売上 → 取り消し ──
  rpcCalls.length = 0; asked.length = 0;
  await page.click('button[onclick="evTakeout()"]');
  await page.waitForTimeout(700);
  T('持ち出しの確認に点数を出す', asked.some(a => /一頭もの 3点/.test(a) && /小分け・その他 3個/.test(a)), asked.join(' / ').slice(0, 90));
  T('持ち出しRPCを呼ぶ', rpcCalls.some(c => c.fn === 'takeout'), rpcCalls.map(c => c.fn).join(','));
  T('持ち出し後は追加できない', await page.$eval('#ev-add-ind', el => el.disabled), '');
  T('状態が持ち出し済になる', /持ち出し済/.test(await page.$eval('#ev-d-head', el => el.textContent)), '');

  // 売れた数の上限
  asked.length = 0;
  await page.evaluate(() => {
    const lot = evItems.find(i => i.kind === 'lot');
    evItemPatch(lot.id, 'qty_sold', 99);
  });
  await page.waitForTimeout(400);
  T('持って行った数より多くは売れない', asked.some(a => /より多くは売れません/.test(a)), asked.join(' / ').slice(0, 60));

  await page.evaluate(async () => {
    const lot = evItems.find(i => i.kind === 'lot');
    await evItemPatch(lot.id, 'qty_sold', 2);
    const ind = evItems.filter(i => i.kind === 'inventory');
    await evItemPatch(ind[0].id, 'qty_sold', 1);
  });
  await page.waitForTimeout(600);
  const totalTxt = await page.$eval('#ev-d-total', el => el.textContent.replace(/\s+/g, ' '));
  T('金額が計算される（1.31×3000＋1200×2）', /¥6,330/.test(totalTxt), totalTxt.slice(0, 120));
  T('一頭ものと小分けを別々に数える', /1 \/ 3点/.test(totalTxt) && /2 \/ 3個/.test(totalTxt), totalTxt.slice(0, 120));

  rpcCalls.length = 0;
  await page.click('button[onclick="evSettle()"]');
  await page.waitForTimeout(700);
  T('売上確定RPCを呼ぶ', rpcCalls.some(c => c.fn === 'settle'), rpcCalls.map(c => c.fn).join(','));
  T('状態が実績確定になる', /実績確定/.test(await page.$eval('#ev-d-head', el => el.textContent)), '');

  rpcCalls.length = 0;
  await page.click('button[onclick="evReopen()"]');
  await page.waitForTimeout(700);
  T('取消RPCを呼ぶ', rpcCalls.some(c => c.fn === 'reopen'), rpcCalls.map(c => c.fn).join(','));
  T('準備中に戻る', /準備中/.test(await page.$eval('#ev-d-head', el => el.textContent)), '');

  // ── 6) 報告書 ──
  const report = await page.evaluate(async () => {
    let html = '';
    const orig = window.evPrintDoc;
    window.evPrintDoc = (css, body) => { html = `<style>${css}</style>${body}`; };
    evReportPrint();
    window.evPrintDoc = orig;
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;left:-9999px;top:0;border:0;width:210mm;height:297mm;';
    document.body.appendChild(f);
    const doc = f.contentDocument; doc.open();
    doc.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>${html}</body></html>`); doc.close();
    await new Promise(r => setTimeout(r, 150));
    const heads = [...doc.querySelectorAll('h2')].map(h => h.textContent);
    const out = { text: doc.body.textContent.replace(/\s+/g, ' '), heads };
    f.remove();
    return out;
  });
  T('報告書に出店先と日付が出る', /枇杷倶楽部/.test(report.text) && /2026-08-29/.test(report.text), report.text.slice(0, 80));
  T('報告書は一頭ものと小分けを分けて書く',
    report.heads.some(h => /一頭ずつ分かるお肉/.test(h)) && report.heads.some(h => /小分けパック/.test(h)),
    report.heads.join(' | '));
  T('小分けには「個体は特定せず」と書く', /個体は特定せず/.test(report.text), '');
  T('報告書に売上と差引が出る', /明細の売上/.test(report.text) && /差引/.test(report.text), '');
  T('一頭ものは個体番号と獲れた場所を載せる', /TGC-08-M169/.test(report.text) && /川谷/.test(report.text), '');

  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
