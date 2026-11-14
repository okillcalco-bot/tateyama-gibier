// 買取計算（buyback.html）: 人と期間を決めて、現場引取の料金をかけない（2026-11-14）
//
//   きっかけ: 沖「今年度の下半期で山川弘恭さんから引き取りしてるのは、引き取り料金が掛からない」
//   ルール rules.pickup_free = [{ name, from, to, note }] で、捕獲者（支払先があれば支払先）と捕獲日で当てる。
//
//   ここで測ること（捕獲者・個体は架空）
//     1. 期間内の引取は天引きしない（3,000円を引かない）
//     2. 期間外の引取・ほかの人の引取は今までどおり天引きする
//     3. 表に「0（理由）」と出る
//     4. ルール画面で編集でき、保存の内容に入る（ほかの項目を消さない）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const RULES = { boar:{ female_rank_unit:{'並':100,'上':200,'極上':300}, male_unit:100, yield_ranks:[{rank:'A',min_pct:30,ratio:1},{rank:'B',min_pct:20,ratio:0.5},{rank:'C',min_pct:10,ratio:0.3},{rank:'D',min_pct:0,ratio:0}], weight_floor:true, min_weight_kg:20 },
  deer:{unit:100,use_yield:true}, small:{price:1000,species:['キョン']}, pickup_fee:3000, source:'テスト',
  pickup_free:[{ name:'架空 一郎', from:'2026-10-01', to:'2027-03-31', note:'令和8年度下半期は引取料金なし' }] };
const HUNTERS = [{ id:'h1', name:'架空一郎', payee_no:1 }, { id:'h2', name:'架空二郎', payee_no:2 }];
const IND = (id, label, o) => Object.assign({ id, label_id: label, species:'イノシシ', capture_date:'2026-10-20', capture_city:'館山市', hunter_name:'架空一郎', purchase_payee:null, sex:'オス', weight_total:50, meat_rank:'並', yield_rate:40, stopkill_pickup:true, intake_method:'引取', processing_done_at:'2026-10-21T02:00:00Z', buyback_amount:null }, o);
const INDS = [
  IND('i1', 'TGC-08-T901'),                                                  // 期間内・引取 → 50×100×A=5,000（天引きなし）
  IND('i2', 'TGC-08-T902', { capture_date:'2026-09-20' }),                  // 期間外（上半期）→ 5,000−3,000=2,000 … ただし下半期の集計には入らない
  IND('i3', 'TGC-08-T903', { hunter_name:'架空二郎' }),                      // ほかの人 → 2,000
  IND('i4', 'TGC-08-T904', { stopkill_pickup:false, intake_method:'持込' }), // 持込 → 5,000
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext(); await ctx.addInitScript(() => sessionStorage.setItem('tg_role_v1', 'admin'));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  const saved = [];
  await page.route('**/*', r => {
    const u = decodeURIComponent(r.request().url()), m = r.request().method();
    if (u.startsWith('file:')) return r.continue();
    const J = x => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (!/\/rest\/v1\//.test(u)) return r.fulfill({ status: 200, body: '' });
    if (/rpc\/staff_hunters_private/.test(u)) return J(HUNTERS);
    if (m !== 'GET') { if (/app_settings/.test(u)) { try { saved.push(JSON.parse(r.request().postData())); } catch (e) {} } return J([{}]); }
    if (/app_settings/.test(u)) return J([{ key: 'buyback_rules', value: RULES }]);
    if (/\/hunters/.test(u)) return J(HUNTERS);
    if (/\/individuals/.test(u)) { const from = (u.match(/capture_date=gte\.([\d-]+)/) || [])[1] || '', to = (u.match(/capture_date=lte\.([\d-]+)/) || [])[1] || '9999'; return J(INDS.filter(i => i.capture_date >= from && i.capture_date <= to)); }
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../buyback.html'));
  await page.waitForTimeout(700);
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

  // calcOne を直接（期間外の個体も含めて）
  const c = await page.evaluate(inds => inds.map(i => { const x = calcOne(RULES, i, 0); return { l: i.label_id, price: x.price, fee: x.pickup_fee, free: x.pickup_free }; }), INDS);
  const by = Object.fromEntries(c.map(x => [x.l, x]));
  T('1. 期間内の引取は天引きしない（5,000円）', by['TGC-08-T901'].price === 5000 && by['TGC-08-T901'].fee === 0 && /下半期/.test(by['TGC-08-T901'].free), JSON.stringify(by['TGC-08-T901']));
  T('2. 期間外（上半期）の引取は天引きする（2,000円）', by['TGC-08-T902'].price === 2000 && by['TGC-08-T902'].fee === 3000 && !by['TGC-08-T902'].free, JSON.stringify(by['TGC-08-T902']));
  T('2. ほかの人の引取は天引きする（2,000円）', by['TGC-08-T903'].price === 2000 && by['TGC-08-T903'].fee === 3000, JSON.stringify(by['TGC-08-T903']));
  T('2. 持込は今までどおり（5,000円）', by['TGC-08-T904'].price === 5000 && by['TGC-08-T904'].fee === 0, JSON.stringify(by['TGC-08-T904']));
  const c2 = await page.evaluate(i => calcOne(RULES, Object.assign({}, i, { hunter_name: '架空三郎', purchase_payee: '架空 一郎' }), 0).pickup_fee, INDS[0]);
  T('支払先が決まっていれば支払先の名前で当てる（空白の違いは無視）', c2 === 0, c2);

  // 画面の計算と表
  await page.selectOption('#fYear', '8'); await page.selectOption('#fHalf', 'H2');
  await page.evaluate(() => { fillPeriod(); }); await page.evaluate(() => runCalc()); await page.waitForTimeout(500);
  const r = await page.evaluate(() => ({ total: D.result.total, html: document.body.innerText }));
  T('下半期の合計 = 5,000 + 2,000 + 5,000 = 12,000円', r.total === 12000, r.total);
  const view = await page.evaluate(async () => { const idx = D.result.payees.findIndex(p => /架空.?一郎/.test(p.payee)); noticeViewOpen(idx); await new Promise(r => setTimeout(r, 100)); return document.getElementById('nvBody').innerText; });
  T('3. 本人向けの表に「0（引取料金なし）」と出る', /0（引取料金なし）/.test(view), view.slice(0, 300));

  // ルール画面
  const rs = await page.evaluate(() => { showTab('rules'); const ta = document.getElementById('r_free'); const before = ta.value; ta.value = before + '\n架空 二郎,2026-12-01,2026-12-31,テスト'; const c = rulesCollect(); return { before, free: c.pickup_free, fee: c.pickup_fee, src: c.source }; });
  T('4. ルール画面に今の設定が出る', /架空 一郎,2026-10-01,2027-03-31,令和8年度下半期は引取料金なし/.test(rs.before), rs.before);
  T('4. 編集した内容が保存の値に入る（ほかの項目は残る）', rs.free.length === 2 && rs.free[1].name === '架空 二郎' && rs.free[1].from === '2026-12-01' && rs.fee === 3000 && rs.src === 'テスト', JSON.stringify(rs));

  T('pageerrorなし', errors.length === 0, errors.join(' / '));
  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 260) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
