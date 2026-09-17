// 猪肉のLCA（lca.html）：年度の入力（算出方法タブ）と係数（出典つき）から、肉1kgあたりの kg-CO2e を出す
//   1. 令和5年度の入力（資料の値）で 4〜5.5 kg-CO2e/kg の範囲、牛肉の 1/4〜1/6
//   2. 内訳に 電力・残渣・罠・ガソリン・宅配・調理 の行があり、割合の合計が100%
//   3. 入力を保存すると lca_inputs に PATCH。係数を変えると結果が変わり、app_settings に保存
//   4. 「台帳から入れる」で頭数・肉量・往復距離（地区の実走行 km）が入る。失敗は画面に出る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const COEF = { source:'猪肉のLCA_20241010.xlsx（IDEA 3.2.0）', items:[
  {key:'electricity',name:'電力',value:0.549,unit:'kg-CO2e/kWh'},{key:'water',name:'上水道',value:0.336,unit:'kg-CO2e/m3'},{key:'sewage',name:'下水道処理',value:0.517,unit:'kg-CO2e/m3'},{key:'residue',name:'産廃処理（動植物性残渣）',value:0.218,unit:'kg-CO2e/kg'},{key:'truck10t',name:'トラック輸送 10t',value:0.162,unit:'kg-CO2e/tkm'},{key:'keitora',name:'軽トラック',value:2.43,unit:'kg-CO2e/tkm'},{key:'gasoline',name:'ガソリン燃焼',value:2.32,unit:'kg-CO2e/L'},{key:'stainless',name:'ステンレス鋼',value:4.84,unit:'kg-CO2e/kg'},{key:'steel',name:'その他の鉄鋼品',value:0.00665,unit:'kg-CO2e/kg'},{key:'cardboard',name:'段ボール',value:0.622,unit:'kg-CO2e/m2'},{key:'eps',name:'発泡ポリスチレン',value:3.72,unit:'kg-CO2e/kg'},{key:'metal_waste',name:'産廃処理 金属くず',value:0.0429,unit:'kg-CO2e/kg'},{key:'cooking',name:'調理・飲食（共通）',value:0.93,unit:'kg-CO2e/kg'}],
  reference:{ source:'猪肉のLCA_20241010.xlsx 試算結果', items:[{name:'牛肉',total:19.70,material:18.70,processing:0,cooking:0.91,eating:0.02},{name:'豚肉',total:5.31,material:4.39,processing:0,cooking:0.91,eating:0.02},{name:'鶏肉',total:3.05,material:2.13,processing:0,cooking:0.91,eating:0.02},{name:'ジビエ肉（館山・R5実績）',total:4.30,material:1.33,processing:2.05,cooking:0.91,eating:0.02}] } };
