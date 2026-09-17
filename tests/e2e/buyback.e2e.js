// 買取金額通知（buyback.html）：
//   半期の個体から、告知 別紙3 のルール（体重×ランク単価×歩留まり係数−引取3,000・0円下限・中型獣1,000円）で
//   支払先ごとの金額が出ること。歩留まりは精肉重量÷体重（在庫から）。精肉前は「未確定」で隠さない。
//   口座は捕獲者台帳から。通知書・振込一覧・ルール保存・下書き保存が動くこと。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const RULES = { boar:{ female_rank_unit:{'並':100,'上':200,'極上':300}, male_unit:100, yield_ranks:[{rank:'A',min_pct:30,ratio:1,label:'3割以上'},{rank:'B',min_pct:20,ratio:0.5,label:'2〜3割'},{rank:'C',min_pct:10,ratio:0.3,label:'1〜2割'},{rank:'D',min_pct:0,ratio:0,label:'1割未満'}], weight_floor:true, min_weight_kg:20 }, deer:{unit:100,use_yield:true}, small:{price:1000,species:['キョン','アライグマ','ハクビシン','タヌキ','ノウサギ']}, pickup_fee:3000, source:'テスト' };
const HUNTERS = [
  { id:'h1', name:'井上　定男', furigana:'いのうえさだお', bank_name:'ＪＡ安房', bank_branch:'館野支店', account_type:'普通', account_number:'4111589', account_holder:null, account_furigana:'ｲﾉｳｴ ｻﾀﾞｵ', payee_no:4, city:'館山市' },
  { id:'h2', name:'山田千代子', furigana:'やまだちよこ', bank_name:null, bank_branch:null, account_type:null, account_number:null, account_holder:null, account_furigana:null, payee_no:11, city:'館山市' },
];
const INDS = [
  { id:'i1', label_id:'TGC-08-T001', species:'イノシシ', capture_date:'2026-04-05', capture_city:'館山市', capture_area:'神余', hunter_name:'井上定男', purchase_payee:null, sex:'メス', weight_total:40.0, meat_rank:'極上', yield_rate:null, stopkill_pickup:false, intake_method:'搬入', processing_done_at:'2026-04-06T02:00:00Z', buyback_amount:null },
  { id:'i2', label_id:'TGC-08-T002', species:'イノシシ', capture_date:'2026-05-10', capture_city:'館山市', capture_area:'稲', hunter_name:'井上定男', purchase_payee:null, sex:'オス', weight_total:33.3, meat_rank:'並', yield_rate:null, stopkill_pickup:true, intake_method:'引取', processing_done_at:'2026-05-11T02:00:00Z', buyback_amount:null },
  { id:'i3', label_id:'TGC-08-T003', species:'イノシシ', capture_date:'2026-09-20', capture_city:'館山市', capture_area:'坂井', hunter_name:'山田千代子', purchase_payee:null, sex:'メス', weight_total:50.0, meat_rank:null, yield_rate:null, stopkill_pickup:false, intake_method:'搬入', processing_done_at:null, buyback_amount:null },
  { id:'i4', label_id:'TGC-08-T004', species:'イノシシ', capture_date:'2026-06-01', capture_city:'南房総市', capture_area:'宮下', hunter_name:'山田千代子', purchase_payee:'井上定男', sex:'メス', weight_total:28.0, meat_rank:'並', yield_rate:null, stopkill_pickup:false, intake_method:'搬入', processing_done_at:'2026-06-02T02:00:00Z', buyback_amount:null },
  { id:'i5', label_id:'TGC-08-キ001', species:'キョン', capture_date:'2026-07-01', capture_city:'館山市', capture_area:'山本', hunter_name:'山田千代子', purchase_payee:null, sex:'オス', weight_total:8.0, meat_rank:null, yield_rate:null, stopkill_pickup:false, intake_method:'搬入', processing_done_at:null, buyback_amount:null },
  { id:'i6', label_id:'TGC-08-シ001', species:'シカ', capture_date:'2026-08-01', capture_city:'館山市', capture_area:'神余', hunter_name:'山田千代子', purchase_payee:null, sex:'オス', weight_total:45.0, meat_rank:null, yield_rate:null, stopkill_pickup:false, intake_method:'搬入', processing_done_at:'2026-08-02T02:00:00Z', buyback_amount:null },
  { id:'i7', label_id:'TGC-TEST-1', species:'イノシシ', capture_date:'2026-08-01', hunter_name:'テスト', weight_total:30 },
];
const INV = [ { individual_id:'TGC-08-T001', weight:6, weight_kg:6 }, { individual_id:'TGC-08-T001', weight:6, weight_kg:6 }, { individual_id:'TGC-08-T002', weight:8, weight_kg:8 }, { individual_id:'TGC-08-T004', weight:5, weight_kg:5 }, { individual_id:'TGC-08-シ001', weight:15, weight_kg:15 } ];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept('テストメモ'));
  const calls = [];
  await page.route('**/*', r => {
    const u = decodeURIComponent(r.request().url()), m = r.request().method();
    if (u.startsWith('file:')) return r.continue();
    if (/fonts\./.test(u)) return r.fulfill({ status: 200, body: '' });
    const J = (x, st) => r.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(x) });
    const body = () => { try { return JSON.parse(r.request().postData() || 'null'); } catch (e) { return null; } };
    if (m !== 'GET') { const b = body(); calls.push({ m, u, b }); if (/buyback_runs/.test(u) && m === 'POST') return J([Object.assign({ id: 'run1' }, b)]); return J(Array.isArray(b) ? b : [b]); }
    if (/app_settings/.test(u)) return J([{ key: 'buyback_rules', value: RULES }]);
    if (/\/hunters/.test(u)) return J(HUNTERS);
    if (/\/individuals/.test(u)) { const from = (u.match(/capture_date=gte\.([\d-]+)/)||[])[1], to = (u.match(/capture_date=lte\.([\d-]+)/)||[])[1]; return J(INDS.filter(i => (!from || i.capture_date >= from) && (!to || i.capture_date <= to))); }
    if (/\/inventory/.test(u)) return J(INV);
    if (/buyback_runs/.test(u)) return J([{ id:'run1', period_key:'R8H1', fiscal_year:8, half:'上半期', from_date:'2026-04-01', to_date:'2026-09-30', status:'下書き', note:'x', created_at:'2026-09-17T00:00:00Z', updated_at:'2026-09-17T00:00:00Z', total: 18840, heads: 6 }]);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../buyback.html'));
  await page.waitForTimeout(700);
  const results = []; const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  // 初期: 年度と半期から期間が入る
  await page.selectOption('#fYear', '8'); await page.selectOption('#fHalf', 'H1');
  await page.evaluate(() => fillPeriod());
  const per = await page.evaluate(() => ({ from: document.getElementById('fFrom').value, to: document.getElementById('fTo').value }));
  T('令和8年度上半期 = 2026-04-01〜2026-09-30', per.from === '2026-04-01' && per.to === '2026-09-30', JSON.stringify(per));

  // 計算式（単体）
  const c = await page.evaluate(() => ({
    gokujo: calcOne(RULES, { species:'イノシシ', sex:'メス', weight_total:40, meat_rank:'極上' }, 12),           // 40×300×1.0 = 12000（30% → A）
    male_pickup: calcOne(RULES, { species:'イノシシ', sex:'オス', weight_total:33.3, meat_rank:'並', stopkill_pickup:true }, 8),  // 33×100×0.5=1650 −3000 → 0
    female_c: calcOne(RULES, { species:'イノシシ', sex:'メス', weight_total:28, meat_rank:'並' }, 5),           // 17.9% → C → 28×100×0.3 = 840
    pending: calcOne(RULES, { species:'イノシシ', sex:'メス', weight_total:50, meat_rank:null }, 0),
    kyon: calcOne(RULES, { species:'キョン', weight_total:8 }, 0),
    deer: calcOne(RULES, { species:'シカ', weight_total:45 }, 15),                                              // 33% → A → 45×100 = 4500
    small_w: calcOne(RULES, { species:'イノシシ', sex:'オス', weight_total:18.5, meat_rank:'並' }, 6),         // 32% → A → 18×100 = 1800、20kg未満の注意
    male_rank_ignored: calcOne(RULES, { species:'イノシシ', sex:'オス', weight_total:40, meat_rank:'極上' }, 12), // オスは一律100
  }));
  T('メス極上 40kg 歩留まり30% → A → 12,000円', c.gokujo.price === 12000 && c.gokujo.yield_rank === 'A' && c.gokujo.unit === 300, JSON.stringify(c.gokujo));
  T('オス 33.3kg（切り捨て33）歩留まり24% → B → 1,650 − 引取3,000 → 0円（差額請求なし）', c.male_pickup.price === 0 && c.male_pickup.base === 3300 && c.male_pickup.ratio === 0.5 && c.male_pickup.weight_used === 33, JSON.stringify(c.male_pickup));
  T('メス並 28kg 歩留まり17.9% → C → 840円', c.female_c.price === 840 && c.female_c.yield_rank === 'C' && c.female_c.yield_pct === 17.9, JSON.stringify(c.female_c));
  T('精肉前（歩留まり無し）は未確定（0にしない）', c.pending.pending === true && c.pending.price === null && /精肉待ち/.test(c.pending.reason), JSON.stringify(c.pending));
  T('キョンは1頭1,000円', c.kyon.price === 1000, JSON.stringify(c.kyon));
  T('シカ 45kg 歩留まり33% → 4,500円', c.deer.price === 4500, JSON.stringify(c.deer));
  T('20kg未満は注意が付く（金額は式どおり）', c.small_w.price === 1800 && /20kg未満/.test(c.small_w.reason), JSON.stringify(c.small_w));
  T('オスは肉ランクに関係なく100円/kg', c.male_rank_ignored.unit === 100 && c.male_rank_ignored.price === 4000, JSON.stringify(c.male_rank_ignored));

  // 計算（画面）
  await page.evaluate(() => runCalc());
  await page.waitForTimeout(800);
  const ui = await page.evaluate(() => ({ heads: document.getElementById('kHeads').textContent, total: document.getElementById('kTotal').textContent, pending: document.getElementById('kPending').textContent, payees: document.getElementById('kPayees').textContent, payeesSub: document.getElementById('kPayeesSub').textContent,
    st: document.getElementById('statusBar').textContent, warn: document.getElementById('warnBox').textContent, rows: [...document.querySelectorAll('#payeeBody tr.payee-row')].map(tr => tr.textContent.replace(/\s+/g,' ')), summary: document.getElementById('summaryBox').textContent.replace(/\s+/g,' '),
    bank: [...document.querySelectorAll('#bankBody tr')].map(tr => tr.textContent.replace(/\s+/g,' ')) }));
  T('対象6頭（テスト個体は除外）', ui.heads === '6', ui.heads);
  T('井上定男 = T001 12,000 + T002 0 + T004 840（支払先指定）= 12,840円', ui.rows.some(r => /井上定男/.test(r) && /¥12,840/.test(r) && /捕獲者: 井上定男・山田千代子/.test(r)), ui.rows.join(' | '));
  T('山田千代子 = キョン1,000 + シカ4,500 = 5,500円、T003は未確定', ui.rows.some(r => /山田千代子/.test(r) && /¥5,500/.test(r) && /未確定1/.test(r)), ui.rows.join(' | '));
  T('合計 ¥18,340、未確定1、支払先2（口座あり1／なし1）', ui.total === '¥18,340' && ui.pending === '1' && ui.payees === '2' && /口座あり 1／口座なし 1/.test(ui.payeesSub), JSON.stringify([ui.total, ui.pending, ui.payees, ui.payeesSub]));
  T('警告: 未確定・口座なし（山田千代子）を隠さない', /未確定 1頭/.test(ui.warn) && /TGC-08-T003/.test(ui.warn) && /口座が無い支払先 1人/.test(ui.warn) && /山田千代子/.test(ui.warn), ui.warn.slice(0, 200));
  T('状態: 未確定があると警告表示', /warn|未確定/.test(ui.st), ui.st.slice(0, 100));
  T('受入頭数（別紙1用）: イノシシ4（館山市3・南房総市1）・キョン1・シカ1', /イノシシ ?3 ?1 ?4/.test(ui.summary.replace(/[^\dイノシシキョンシカ館山市南房総合計 ]/g,'')) || (/イノシシ/.test(ui.summary) && /南房総市/.test(ui.summary)), ui.summary.slice(0, 160));
  T('振込一覧: 井上（ＪＡ安房 館野支店 4111589 ¥12,840）と山田（未登録・赤）', ui.bank.some(r => /井上定男/.test(r) && /館野支店/.test(r) && /4111589/.test(r) && /¥12,840/.test(r)) && ui.bank.some(r => /山田千代子/.test(r) && /未登録/.test(r)), ui.bank.join(' | '));

  // 明細を開く
  await page.click('#payeeBody tr.payee-row td:first-child');
  const det = await page.evaluate(() => document.getElementById('det-0').style.display !== 'none' && document.getElementById('det-0').textContent);
  T('行をクリックすると個体の明細（極上・A・−¥3,000 など）が開く', det && /極上/.test(det) && /A（30%）/.test(det) && /−¥3,000/.test(det), String(det).slice(0, 200));

  // 調整
  await page.evaluate(() => setAdjust('山田千代子', 500, '前期の差額'));
  const adj = await page.evaluate(() => ({ total: document.getElementById('kTotal').textContent, row: [...document.querySelectorAll('#payeeBody tr.payee-row')].map(tr => tr.textContent.replace(/\s+/g,' ')).find(r => /^山田千代子/.test(r)) }));
  T('調整 +500 で山田 6,000円・合計 18,840円', /¥6,000/.test(adj.row) && adj.total === '¥18,840', JSON.stringify(adj));

  // 下書き保存
  await page.evaluate(() => saveRun('下書き'));
  await page.waitForTimeout(400);
  const save = calls.find(c => /buyback_runs/.test(c.u) && c.m === 'POST');
  T('下書き保存: buyback_runs に period_key/期間/状態/明細スナップショットを POST', save && save.b.period_key === 'R8H1' && save.b.from_date === '2026-04-01' && save.b.status === '下書き' && save.b.data.total === 18840 && save.b.data.payees.length === 2 && save.b.data.adjustments['山田千代子'].amount === 500 && save.b.note === 'テストメモ', JSON.stringify(save && { k: save.b.period_key, t: save.b.data.total, n: save.b.note }));

  // 通知書（window.open を差し替えて HTML を受け取る）
  const html = await page.evaluate(() => { let out = ''; const orig = window.open; window.open = () => ({ document: { write: h => { out += h; }, close(){} } }); try { printNotices(); } finally { window.open = orig; } return out; });
  T('通知書: 支払先ごとに「令和8年度上半期捕獲個体買取金のご通知」と合計金額', (html.match(/捕獲個体買取金のご通知/g)||[]).length === 2 && /井上定男　様/.test(html) && /12,840　円/.test(html) && /山田千代子　様/.test(html) && /6,000　円/.test(html), html.length);
  T('通知書: 文面（拝啓〜敬具・記・お問い合わせ先）と明細表', /拝啓/.test(html) && /敬具/.test(html) && /お問い合わせ先/.test(html) && /TGC-08-T001/.test(html) && /歩留まりランク A：3割以上/.test(html), '');
  T('通知書: 未確定の個体は「未確定」と出て金額は—', /未確定/.test(html) && /TGC-08-T003/.test(html), '');
  const ann = await page.evaluate(() => { let out = ''; const orig = window.open; window.open = () => ({ document: { write: h => { out += h; }, close(){} } }); try { printAnnouncement(); } finally { window.open = orig; } return out; });
  T('告知文: 別紙1（受入頭数）と別紙3（買取価格表・歩留まりランク・引取3,000円）', /別紙1/.test(ann) && /別紙3/.test(ann) && /300円\/kg/.test(ann) && /3,000円/.test(ann) && /南房総市/.test(ann), '');

  // ルール保存
  await page.evaluate(() => showTab('rules'));
  await page.fill('#r_fee', '2500');
  await page.evaluate(() => rulesSave());
  await page.waitForTimeout(300);
  const rs = calls.find(c => /app_settings/.test(c.u) && c.m === 'PATCH');
  T('ルール保存: app_settings buyback_rules に PATCH（引取2,500）', rs && rs.b.value.pickup_fee === 2500 && rs.b.value.boar.female_rank_unit['極上'] === 300, JSON.stringify(rs && rs.b.value.pickup_fee));
  const after = await page.evaluate(() => [...document.querySelectorAll('#payeeBody tr.payee-row')].map(tr => tr.textContent.replace(/\s+/g,' ')).find(r => /井上/.test(r)));
  T('ルール変更後は再計算（T002: 1,650−2,500 → 0 のまま）', /¥12,840/.test(after), after);

  // 過去の計算
  await page.evaluate(() => showTab('runs'));
  await page.waitForTimeout(300);
  const runs = await page.evaluate(() => document.getElementById('runsBody').textContent.replace(/\s+/g,' '));
  T('過去の計算: 保存済みが一覧に出る（R8H1・下書き・¥18,840）', /R8H1/.test(runs) && /下書き/.test(runs) && /¥18,840/.test(runs), runs.slice(0, 120));
  await page.evaluate(() => runOpen('run1'));
  await page.waitForTimeout(300);
  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
