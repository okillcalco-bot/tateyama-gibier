// 直販出荷：受け渡し方法と送料を記録できる（請求書・納品書の送料欄の元になる）
//   2026-09-03 追記: 住所が分からない出荷先でも「届け先の地域」から送料を必ず出す。
//   送料が空のままの「発送」は確定しない（出荷35件中35件が送料空だった再発防止）。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const CUSTOMERS = [
  { name: '燗むすび', address: '東京都渋谷区1-2-3' },
  { name: '住所なし商店', address: null },
  { name: '大阪の店', address: '大阪府大阪市北区1-1' }
];
// 料金表（本番の shipping_rates と同じ形。関東と関西だけ）
const RATES = [
  { carrier: 'ヤマト', area: '関東', size_code: 60,  base_fee: 550,  cool_surcharge: 250 },
  { carrier: 'ヤマト', area: '関東', size_code: 100, base_fee: 900,  cool_surcharge: 400 },
  { carrier: 'ヤマト', area: '関東', size_code: 140, base_fee: 1290, cool_surcharge: null },
  { carrier: 'ヤマト', area: '関西', size_code: 100, base_fee: 1200, cool_surcharge: 400 },
  { carrier: '佐川',   area: '関東', size_code: 100, base_fee: 580,  cool_surcharge: 400 },
  { carrier: '佐川',   area: '関西', size_code: 100, base_fee: 800,  cool_surcharge: 400 }
];
const AREAS = [
  { carrier: 'ヤマト', pref: '東京都', area: '関東' }, { carrier: 'ヤマト', pref: '大阪府', area: '関西' },
  { carrier: '佐川',   pref: '東京都', area: '関東' }, { carrier: '佐川',   pref: '大阪府', area: '関西' }
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let shipPosts = [];
  let rpcCalls = 0;

  await page.route('**/*', route => {
    const u = route.request().url(), m = route.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (!/\/rest\/v1\//.test(u)) { if (u.startsWith('file:')) return route.continue(); return route.fulfill({ status: 200, body: '[]' }); }
    const J = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/rpc\/tgc_compute_freight/.test(u)) {
      rpcCalls++;
      let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      // 東京・100サイズ・クールなら 1500、それ以外は料金表になし(null)
      if (/東京/.test(b.p_address || '') && b.p_size === 100) return J(b.p_is_cool ? 1500 : 1100);
      return J(null);
    }
    if (/\/rpc\/staff_lookup_customer_id/.test(u)) return J('c1');
    if (m === 'POST' && /\/shipments/.test(u)) {
      try { shipPosts.push(JSON.parse(route.request().postData() || '{}')); } catch (e) {}
      return route.fulfill({ status: 201, contentType: 'application/json', body: '[{"id":"s1"}]' });
    }
    if (m === 'POST' && /\/orders/.test(u)) return route.fulfill({ status: 201, contentType: 'application/json', body: '[{"id":"o1"}]' });
    if (m === 'POST' || m === 'PATCH') return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    if (/\/shipping_rates/.test(u)) return J(RATES);
    if (/\/shipping_areas/.test(u)) return J(AREAS);
    if (/\/customers/.test(u)) return J(CUSTOMERS);
    return J([]);
  });
  await page.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  page.on('dialog', d => d.accept());

  const results = [];
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(700);
  // 顧客の住所表を読み込ませる
  await page.evaluate(async () => { if (typeof loadShipping === 'function') await loadShipping(); });
  await page.waitForTimeout(400);

  // 1) 既定は発送＝最初から送料欄が出ている（出荷の大半が発送のため）
  const init = await page.evaluate(() => ({
    method: document.getElementById('ship-direct-method').value,
    disp: document.getElementById('ship-direct-delivery').style.display,
    area: document.getElementById('ship-direct-area').value
  }));
  results.push(['既定は発送（送料あり）', init.method === '発送', init.method]);
  results.push(['最初から送料欄が出ている', init.disp === 'flex', init.disp]);
  results.push(['届け先の地域は既定で関東', init.area === '関東', init.area]);

  // 2) 手渡しに切り替えると送料欄が隠れ、金額もクリアされる
  await page.evaluate(() => {
    document.getElementById('ship-direct-freight').value = '999';
    document.getElementById('ship-direct-method').value = '手渡し';
    shipDirectMethodChange();
  });
  await page.waitForTimeout(200);
  const hid = await page.evaluate(() => ({
    disp: document.getElementById('ship-direct-delivery').style.display,
    v: document.getElementById('ship-direct-freight').value
  }));
  results.push(['手渡しで送料欄が隠れる', hid.disp === 'none', hid.disp]);
  results.push(['手渡しで金額がクリアされる', hid.v === '', hid.v]);

  // 発送へ戻す
  await page.evaluate(() => { document.getElementById('ship-direct-method').value = '発送'; shipDirectMethodChange(); });
  await page.waitForTimeout(300);
  const shown = await page.$eval('#ship-direct-delivery', el => el.style.display);
  results.push(['発送で送料欄が出る', shown === 'flex', shown]);

  // 3) 出荷先の住所から送料を自動計算（DBの計算＝クール1500）。地域も住所から選ばれる
  await page.evaluate(async () => {
    document.getElementById('ship-direct-cust').value = '燗むすび';
    await shipDirectFreightAuto(true);
  });
  await page.waitForTimeout(300);
  const auto = await page.evaluate(() => ({
    v: document.getElementById('ship-direct-freight').value,
    note: document.getElementById('ship-direct-freight-note').innerText,
    area: document.getElementById('ship-direct-area').value
  }));
  results.push(['住所から送料を自動計算', auto.v === '1500', auto.v]);
  results.push(['計算根拠を表示', /燗むすび/.test(auto.note) && /1,500/.test(auto.note), auto.note.slice(0, 60)]);
  results.push(['住所から地域も選ばれる', auto.area === '関東', auto.area]);

  // 4) クールを外すと再計算される（1100）
  await page.evaluate(async () => { document.getElementById('ship-direct-cool').checked = false; await shipDirectFreightAuto(true); });
  await page.waitForTimeout(250);
  results.push(['クール解除で再計算', await page.$eval('#ship-direct-freight', el => el.value) === '1100', '']);

  // 5) 住所が無い相手でも、届け先の地域（既定=関東）から送料が出る（ヤマト100クール = 900+400）
  await page.evaluate(async () => {
    document.getElementById('ship-direct-cust').value = '住所なし商店';
    document.getElementById('ship-direct-cool').checked = true;
    document.getElementById('ship-direct-freight').value = '';
    await shipDirectFreightAuto(true);
  });
  await page.waitForTimeout(250);
  const noaddr = await page.evaluate(() => ({
    v: document.getElementById('ship-direct-freight').value,
    note: document.getElementById('ship-direct-freight-note').innerText
  }));
  results.push(['住所不明でも地域から送料が出る', noaddr.v === '1300', noaddr.v]);
  results.push(['住所不明は「関東と仮定」と明示', /住所が分からない/.test(noaddr.note) && /関東/.test(noaddr.note), noaddr.note.slice(0, 60)]);

  // 5a) 地域を選び直すと再計算（関西 1200+400）
  await page.evaluate(async () => {
    document.getElementById('ship-direct-area').value = '関西';
    await shipDirectFreightAuto(true);
  });
  await page.waitForTimeout(250);
  results.push(['地域を選び直すと再計算', await page.$eval('#ship-direct-freight', el => el.value) === '1600',
    await page.$eval('#ship-direct-freight', el => el.value)]);

  // 5b) 運送会社を変えると地域の選択肢がその会社の区分になり、選択中の地域は保たれる（佐川 関西100クール = 800+400）
  await page.evaluate(async () => {
    document.getElementById('ship-direct-carrier').value = '佐川';
    shipDirectCarrierChange();
    await new Promise(r => setTimeout(r, 150));
  });
  await page.waitForTimeout(250);
  const sagawa = await page.evaluate(() => ({
    area: document.getElementById('ship-direct-area').value,
    opts: [...document.getElementById('ship-direct-area').options].map(o => o.value).join(','),
    v: document.getElementById('ship-direct-freight').value
  }));
  results.push(['運送会社を変えても地域は保たれる', sagawa.area === '関西', sagawa.area]);
  results.push(['地域の選択肢は運送会社の区分', sagawa.opts === '関東,関西', sagawa.opts]);
  results.push(['運送会社変更で再計算', sagawa.v === '1200', sagawa.v]);

  // 5c) 料金表に無い組み合わせ（ヤマト140クール）は空欄にして手入力を促す
  await page.evaluate(async () => {
    document.getElementById('ship-direct-carrier').value = 'ヤマト';
    shipDirectFillAreaOptions('関東');
    document.getElementById('ship-direct-size').value = '140';
    document.getElementById('ship-direct-cool').checked = true;
    await shipDirectFreightAuto(true);
  });
  await page.waitForTimeout(250);
  const none = await page.evaluate(() => ({
    v: document.getElementById('ship-direct-freight').value,
    note: document.getElementById('ship-direct-freight-note').innerText
  }));
  results.push(['料金表に無ければ空欄＋手入力を促す', none.v === '' && /直接入力/.test(none.note), none.note.slice(0, 60)]);

  // 5d) 自動計算の最中に手入力したら、あとから来た計算結果で上書きされない
  await page.evaluate(async () => {
    document.getElementById('ship-direct-size').value = '100';
    document.getElementById('ship-direct-cust').value = '燗むすび';
    document.getElementById('ship-direct-freight').value = '';
    const p = shipDirectFreightAuto(true);              // 計算を走らせておいて
    document.getElementById('ship-direct-freight').value = '3333';
    document.getElementById('ship-direct-freight').dispatchEvent(new Event('input'));  // その間に手入力
    await p;
  });
  await page.waitForTimeout(300);
  results.push(['計算中の手入力が上書きされない', await page.$eval('#ship-direct-freight', el => el.value) === '3333',
    await page.$eval('#ship-direct-freight', el => el.value)]);

  // 6) 出荷確定で運送会社・サイズ・クール・送料が保存される
  await page.evaluate(async () => {
    shipDirectItems = [{ id: 'v1', ident_code: 'TGC-08-M167-RO', part_name: 'ロース', weight: 2.1, species: 'イノシシ' }];
    document.getElementById('ship-direct-cust').value = '燗むすび';
    document.getElementById('ship-direct-method').value = '発送';
    shipDirectMethodChange();
    document.getElementById('ship-direct-carrier').value = '佐川';
    shipDirectFillAreaOptions('関東');
    document.getElementById('ship-direct-size').value = '140';
    document.getElementById('ship-direct-cool').checked = true;
    document.getElementById('ship-direct-freight').value = '2200';
    document.getElementById('ship-direct-freight').dispatchEvent(new Event('input'));
    await shipDirectConfirm();
  });
  await page.waitForTimeout(500);
  const sp = shipPosts[shipPosts.length - 1] || {};
  results.push(['出荷に運送会社を保存', sp.carrier === '佐川', String(sp.carrier)]);
  results.push(['出荷にサイズを保存(数値)', sp.size_code === 140, String(sp.size_code)]);
  results.push(['出荷にクール便を保存', sp.is_cool === true, String(sp.is_cool)]);
  results.push(['出荷に送料を保存', sp.freight === 2200, String(sp.freight)]);

  // 6b) 送料が空のまま確定しても、確定直前に自動計算されて保存される（住所不明→関東）
  shipPosts = [];
  await page.evaluate(async () => {
    shipDirectItems = [{ id: 'v3', ident_code: 'TGC-08-M167-BA', part_name: 'バラ', weight: 1.5, species: 'イノシシ' }];
    document.getElementById('ship-direct-cust').value = '住所なし商店';
    document.getElementById('ship-direct-carrier').value = 'ヤマト';
    shipDirectFillAreaOptions('関東');
    document.getElementById('ship-direct-size').value = '100';
    document.getElementById('ship-direct-cool').checked = true;
    document.getElementById('ship-direct-freight').value = '';
    document.getElementById('ship-direct-freight').dispatchEvent(new Event('input'));
    await shipDirectConfirm();
  });
  await page.waitForTimeout(500);
  const sp3 = shipPosts[shipPosts.length - 1] || {};
  results.push(['空のまま確定→直前に自動計算して保存', sp3.freight === 1300, String(sp3.freight)]);

  // 6c) 自動計算もできない（料金表に無い）まま空なら、確定しない＝送料なしの発送を黙って記録しない
  shipPosts = [];
  const before = await page.evaluate(async () => {
    shipDirectItems = [{ id: 'v4', ident_code: 'TGC-08-M167-KT', part_name: 'カタ', weight: 1.0, species: 'イノシシ' }];
    document.getElementById('ship-direct-cust').value = '住所なし商店';
    document.getElementById('ship-direct-carrier').value = 'ヤマト';
    shipDirectFillAreaOptions('関東');
    document.getElementById('ship-direct-size').value = '140';   // ヤマト140クールは料金表に無い
    document.getElementById('ship-direct-cool').checked = true;
    document.getElementById('ship-direct-freight').value = '';
    document.getElementById('ship-direct-freight').dispatchEvent(new Event('input'));
    shipDirectUpdateConfirm();   // 商品と出荷先が揃っているので押せる状態
    await shipDirectConfirm();
    return document.getElementById('ship-direct-confirm').disabled;
  });
  await page.waitForTimeout(400);
  results.push(['送料が出せないまま空なら確定しない', shipPosts.length === 0, String(shipPosts.length)]);
  results.push(['確定ボタンは押せるまま（やり直せる）', before === false, String(before)]);

  // 7) 手渡しなら送料は保存されない
  shipPosts = [];
  await page.evaluate(async () => {
    shipDirectItems = [{ id: 'v2', ident_code: 'TGC-08-M167-KT', part_name: 'カタ', weight: 1.0, species: 'イノシシ' }];
    document.getElementById('ship-direct-cust').value = '燗むすび';
    document.getElementById('ship-direct-method').value = '手渡し';
    shipDirectMethodChange();
    await shipDirectConfirm();
  });
  await page.waitForTimeout(500);
  const sp2 = shipPosts[shipPosts.length - 1] || {};
  results.push(['手渡しでは送料を入れない', sp2.freight === undefined && sp2.carrier === undefined, JSON.stringify({ f: sp2.freight, c: sp2.carrier })]);
  results.push(['手渡しでも出荷は記録される', !!sp2.order_id, String(sp2.order_id)]);

  results.push(['pageerrorなし', errors.length === 0, errors.join(' / ')]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' && got != null ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
