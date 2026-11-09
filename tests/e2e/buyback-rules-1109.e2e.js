// 買取計算（buyback.html）: 2026-11-09 の決定を既定にする
//
//   沖さんの決定（2026-11-09）
//     ・未確定（歩留まりが出ていない個体）は A へ
//     ・精肉時に受入と違うランクが付いた個体は多数決でランク付け（従来どおり）
//     ・肉ランク未設定は並として計算（従来どおり）
//     ・口座が無い支払先には、送れるメッセージが出せるボタンを準備
//     ・20kg未満は買取なし
//
//   ここで測ること（捕獲者・個体はすべて架空）。保存済みのルールに新しい項目が無くても、決定どおりに計算する
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

// 保存済みのルール（新しい項目 pending_yield_rank / below_min_no_buy は無い＝本番と同じ状態）
const RULES = { boar:{ female_rank_unit:{'並':100,'上':200,'極上':300}, male_unit:100, yield_ranks:[{rank:'A',min_pct:30,ratio:1},{rank:'B',min_pct:20,ratio:0.5},{rank:'C',min_pct:10,ratio:0.3},{rank:'D',min_pct:0,ratio:0}], weight_floor:true, min_weight_kg:20 }, deer:{unit:100,use_yield:true}, small:{price:1000,species:['キョン']}, pickup_fee:3000, source:'テスト' };
const HUNTERS = [
  { id:'h1', name:'架空太郎', bank_name:'架空銀行', bank_branch:'本店', account_type:'普通', account_number:'1234567', payee_no:1 },
  { id:'h2', name:'架空花子', bank_name:null, account_number:null, payee_no:2 },
];
const IND = (id, label, o) => Object.assign({ id, label_id: label, species:'イノシシ', capture_date:'2026-10-05', capture_city:'館山市', hunter_name:'架空太郎', purchase_payee:null, sex:'メス', weight_total:40, meat_rank:'並', yield_rate:null, stopkill_pickup:false, intake_method:'搬入', processing_done_at:'2026-10-06T02:00:00Z', buyback_amount:null }, o);
const INDS = [
  IND('i1', 'TGC-08-T901', { weight_total:40, meat_rank:'並' }),                                           // 精肉済み 13kg/40kg=32.5% → A → 4,000
  IND('i2', 'TGC-08-T902', { weight_total:50, meat_rank:null, processing_done_at:null, hunter_name:'架空花子' }), // 精肉前・ランク未設定 → 並・A扱い → 5,000
  IND('i3', 'TGC-08-T903', { weight_total:18.5, meat_rank:'並' }),                                          // 20kg未満 → 買取なし
  IND('i4', 'TGC-08-T904', { weight_total:30, meat_rank:'並', hunter_name:'架空花子' }),                     // 部位は上2・並1 → 多数決で上 → 30×200×A = 6,000
  IND('i5', 'TGC-08-シ901', { species:'シカ', weight_total:40, meat_rank:null, processing_done_at:null, hunter_name:'架空花子' }), // シカ精肉前 → A扱い → 4,000
];
const INV = [
  { individual_id:'TGC-08-T901', part_name:'ロース', grade:'並', weight:13, weight_kg:13 },
  { individual_id:'TGC-08-T903', part_name:'モモ', grade:'並', weight:6, weight_kg:6 },
  { individual_id:'TGC-08-T904', part_name:'ロース', grade:'上', weight:5, weight_kg:5, processed_by:'架空作業者' },
  { individual_id:'TGC-08-T904', part_name:'バラ', grade:'上', weight:4, weight_kg:4, processed_by:'架空作業者' },
  { individual_id:'TGC-08-T904', part_name:'モモ', grade:'並', weight:1, weight_kg:1 },
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext(); await ctx.addInitScript(() => sessionStorage.setItem('tg_role_v1', 'admin'));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.route('**/*', r => {
    const u = decodeURIComponent(r.request().url()), m = r.request().method();
    if (u.startsWith('file:')) return r.continue();
    if (/fonts\./.test(u)) return r.fulfill({ status: 200, body: '' });
    const J = x => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (/rpc\/staff_hunters_private/.test(u)) return J(HUNTERS);
    if (m !== 'GET') return J([]);
    if (/app_settings/.test(u)) return J([{ key: 'buyback_rules', value: RULES }]);
    if (/\/hunters/.test(u)) return J(HUNTERS.map(h => ({ id: h.id, name: h.name })));
    if (/\/individuals/.test(u)) return J(INDS);
    if (/\/inventory/.test(u)) return J(INV);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../buyback.html'));
  await page.waitForTimeout(700);
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

  await page.selectOption('#fYear', '8'); await page.selectOption('#fHalf', 'H2');
  await page.evaluate(() => { fillPeriod(); });
  await page.evaluate(() => runCalc());
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => {
    const by = {}; D.result.items.forEach(i => { by[i.label] = { price: i.price, pending: i.pending, rank: i.rank, yr: i.yield_rank, assumed: !!i.yield_assumed, reason: i.reason }; });
    return { by, pending: D.result.pending, total: D.result.total, warn: document.getElementById('warnBox').innerText, kPending: document.getElementById('kPending').textContent };
  });
  const B = r.by;
  T('未確定（精肉前）は A として計算する（50kg×並100円×A=5,000円）', B['TGC-08-T902'] && B['TGC-08-T902'].price === 5000 && B['TGC-08-T902'].yr === 'A' && B['TGC-08-T902'].assumed && !B['TGC-08-T902'].pending, JSON.stringify(B['TGC-08-T902']));
  T('シカの精肉前も A として計算する（40kg×100円=4,000円）', B['TGC-08-シ901'] && B['TGC-08-シ901'].price === 4000 && B['TGC-08-シ901'].assumed, JSON.stringify(B['TGC-08-シ901']));
  T('未確定の頭数は0になる（確定のときに0円で確定されない）', r.pending === 0 && r.kPending === '0', JSON.stringify([r.pending, r.kPending]));
  T('肉ランク未設定は並として計算する', B['TGC-08-T902'] && B['TGC-08-T902'].rank === '並', JSON.stringify(B['TGC-08-T902']));
  T('20kg未満は買取なし（0円）', B['TGC-08-T903'] && B['TGC-08-T903'].price === 0 && /20kg未満のため買取なし/.test(B['TGC-08-T903'].reason), JSON.stringify(B['TGC-08-T903']));
  T('受入と違うランクは多数決（上2・並1 → 上で 30×200=6,000円）', B['TGC-08-T904'] && B['TGC-08-T904'].rank === '上' && B['TGC-08-T904'].price === 6000, JSON.stringify(B['TGC-08-T904']));
  T('歩留まりが出ている個体は従来どおり（32.5%→A・4,000円）', B['TGC-08-T901'] && B['TGC-08-T901'].price === 4000 && !B['TGC-08-T901'].assumed, JSON.stringify(B['TGC-08-T901']));
  T('合計 = 4,000+5,000+0+6,000+4,000 = 19,000円', r.total === 19000, r.total);
  T('警告: 歩留まり未確定の頭数と「Aとして計算」を出す', /歩留まり未確定 2頭/.test(r.warn) && /Aとして計算/.test(r.warn), r.warn.slice(0, 300));
  T('警告: 20kg未満は「買取なし・0円」と出す', /20kg未満 1頭（買取なし・0円）/.test(r.warn), r.warn.slice(0, 300));

  // 口座が無い支払先への文面
  const m = await page.evaluate(async () => {
    const btn = [...document.querySelectorAll('#warnBox button')].find(b => /口座を教えてもらう文面/.test(b.textContent));
    if (!btn) return { btn: false };
    btn.click(); await new Promise(r => setTimeout(r, 100));
    const box = document.getElementById('noAccBox');
    const ts = [...box.querySelectorAll('textarea.noacc-msg')].map(t => t.value);
    let copied = '';
    try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async t => { copied = t; } }, configurable: true }); } catch (e) {}
    await noAccCopyAll();
    return { btn: true, n: ts.length, first: ts[0] || '', copied };
  });
  T('口座が無い支払先に、文面を作るボタンがある', m.btn, JSON.stringify(m).slice(0, 100));
  T('文面は口座の無い人（架空花子）だけ・口座のある人には作らない', m.n === 1 && /架空花子 様/.test(m.first) && !/架空太郎/.test(m.first), m.first.slice(0, 60));
  T('文面に期間・頭数と、教えてほしい項目（銀行名・支店名・種類・口座番号・名義カナ）', /令和8年度下半期/.test(m.first) && /3頭分/.test(m.first) && /銀行名/.test(m.first) && /支店名/.test(m.first) && /口座番号/.test(m.first) && /カタカナ/.test(m.first), m.first);
  T('文面に金額は書かない（後で変わることがあるため）', !/円/.test(m.first.replace(/館山ジビエセンター/g, '')), m.first);
  T('まとめてコピーできる', /架空花子 様/.test(m.copied), m.copied.slice(0, 40));

  // 支払先ごとの表（👁 表で見る）: 歩留まり未確定をAで計算していることを本人向けの表にも出す
  const view = await page.evaluate(async () => {
    const idx = D.result.payees.findIndex(p => p.payee === '架空花子');
    noticeViewOpen(idx); await new Promise(r => setTimeout(r, 100));
    return document.getElementById('nvBody').innerText;
  });
  T('表で見る: 精肉待ち2頭を歩留まりAとして計算していると出す', /精肉待ち（歩留まりが出ていない）の個体が 2頭/.test(view) && /歩留まりAとして計算/.test(view), view.slice(0, 300));
  await page.keyboard.press('Escape');

  // ルール画面: 新しい項目が出て、保存に入る
  const rs = await page.evaluate(() => { showTab('rules'); const c = rulesCollect(); return { pend: c.pending_yield_rank, nobuy: c.boar.below_min_no_buy, sel: !!document.getElementById('r_pend'), chk: !!document.getElementById('r_minw_nobuy') }; });
  T('ルール画面: 「歩留まりが出ていない個体のランク」(A)と「最低体重未満は買取なし」(on)', rs.sel && rs.chk && rs.pend === 'A' && rs.nobuy === true, JSON.stringify(rs));

  T('pageerrorなし', errors.length === 0, errors.join(' / '));
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 260) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
