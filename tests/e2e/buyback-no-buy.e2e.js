// 買取計算（buyback.html）: 譲受の個体は買取料金0円（2026-11-16）
//
//   きっかけ: 沖「石渡裕 キョンは譲受で買取料金0円／佐野徳幸 キョンは譲受で買取料金0円／鈴木政孝 全て譲受で買取料金0円」
//   ルール rules.no_buy = [{ name, species, from, to, note }]。species が空なら全獣種。
//
//   ここで測ること（捕獲者・個体は架空）
//     1. 名前と獣種が当たる個体は0円（理由が出る）
//     2. 獣種を決めた人の、ほかの獣種は今までどおり
//     3. 獣種が空の人は全部0円（精肉前・未確定でも0円で確定できる）
//     4. ほかの人は今までどおり。支払先の名前でも当たる
//     5. ルール画面で編集でき、保存の値に入る（ほかの項目は残る）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
const RULES = { boar:{ female_rank_unit:{'並':100,'上':200,'極上':300}, male_unit:100, yield_ranks:[{rank:'A',min_pct:30,ratio:1},{rank:'B',min_pct:20,ratio:0.5},{rank:'C',min_pct:10,ratio:0.3},{rank:'D',min_pct:0,ratio:0}], weight_floor:true, min_weight_kg:20 },
  deer:{unit:100,use_yield:true}, small:{price:1000,species:['キョン']}, pickup_fee:3000, source:'テスト',
  no_buy:[{ name:'架空 一郎', species:'キョン', note:'譲受' }, { name:'架空三郎', species:'', note:'譲受' }],
  pickup_free:[{ name:'架空 二郎', from:'2026-10-01', to:'2027-03-31', note:'引取料金なし' }] };
const I = o => Object.assign({ species:'イノシシ', capture_date:'2026-10-20', hunter_name:'架空一郎', purchase_payee:null, sex:'オス', weight_total:50, meat_rank:'並', yield_rate:40, stopkill_pickup:false, intake_method:'持込' }, o);
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext(); await ctx.addInitScript(() => sessionStorage.setItem('tg_role_v1', 'admin'));
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('dialog', d => d.accept());
  await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith('file:')) return r.continue(); const J = x => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) }); if (/app_settings/.test(u) && r.request().method() === 'GET') return J([{ key: 'buyback_rules', value: RULES }]); if (/\/rest\/v1\//.test(u)) return J([]); return r.fulfill({ status: 200, body: '' }); });
  await page.goto('file://' + path.resolve(__dirname, '../../buyback.html')); await page.waitForTimeout(600);
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);
  const c = (o) => page.evaluate(([R, i]) => { const x = calcOne(R, i, 0); return { price: x.price, pending: x.pending, reason: x.reason, nb: x.no_buy || '' }; }, [RULES, I(o)]);
  let r = await c({ species:'キョン' });
  T('1. 架空一郎のキョン → 0円・理由「譲受」', r.price === 0 && /譲受のため買取料金0円/.test(r.reason) && r.nb === '譲受', JSON.stringify(r));
  r = await c({});
  T('2. 架空一郎のイノシシは今までどおり（50×100×A=5,000）', r.price === 5000 && !r.nb, JSON.stringify(r));
  r = await c({ hunter_name:'架空三郎' });
  T('3. 架空三郎のイノシシ → 0円', r.price === 0 && r.nb, JSON.stringify(r));
  r = await c({ hunter_name:'架空三郎', species:'シカ', yield_rate:null, meat_rank:null });
  T('3. 架空三郎のシカ（歩留まり無し）→ 0円・未確定にしない', r.price === 0 && r.pending === false, JSON.stringify(r));
  r = await c({ hunter_name:'架空三郎', stopkill_pickup:true, intake_method:'引取', species:'キョン' });
  T('3. 引取でも0円（マイナスにしない）', r.price === 0, JSON.stringify(r));
  r = await c({ hunter_name:'架空四郎', species:'キョン' });
  T('4. ほかの人のキョンは今までどおり（1,000円）', r.price === 1000 && !r.nb, JSON.stringify(r));
  r = await c({ hunter_name:'架空四郎', purchase_payee:'架空三郎' });
  T('4. 支払先の名前でも当たる', r.price === 0, JSON.stringify(r));
  const rs = await page.evaluate(() => { showTab('rules'); const ta = document.getElementById('r_nobuy'); const before = ta.value; ta.value = before + '\n架空五郎,キョン、アライグマ,2026-10-01,,譲受'; const c = rulesCollect(); return { before, nb: c.no_buy, pf: c.pickup_free, fee: c.pickup_fee }; });
  T('5. ルール画面に今の設定が出る', /架空 一郎,キョン,,,譲受/.test(rs.before) && /架空三郎,,,,譲受/.test(rs.before), rs.before);
  T('5. 編集が保存の値に入る（引取料金なし・引取料金は残る）', rs.nb.length === 3 && rs.nb[2].species === 'キョン、アライグマ' && rs.nb[2].from === '2026-10-01' && rs.pf.length === 1 && rs.fee === 3000, JSON.stringify(rs));
  const r6 = await page.evaluate(R => calcOne(Object.assign({}, R, { no_buy: [{ name: '架空五郎', species: 'キョン、アライグマ' }] }), { species: 'アライグマ', capture_date: '2026-10-20', hunter_name: '架空五郎', weight_total: 5 }, 0).price, RULES);
  T('獣種は読点区切りで複数書ける', r6 === 0, r6);
  T('pageerrorなし', errors.length === 0, errors.join(' / '));
  await browser.close();
  let pass = 0; for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`); process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
