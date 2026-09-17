// 出店: バーコードで一頭ものを追加／登録間違いを消せる
//
//   きっかけ（2026-09-17 やわたんまち準備）
//     「どの肉を使うかはバーコードでも選べるようにして」「登録間違えたから消せるようにして」
//
//   ここで測ること
//     1. スキャン欄に 8桁（scan_code）を入れて Enter → その精肉パックが明細に入る（単価は前の行を引き継ぐ）
//     2. 個体管理番号（ident_code）でも入る
//     3. 見つからない／在庫でない／もう入っている／小分け（tier3）は、画面に理由が出て追加されない
//     4. 出店一覧の行に「削除」があり（準備中のみ）、押すと deleted_at で消える。詳細の上部にも削除がある
//     5. 持ち出し済でも「外す」が出て、押すと引当済のパックを在庫に戻してから明細を消す。売れた数があれば止める
//     6. 準備中でないときはスキャン欄が使えない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const EV = { id: 'e1', event_date: '2026-09-19', end_date: '2026-09-20', venue_id: 'v1', venue_name: 'やわたんまち', title: '八幡こだわり物産展', status: '準備中',
  cash_total: null, cashless_total: null, other_cost: null, booth_fee: null, visitors: null, staff_names: null, start_time: null, end_time: null, weather: null, note: null };
