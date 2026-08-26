// 引き取りの仮-個体を個体編集(indSave)で保存すると AUTO-<接頭辞> を送り、DBトリガで本採番される
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let patch = null;

  await page.route('**/rest/v1/**', route => {
    const url = route.request().url(), method = route.request().method();
    if (method === 'PATCH' && /\/individuals/.test(url)) {
      let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      patch = { url, body };
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[{}]' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });

  const results = [];
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(700);

  // 接頭辞ヘルパ
  const pref = await page.evaluate(() => [getIndividualPrefix('イノシシ', '南房総市'), getIndividualPrefix('イノシシ', '館山市'), getIndividualPrefix('シカ', '館山市')]);
  results.push(['接頭辞 M/T/シ', JSON.stringify(pref) === JSON.stringify(['M', 'T', 'シ']), JSON.stringify(pref)]);

  // 仮-個体の編集保存 → AUTO-M を送る
  await page.evaluate(async () => {
    window.confirm = () => true;
    document.getElementById('ind-f-species').value = 'イノシシ';
    document.getElementById('ind-f-capture_city').value = '南房総市';
    document.getElementById('ind-f-label_id').value = '仮-TESTPICKUP';
    indEditId = '仮-TESTPICKUP';
    await indSave();
  });
  await page.waitForTimeout(300);
  results.push(['PATCHが飛ぶ', !!patch, '']);
  results.push(['label_id=AUTO-M を送る', patch && patch.body.label_id === 'AUTO-M', patch && patch.body.label_id]);
  results.push(['serial_number=null を送る', patch && patch.body.serial_number === null, patch && String(patch.body.serial_number)]);
  results.push(['WHEREは仮-で特定', patch && /label_id=eq\.%E4%BB%AE-TESTPICKUP/.test(patch.url), patch && patch.url.split('?')[1]]);
  // 通し番号が無い個体（令和7年度の非イノシシ）はラベルの番号を代わりに表示する
  const serialCells = await page.evaluate(() => {
    indAllData = [
      { label_id: 'TGC-07-キ060', species: 'キョン', serial_number: null, capture_city: '館山市' },
      { label_id: 'TGC-08-T001', species: 'イノシシ', serial_number: 12, capture_city: '館山市' },
      { label_id: '仮-TESTX', species: 'イノシシ', serial_number: null, capture_city: '館山市' }
    ];
    indSortCol = 'label_id'; indSortAsc = true;
    indRender();
    return [...document.querySelectorAll('#ind-body tr')].map(tr => tr.children[1].textContent.trim());
  });
  results.push(['通し番号ありはその数字', serialCells.includes('12'), serialCells.join(',')]);
  results.push(['通し番号なしはラベルの番号', serialCells.includes('060'), serialCells.join(',')]);
  results.push(['番号が取れない個体は-', serialCells.includes('-'), serialCells.join(',')]);

  results.push(['pageerrorなし', errors.length === 0, errors.join(' / ')]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' && got != null ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