const INPUT_R5 = { heads:603, heads_boar:518, meat_kg:7802, box_traps:1, rice_bran_kg:10, residue_kg:12242, residue_km_roundtrip:74.6, electricity_kwh:19546.4, water_m3:145.3, trap_set_km:25, trap_set_times:6, patrol_km:25, patrol_times:48, haul_km_total:7803, fuel_km_per_l:14, gasoline_l:557, snare_stainless_kg_per_kg:0.2667, snare_life_times:3, packing_cardboard_m2_per_kg:0.26, packing_eps_kg_per_kg:0.11, distribution_tkm_per_kg:0.31929 };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const calls = []; let failView = false;
  await page.route('**/*', r => {
    const u = decodeURIComponent(r.request().url()), m = r.request().method();
    if (u.startsWith('file:')) return r.continue();
    if (/fonts\./.test(u)) return r.fulfill({ status: 200, body: '' });
    const J = (x, st) => r.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m !== 'GET') { let b = null; try { b = JSON.parse(r.request().postData()||'null'); } catch(e) {} calls.push({ m, u, b }); return J([b]); }
    if (/app_settings/.test(u)) return J([{ key:'lca_coefficients', value: COEF }]);
    if (/lca_inputs/.test(u)) return J([{ fiscal_year: 5, data: INPUT_R5, note: '資料の値' }]);
    if (/v_individuals_all/.test(u)) { if (failView) return r.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' }); return J([{ label_id:'TGC-08-T001', species:'イノシシ', city:'館山市', area:'神余', weight:40 }, { label_id:'TGC-08-T002', species:'イノシシ', city:'館山市', area:'大井', weight:50 }, { label_id:'TGC-08-キ001', species:'キョン', city:'館山市', area:'山本', weight:8 }, { label_id:'TGC-08-T003', species:'イノシシ', city:'南房総市', area:'宮下', weight:30 }]); }
    if (/\/inventory/.test(u)) return J([{ individual_id:'TGC-08-T001', weight:12, weight_kg:12 }, { individual_id:'TGC-08-T002', weight:15, weight_kg:15 }, { individual_id:'TGC-08-T999', weight:99, weight_kg:99 }]);
    if (/area_master/.test(u)) return J([{ city:'館山市', oaza:'神余', road_km_roundtrip:6 }, { city:'館山市', oaza:'大井', road_km_roundtrip:28 }, { city:'館山市', oaza:'山本', road_km_roundtrip:15 }]);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../lca.html'));
  await page.waitForTimeout(700);
  const results = []; const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  const r5 = await page.evaluate(() => ({ year: document.getElementById('fYear').value, total: document.getElementById('kTotal').textContent, beef: document.getElementById('kBeef').textContent, pork: document.getElementById('kPork').textContent, top: document.getElementById('kTop').textContent, detail: document.getElementById('detailBox').textContent.replace(/\s+/g,' '), cmp: document.getElementById('cmpBox').textContent, calc: calc(INPUTS[5]) }));
  T('既定の年度は入力のある令和5年度', r5.year === '5', r5.year);
  T('令和5年度: 4〜5.5 kg-CO2e/kg（資料の試算 4.30 ＋ガソリン燃焼を加えた分）', parseFloat(r5.total) >= 4 && parseFloat(r5.total) <= 5.5, r5.total);
  T('牛肉の約1/4〜1/6、豚肉と同程度', /約 1\/[3-6]\.\d/.test(r5.beef) && /約 (1\/1\.\d|\d\.\d倍)/.test(r5.pork), JSON.stringify([r5.beef, r5.pork]));
  T('内訳に 電力・残渣・くくり罠・ガソリン・宅配・調理 の行がある', ['電力','残渣（産廃処理）','くくり罠','輸送（軽トラ・ガソリン）','宅配','調理・飲食'].every(s => r5.detail.includes(s)), r5.detail.slice(0, 200));
  T('一番大きい要因は電力かくくり罠', /電力|くくり罠/.test(r5.top), r5.top);
  const pct = r5.calc.rows.reduce((s,x)=>s+x.co2,0);
  T('内訳の合計 = 総量（割合は100%）', Math.abs(pct - r5.calc.total) < 1e-9 && /100%/.test(r5.detail), String(r5.calc.total));
  T('電力 = 19546.4 kWh ÷ 7802 kg × 0.549 ≒ 1.375', Math.abs(r5.calc.rows.find(x=>x.name==='電力').co2 - 1.375) < 0.01, String(r5.calc.rows.find(x=>x.name==='電力').co2));
  T('ガソリン = 557 L ÷ 7802 × 2.32 ≒ 0.166（実績Lを優先）', Math.abs(r5.calc.rows.find(x=>/ガソリン/.test(x.name)).co2 - 0.1656) < 0.005 && Math.round(r5.calc.gasL) === 557, String(r5.calc.gasL));
  T('比較表に 牛・豚・鶏 と「館山・令和5年度・この入力」の行', /牛肉/.test(r5.cmp) && /鶏肉/.test(r5.cmp) && /令和5年度・この入力/.test(r5.cmp), '');

  // 入力を変えて保存
  await page.evaluate(() => showTab('input'));
  await page.fill('#inForm input[data-k="electricity_kwh"]', '10000');
  await page.evaluate(() => saveInputs());
  await page.waitForTimeout(300);
  const sv = calls.find(c => /lca_inputs/.test(c.u) && c.m === 'PATCH');
  const t2 = await page.evaluate(() => parseFloat(document.getElementById('kTotal').textContent));
  T('入力を保存: lca_inputs に PATCH（electricity_kwh=10000）し、結果が下がる', sv && sv.b.data.electricity_kwh === 10000 && t2 < parseFloat(r5.total), JSON.stringify([sv && sv.b.data.electricity_kwh, t2]));

  // 係数を変えて保存
  await page.evaluate(() => showTab('coef'));
  const idx = await page.evaluate(() => COEF.items.findIndex(i => i.key === 'cooking'));
  await page.fill(`#coBody input[data-ci="${idx}"]`, '0');
  await page.evaluate(() => saveCoef());
  await page.waitForTimeout(300);
  const cs = calls.find(c => /app_settings/.test(c.u) && c.m === 'PATCH');
  const t3 = await page.evaluate(() => parseFloat(document.getElementById('kTotal').textContent));
  T('係数を保存: app_settings lca_coefficients に PATCH、調理0 で総量が 0.93 下がる', cs && cs.b.value.items.find(i=>i.key==='cooking').value === 0 && Math.abs((t2 - t3) - 0.93) < 0.02, JSON.stringify([t2, t3]));

  // 台帳から入れる（令和8年度）
  await page.selectOption('#fYear', '8');
  await page.evaluate(() => fillFromDb());
  await page.waitForTimeout(600);
  const fb = await page.evaluate(() => ({ heads: document.querySelector('#inForm input[data-k="heads"]').value, boar: document.querySelector('#inForm input[data-k="heads_boar"]').value, meat: document.querySelector('#inForm input[data-k="meat_kg"]').value, haul: document.querySelector('#inForm input[data-k="haul_km_total"]').value, st: document.getElementById('statusBar').textContent }));
  T('台帳から: 受入4頭・イノシシ3・肉27kg（在庫の精肉重量、対象外の個体は数えない）・往復 6+28+15=49km（宮下は距離未登録）', fb.heads === '4' && fb.boar === '3' && fb.meat === '27' && fb.haul === '49' && /3頭分/.test(fb.st), JSON.stringify(fb));
  failView = true; await page.evaluate(() => fillFromDb()); await page.waitForTimeout(300);
  T('集計の失敗は画面に出る', /集計できませんでした/.test(await page.evaluate(() => document.getElementById('statusBar').textContent)), '');
  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