const EV2 = { id: 'e2', event_date: '2026-09-17', end_date: null, venue_id: 'v1', venue_name: 'ニイチク直売会', title: null, status: '準備中', sale_event_items: [] };
const INV = [
  { id: 'p1', ident_code: 'TGC-08-T276-MO', scan_code: '10004001', individual_id: 'TGC-08-T276', species: 'イノシシ', part_name: 'モモ', weight: 2.1, weight_kg: 2.1, status: '在庫', tier: 2, processed_at: '2026-09-04T03:00:00Z' },
  { id: 'p2', ident_code: 'TGC-08-T277-KR', scan_code: '10004002', individual_id: 'TGC-08-T277', species: 'イノシシ', part_name: '肩ロース', weight: 0.9, weight_kg: 0.9, status: '在庫', tier: 2, processed_at: '2026-09-05T03:00:00Z' },
  { id: 'p3', ident_code: 'TGC-08-T278-MO', scan_code: '10004003', individual_id: 'TGC-08-T278', species: 'イノシシ', part_name: 'モモ', weight: 1.5, weight_kg: 1.5, status: '出荷済', tier: 2, processed_at: '2026-09-05T03:00:00Z' },
  { id: 'p4', ident_code: 'TGC-SLB-20260916-001-3', scan_code: '10004004', individual_id: null, species: 'イノシシ', part_name: 'スライス肉', weight: 2, weight_kg: 2, status: '在庫', tier: 3, processed_at: '2026-09-16T03:00:00Z' },
];
let ITEMS = [{ id: 'i0', event_id: 'e1', kind: 'inventory', inventory_id: 'p9', ident_code: 'TGC-08-T270-MO', individual_label: 'TGC-08-T270', part_name: 'モモ', weight_kg: 2, qty_taken: 1, qty_sold: 0, qty_sample: 0, unit_price: 2600, amount: 5200 }];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const asked = []; page.on('dialog', async d => { asked.push(d.message()); await d.accept(); });
  const writes = [];
  let nextId = 1;
  await page.route('**/*', r => {
    const u = decodeURIComponent(r.request().url()), m = r.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    const body = () => { try { return JSON.parse(r.request().postData() || 'null'); } catch (e) { return null; } };
    if (/\/rest\/v1\/inventory/.test(u)) {
      if (m === 'PATCH') { const b = body(); const id = (u.match(/id=eq\.([^&]+)/) || [])[1]; const st = (u.match(/status=eq\.([^&]+)/) || [])[1];
        const row = INV.find(x => x.id === id && (!st || x.status === st)); writes.push({ t: 'inventory', m, id, st, b }); if (row) Object.assign(row, b); return J(row ? [row] : []); }
      const sc = (u.match(/scan_code=eq\.([^&]+)/) || [])[1], ic = (u.match(/ident_code=eq\.([^&]+)/) || [])[1], id = (u.match(/id=eq\.([^&]+)/) || [])[1];
      return J(INV.filter(x => (sc && x.scan_code === sc) || (ic && x.ident_code === ic) || (id && x.id === id)));
    }
    if (/\/rest\/v1\/sale_event_items/.test(u)) {
      if (m === 'POST') { const b = body(); const rows = (Array.isArray(b) ? b : [b]).map(x => Object.assign({ id: 'n' + (nextId++), qty_sample: 0, amount: Math.round((x.unit_price || 0) * (x.weight_kg || 0)) }, x)); ITEMS = ITEMS.concat(rows); writes.push({ t: 'items', m, b: rows }); return J(rows); }
      if (m === 'DELETE') { const id = (u.match(/id=eq\.([^&]+)/) || [])[1]; writes.push({ t: 'items', m, id }); ITEMS = ITEMS.filter(x => x.id !== id); return J([]); }
      if (m === 'PATCH') { const b = body(); const id = (u.match(/id=eq\.([^&]+)/) || [])[1]; const row = ITEMS.find(x => x.id === id); if (row) Object.assign(row, b); return J(row ? [row] : []); }
      return J(ITEMS);
    }
    if (/\/rest\/v1\/sale_events/.test(u)) {
      if (m === 'PATCH') { const b = body(); const id = (u.match(/id=eq\.([^&]+)/) || [])[1]; writes.push({ t: 'events', m, id, b }); if (id === 'e2') Object.assign(EV2, b); if (id === 'e1') Object.assign(EV, b); return J([id === 'e2' ? EV2 : EV]); }
      if (/id=eq\.e1/.test(u)) return J([EV]);
      return J([Object.assign({ sale_event_items: ITEMS }, EV), EV2].filter(e => !e.deleted_at));
    }
    if (/\/rest\/v1\/event_venues/.test(u)) return J([{ id: 'v1', name: 'やわたんまち', lat: null, lng: null }]);
    if (/\/rest\/v1\/individuals/.test(u)) return J([{ label_id: 'TGC-08-T276', capture_city: '館山市', capture_area: '神余', species: 'イノシシ' }, { label_id: 'TGC-08-T277', capture_city: '館山市', capture_area: '山本', species: 'イノシシ' }, { label_id: 'TGC-08-T270', capture_city: '館山市', capture_area: '正木', species: 'イノシシ' }]);
    return J([]);
  });

  await page.goto('file://' + path.resolve(__dirname, '../../index.html') + '?tab=event');
  await page.waitForTimeout(900);
  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  // ── 4) 一覧の削除 ──
  const listBtns = await page.evaluate(() => [...document.querySelectorAll('#ev-list-body tr')].map(tr => tr.textContent.replace(/\s+/g, ' ')));
  T('一覧の準備中の行に「削除」がある', listBtns.length === 2 && listBtns.every(t => /削除/.test(t)), listBtns.join(' | '));
  await page.evaluate(() => evDeleteEventById('e2'));
  await page.waitForTimeout(500);
  const delEv = writes.find(w => w.t === 'events' && w.m === 'PATCH' && w.id === 'e2');
  T('一覧から削除すると deleted_at が付き、確認ダイアログに会場名と日付', delEv && delEv.b.deleted_at && asked.some(a => /ニイチク直売会 2026-09-17/.test(a)), JSON.stringify(delEv && delEv.b));
  const listAfter = await page.evaluate(() => document.querySelectorAll('#ev-list-body tr').length);
  T('削除後は一覧から消える', listAfter === 1, String(listAfter));

  // ── 開く ──
  await page.evaluate(async () => { await evOpen('e1'); });
  await page.waitForTimeout(700);
  const head = await page.evaluate(() => ({ actions: document.getElementById('ev-d-actions').textContent, scan: !!document.getElementById('ev-scan'), disabled: document.getElementById('ev-scan').disabled, msg: document.getElementById('ev-scan-msg').textContent }));
  T('詳細の上部に「この出店を削除」がある（準備中）', /この出店を削除/.test(head.actions) && /持ち出しを確定/.test(head.actions), head.actions);
  T('スキャン欄があり、準備中は使える。使い方が書いてある', head.scan && head.disabled === false && /バーコード/.test(head.msg) && /個体番号/.test(head.msg), head.msg);

  // ── 1) 8桁で追加 ──
  await page.fill('#ev-scan', '10004001');
  await page.press('#ev-scan', 'Enter');
  await page.waitForTimeout(600);
  const add1 = writes.find(w => w.t === 'items' && w.m === 'POST');
  const msg1 = await page.evaluate(() => document.getElementById('ev-scan-msg').textContent);
  T('8桁を読むと inventory を scan_code で引いて明細に POST', add1 && add1.b[0].inventory_id === 'p1' && add1.b[0].individual_label === 'TGC-08-T276' && add1.b[0].kind === 'inventory' && add1.b[0].weight_kg === 2.1, JSON.stringify(add1 && add1.b[0]));
  T('単価は前の行（2600円/kg）を引き継ぐ', add1 && add1.b[0].unit_price === 2600 && /単価 2600/.test(msg1), msg1);
  const row1 = await page.evaluate(() => ({ rows: document.querySelectorAll('#ev-d-ind-body tr').length, txt: document.getElementById('ev-d-ind-body').textContent, val: document.getElementById('ev-scan').value, focus: document.activeElement && document.activeElement.id }));
  T('表に2行目（T276 モモ 2.10kg）が出て、欄は空になり次を読める', row1.rows === 2 && /TGC-08-T276/.test(row1.txt) && /神余/.test(row1.txt) && row1.val === '' && row1.focus === 'ev-scan', JSON.stringify([row1.rows, row1.val, row1.focus]));

  // ── 2) 個体管理番号で追加 ──
  await page.fill('#ev-scan', 'tgc-08-t277-kr');
  await page.evaluate(() => evScanAdd());
  await page.waitForTimeout(600);
  const add2 = writes.filter(w => w.t === 'items' && w.m === 'POST').pop();
  T('個体管理番号（小文字でも）で ident_code を引いて追加', add2 && add2.b[0].inventory_id === 'p2' && add2.b[0].part_name === '肩ロース', JSON.stringify(add2 && add2.b[0]));

  // ── 3) 追加できない理由が画面に出る ──
  const tryScan = async v => { await page.fill('#ev-scan', v); await page.evaluate(() => evScanAdd()); await page.waitForTimeout(400); return page.evaluate(() => document.getElementById('ev-scan-msg').textContent); };
  const postsBefore = writes.filter(w => w.t === 'items' && w.m === 'POST').length;
  T('見つからない番号は「見つかりません」', /見つかりません/.test(await tryScan('99999999')), '');
  T('もう入っているパックは「もう入っています」', /もう入っています/.test(await tryScan('10004001')), '');
  T('出荷済のパックは「出荷済」のため持ち出せない', /「出荷済」のため/.test(await tryScan('10004003')), '');
  T('小分け（tier3）は加工品から選ぶよう案内', /小分け・加工品は/.test(await tryScan('10004004')), '');
  T('空で押すと促す', /読んでください/.test(await tryScan('')), '');
  T('失敗のときは何も POST しない', writes.filter(w => w.t === 'items' && w.m === 'POST').length === postsBefore, '');

  // ── 5) 持ち出し済でも外せる（在庫に戻す） ──
  await page.evaluate(() => { evCur.status = '持ち出し済'; evFillHead(); evRenderItems(); });
  INV.find(x => x.id === 'p1').status = '引当済';
  const locked = await page.evaluate(() => ({ disabled: document.getElementById('ev-scan').disabled, btns: [...document.querySelectorAll('#ev-d-ind-body button')].map(b => b.textContent), actions: document.getElementById('ev-d-actions').textContent }));
  T('持ち出し済: スキャン欄は使えないが、各行に「外す」が出る', locked.disabled === true && locked.btns.length === 3 && locked.btns.every(t => t === '外す') && !/この出店を削除/.test(locked.actions), JSON.stringify(locked));
  const p1item = ITEMS.find(x => x.inventory_id === 'p1');
  asked.length = 0;
  await page.evaluate(id => evItemDelete(id), p1item.id);
  await page.waitForTimeout(500);
  const back = writes.find(w => w.t === 'inventory' && w.m === 'PATCH' && w.id === 'p1');
  const del1 = writes.find(w => w.t === 'items' && w.m === 'DELETE' && w.id === p1item.id);
  T('外すと 引当済→在庫 に戻してから明細を削除（確認に「在庫に戻ります」）', back && back.st === '引当済' && back.b.status === '在庫' && del1 && asked.some(a => /在庫に戻ります/.test(a)), JSON.stringify([back, del1]));
  T('戻した順序: 在庫の PATCH が明細の DELETE より先', writes.indexOf(back) < writes.indexOf(del1), '');
  // 売れた数がある行は止める
  const p2item = ITEMS.find(x => x.inventory_id === 'p2');
  INV.find(x => x.id === 'p2').status = '引当済';
  await page.evaluate(id => { const it = evItems.find(x => x.id === id); it.qty_sold = 1; evRenderItems(); }, p2item.id);
  asked.length = 0; const delsBefore = writes.filter(w => w.m === 'DELETE').length;
  await page.evaluate(id => evItemDelete(id), p2item.id);
  await page.waitForTimeout(300);
  T('売れた数が入っている行は外せない（先に0にするよう案内）', asked.some(a => /先に 0 に/.test(a)) && writes.filter(w => w.m === 'DELETE').length === delsBefore, asked.join(' / '));
  // 在庫に戻せなかったときは明細を残す
  INV.find(x => x.id === 'p2').status = '出荷済';
  await page.evaluate(id => { const it = evItems.find(x => x.id === id); it.qty_sold = 0; evRenderItems(); }, p2item.id);
  asked.length = 0;
  await page.evaluate(id => evItemDelete(id), p2item.id);
  await page.waitForTimeout(400);
  T('在庫に戻せない（出荷済）ときは明細を外さず理由を出す', asked.some(a => /「出荷済」になっているため/.test(a)) && writes.filter(w => w.m === 'DELETE').length === delsBefore, asked.join(' / ').slice(0, 120));

  // ── 6) 準備中でないとスキャンできない ──
  await page.evaluate(() => { document.getElementById('ev-scan').disabled = false; document.getElementById('ev-scan').value = '10004002'; });
  T('準備中でなければ追加を断る', /準備中の出店だけ/.test(await tryScan('10004002')), '');

  T('pageerrorなし', errors.length === 0, errors.join(' / '));
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
