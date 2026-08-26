// 直販出荷：受け渡し方法と送料を記録できる（請求書・納品書の送料欄の元になる）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const CUSTOMERS = [
  { name: '燗むすび', address: '東京都渋谷区1-2-3' },
  { name: '住所なし商店', address: null }
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let shipPosts = [];

  await page.route('**/*', route => {
    const u = route.request().url(), m = route.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (!/\/rest\/v1\//.test(u)) { if (u.startsWith('file:')) return route.continue(); return route.fulfill({ status: 200, body: '[]' }); }
    const J = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/rpc\/tgc_compute_freight/.test(u)) {
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
    disp: document.getElementById('ship-direct-delivery').style.display
  }));
  results.push(['既定は発送（送料あり）', init.method === '発送', init.method]);
  results.push(['最初から送料欄が出ている', init.disp === 'flex', init.disp]);

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
  await page.waitForTimeout(200);
  const shown = await page.$eval('#ship-direct-delivery', el => el.style.display);
  results.push(['発送で送料欄が出る', shown === 'flex', shown]);

  // 3) 出荷先の住所から送料を自動計算（クール1500）
  await page.evaluate(async () => {
    document.getElementById('ship-direct-cust').value = '燗むすび';
    await shipDirectFreightAuto(true);
  });
  await page.waitForTimeout(300);
  const auto = await page.evaluate(() => ({
    v: document.getElementById('ship-direct-freight').value,
    note: document.getElementById('ship-direct-freight-note').innerText
  }));
  results.push(['住所から送料を自動計算', auto.v === '1500', auto.v]);
  results.push(['計算根拠を表示', /燗むすび/.test(auto.note) && /1,500/.test(auto.note), auto.note.slice(0, 60)]);

  // 4) クールを外すと再計算される（1100）
  await page.evaluate(async () => { document.getElementById('ship-direct-cool').checked = false; await shipDirectFreightAuto(true); });
  await page.waitForTimeout(250);
  results.push(['クール解除で再計算', await page.$eval('#ship-direct-freight', el => el.value) === '1100', '']);

  // 5) 住所が無い相手は手入力を促す
  await page.evaluate(async () => {
    document.getElementById('ship-direct-cust').value = '住所なし商店';
    document.getElementById('ship-direct-freight').value = '';
    await shipDirectFreightAuto(true);
  });
  await page.waitForTimeout(250);
  const noaddr = await page.$eval('#ship-direct-freight-note', el => el.innerText);
  results.push(['住所不明なら手入力を促す', /直接入力/.test(noaddr), noaddr.slice(0, 50)]);

  // 5b) 自動計算の最中に手入力したら、あとから来た計算結果で上書きされない
  await page.evaluate(async () => {
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
