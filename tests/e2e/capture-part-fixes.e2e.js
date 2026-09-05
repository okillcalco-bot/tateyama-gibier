// 捕獲票: ①個体番号を修正時に編集可 ②捕獲者追加(野崎徹/根岸典好) ③白浜町/和田町の現住所表記を選べる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/capture-form.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9081);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  const AREA = [
    { city: '南房総市', district: '白浜町', oaza: '乙浜', address_label: '南房総市白浜町乙浜' },
    { city: '南房総市', district: '白浜町', oaza: '滝口', address_label: '南房総市白浜町滝口' },
    { city: '南房総市', district: '和田町', oaza: '黒岩', address_label: '南房総市和田町黒岩' },
    { city: '南房総市', district: '三芳村', oaza: '海老敷', address_label: '南房総市三芳村海老敷' },
    { city: '南房総市', district: '富浦町', oaza: '南無谷', address_label: '南房総市富浦町南無谷' },
    { city: '南房総市', district: '千倉町', oaza: '白間津', address_label: '南房総市千倉町白間津' },
    { city: '館山市', district: '豊房', oaza: '神余', address_label: '館山市神余' },
  ];
  await p.route('**/rest/v1/**', route => {
    const url = decodeURIComponent(route.request().url());
    const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    if (url.includes('/area_master')) return j(AREA);
    // 捕獲者候補は公開VIEW(hunters_public)から取得（P0-2）。実名の直書きはP0-5で撤去済み
    if (url.includes('/hunters_public')) return j([
      { name: '野崎徹', furigana: 'のざきとおる', is_retired: false },
      { name: '根岸典好', furigana: 'ねぎしのりよし', is_retired: false },
    ]);
    return j([]);
  });
  await p.goto('http://localhost:9081/capture-form.html'); await p.waitForTimeout(600);

  // ② 捕獲者台帳（datalist）は公開VIEW(hunters_public)から動的に埋まる（P0-2）
  const dl = await p.evaluate(() => [...document.querySelectorAll('#hunterList option')].map(o => o.value));
  ck('datalistに野崎徹（DB由来）', dl.includes('野崎徹'), JSON.stringify(dl));
  ck('datalistに根岸典好（DB由来）', dl.includes('根岸典好'));
  // P0-5: 実在捕獲者名の直書きマップはソースから撤去済み（地区推定はDB=loadUsualに委譲）
  ck('直書きの捕獲者→地区マップは撤去済み(P0-5)', await p.evaluate(() => Object.keys(HUNTER_AREA_RAW).length) === 0);

  // ③ 白浜町/和田町は現住所表記（白浜町乙浜）で選べる
  const oaza = await p.evaluate(() => {
    state.capture_city = '南房総市';
    updateAreaDropdown('南房総市');
    renderOazaButtons('南房総市', '白浜町');
    return [...document.querySelectorAll('#oazaBtns .toggle-btn')].map(x => x.textContent);
  });
  ck('白浜町の大字が「白浜町乙浜」表記で出る', oaza.includes('白浜町乙浜') && oaza.includes('白浜町滝口'), JSON.stringify(oaza));
  const wada = await p.evaluate(() => { renderOazaButtons('南房総市', '和田町'); return [...document.querySelectorAll('#oazaBtns .toggle-btn')].map(x => x.textContent); });
  ck('和田町の大字が「和田町黒岩」表記で出る', wada.includes('和田町黒岩'), JSON.stringify(wada));
  const sanbu = await p.evaluate(() => { renderOazaButtons('南房総市', '三芳村'); return [...document.querySelectorAll('#oazaBtns .toggle-btn')].map(x => x.textContent); });
  ck('三芳村など旧村は従来どおり大字のみ（海老敷）', sanbu.includes('海老敷') && !sanbu.includes('三芳村海老敷'), JSON.stringify(sanbu));
  const tomiura = await p.evaluate(() => { renderOazaButtons('南房総市', '富浦町'); return [...document.querySelectorAll('#oazaBtns .toggle-btn')].map(x => x.textContent); });
  ck('富浦町は旧町名つき（富浦町南無谷）', tomiura.includes('富浦町南無谷'), JSON.stringify(tomiura));
  const chikura = await p.evaluate(() => { renderOazaButtons('南房総市', '千倉町'); return [...document.querySelectorAll('#oazaBtns .toggle-btn')].map(x => x.textContent); });
  ck('千倉町は旧町名つき（千倉町白間津）', chikura.includes('千倉町白間津'), JSON.stringify(chikura));

  // 白浜町乙浜のボタンを押すと captureArea が現住所表記で入る
  const pick = await p.evaluate(() => {
    renderOazaButtons('南房総市', '白浜町');
    const btn = [...document.querySelectorAll('#oazaBtns .toggle-btn')].find(x => x.textContent === '白浜町乙浜');
    btn.click();
    return document.getElementById('captureArea').value;
  });
  ck('選ぶとcaptureArea=白浜町乙浜', pick === '白浜町乙浜', pick);

  // 大字検索でも「白浜町乙浜」で引ける
  const search = await p.evaluate(() => {
    state.capture_city = '南房総市';
    document.getElementById('oazaSearch').value = '白浜町乙浜';
    onOazaSearch();
    return document.getElementById('captureArea').value;
  });
  ck('大字検索「白浜町乙浜」で確定できる', search === '白浜町乙浜', search);

  // ① 修正モードで個体番号が表示・編集可
  const rec = { id: 'r1', label_id: '仮-ABC', serial_number: 458, species: 'イノシシ', weight_total: 34, capture_date: '2026-08-14', hunter_name: '加藤茂', capture_city: '館山市', capture_area: '神余' };
  const editState = await p.evaluate((r) => {
    loadForEdit(r);
    const lab = document.getElementById('indLabelId');
    return {
      rowShown: document.getElementById('serialRow').style.display !== 'none',
      labelVal: lab.value,
      editable: !lab.hasAttribute('readonly'),
      noteShown: document.getElementById('serialEditNote').style.display !== 'none',
    };
  }, rec);
  ck('修正時: 個体番号の行が表示', editState.rowShown, JSON.stringify(editState));
  ck('修正時: 個体番号に既存値(仮-ABC)', editState.labelVal === '仮-ABC', editState.labelVal);
  ck('修正時: 個体番号が編集可(readonly解除)', editState.editable);
  ck('修正時: 編集できる旨のヒント表示', editState.noteShown);

  // リセットで番号行は隠れ readonly に戻る
  const afterReset = await p.evaluate(() => {
    cancelEditMode();
    const lab = document.getElementById('indLabelId');
    return { rowHidden: document.getElementById('serialRow').style.display === 'none', readonly: lab.hasAttribute('readonly') };
  });
  ck('リセット後: 番号行は非表示', afterReset.rowHidden);
  ck('リセット後: 個体番号は読み取り専用に戻る', afterReset.readonly);

  ck('JSエラーなし', errs.length === 0, errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
