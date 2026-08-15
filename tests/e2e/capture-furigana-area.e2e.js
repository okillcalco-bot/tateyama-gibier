// 捕獲票: 氏名のふりがな予測＋いつもの捕獲場所で地区UIを畳む
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/capture-form.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9083);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  const HUNTERS = [
    { name: '加藤茂', memo: '', furigana: 'かとうしげる' },
    { name: '加藤 純', memo: '', furigana: 'かとうじゅん' },
    { name: '沖浩志', memo: '', furigana: 'おきひろし' },
    { name: '塩倉千春', memo: '', furigana: 'しおくらちはる' },
  ];
  await p.route('**/rest/v1/**', route => {
    const url = decodeURIComponent(route.request().url());
    const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    if (url.includes('/area_master')) return j([{ city: '館山市', district: '豊房', oaza: '神余' }]);
    if (url.includes('/hunters')) return j(HUNTERS);
    if (url.includes('/app_settings')) return j([{ value: { serial_start: 460, label_start_T: 274, label_start_M: 181 } }]);
    return j([]);
  });
  await p.goto('http://localhost:9083/capture-form.html'); await p.waitForTimeout(700);

  // 1) ふりがな「かとう」で候補が出る
  const sug = await p.evaluate(() => {
    const inp = document.getElementById('hunterName');
    inp.value = 'かとう'; onHunterInput();
    const box = document.getElementById('hunterSuggest');
    return { shown: box.style.display !== 'none', items: [...box.querySelectorAll('.hsg-item')].map(x => x.dataset.name) };
  });
  ck('ふりがな「かとう」で候補表示', sug.shown, JSON.stringify(sug));
  ck('候補に加藤茂・加藤純', sug.items.includes('加藤茂') && sug.items.includes('加藤 純'), JSON.stringify(sug.items));

  // 2) カタカナ「シオクラ」でも一致
  const kata = await p.evaluate(() => {
    const inp = document.getElementById('hunterName'); inp.value = 'シオクラ'; onHunterInput();
    return [...document.querySelectorAll('#hunterSuggest .hsg-item')].map(x => x.dataset.name);
  });
  ck('カタカナ「シオクラ」で塩倉千春', kata.includes('塩倉千春'), JSON.stringify(kata));

  // 3) 漢字一部「沖」でも一致
  const kanji = await p.evaluate(() => {
    const inp = document.getElementById('hunterName'); inp.value = '沖'; onHunterInput();
    return [...document.querySelectorAll('#hunterSuggest .hsg-item')].map(x => x.dataset.name);
  });
  ck('漢字「沖」で沖浩志', kanji.includes('沖浩志'), JSON.stringify(kanji));

  // 4) 候補選択で氏名が入り、候補は閉じる
  const picked = await p.evaluate(() => {
    pickHunterSuggest('加藤茂');
    return { name: document.getElementById('hunterName').value, boxHidden: document.getElementById('hunterSuggest').style.display === 'none' };
  });
  ck('候補選択で氏名入力', picked.name === '加藤茂', picked.name);
  ck('選択で候補を閉じる', picked.boxHidden);

  // 4b) 止め刺し者も同じふりがな予測
  const fin = await p.evaluate(() => {
    const inp = document.getElementById('finisherName'); inp.value = 'おき'; onFinisherInput();
    const box = document.getElementById('finisherSuggest');
    const items = [...box.querySelectorAll('.hsg-item')].map(x => x.dataset.name);
    const r = box.getBoundingClientRect();
    return { shown: box.style.display !== 'none', items, pos: box.style.position, top: r.top, bottom: r.bottom, vh: window.innerHeight };
  });
  ck('止め刺し者もふりがな予測（おき→沖浩志）', fin.shown && fin.items.includes('沖浩志'), JSON.stringify(fin));
  ck('候補が画面内に収まる（見切れない）', fin.pos === 'fixed' && fin.top >= 0 && fin.bottom <= fin.vh + 1, JSON.stringify(fin));
  await p.evaluate(() => { pickFinisherSuggest('沖浩志'); });
  ck('止め刺し者候補選択で入力', await p.evaluate(() => document.getElementById('finisherName').value) === '沖浩志');

  // 4c) 搬入者も同じふりがな予測
  const car = await p.evaluate(() => {
    const inp = document.getElementById('carrierName'); inp.value = 'かとう'; onCarrierInput();
    return [...document.querySelectorAll('#carrierSuggest .hsg-item')].map(x => x.dataset.name);
  });
  ck('搬入者もふりがな予測（かとう→加藤茂）', car.includes('加藤茂'), JSON.stringify(car));
  await p.evaluate(() => { pickCarrierSuggest('加藤茂'); });
  ck('搬入者候補選択で入力', await p.evaluate(() => document.getElementById('carrierName').value) === '加藤茂');

  // 5) いつもの捕獲場所を入れると地区UIが畳まれ「入力済み」バナー
  const done = await p.evaluate(() => {
    applyHunterArea({ city: '館山市', area: '神余' });
    return {
      area: document.getElementById('captureArea').value,
      banner: document.getElementById('areaDoneRow').style.display !== 'none',
      bannerText: document.getElementById('areaDoneLabel').textContent,
      cityHidden: document.getElementById('cityRow').style.display === 'none',
      oazaHidden: document.getElementById('oazaRow').style.display === 'none',
    };
  });
  ck('いつもの場所で captureArea=神余', done.area === '神余', done.area);
  ck('「入力済み」バナー表示', done.banner && done.bannerText.includes('神余'), JSON.stringify(done));
  ck('地区の選択UIは畳まれる', done.cityHidden && done.oazaHidden, JSON.stringify(done));

  // 6) 「変更する」で選択UIが戻る
  const edit = await p.evaluate(() => {
    editArea();
    return {
      banner: document.getElementById('areaDoneRow').style.display !== 'none',
      cityShown: document.getElementById('cityRow').style.display !== 'none',
    };
  });
  ck('変更するでバナー非表示', edit.banner === false);
  ck('変更するで市町村選択が戻る', edit.cityShown);

  // 7) 「別の地区を選ぶ」でいつもの場所を解除して選択UIを開く
  const nw = await p.evaluate(() => {
    applyHunterArea({ city: '館山市', area: '神余' });   // いつものを入れて畳む
    pickNewArea();
    return {
      area: document.getElementById('captureArea').value,
      banner: document.getElementById('areaDoneRow').style.display !== 'none',
      cityShown: document.getElementById('cityRow').style.display !== 'none',
    };
  });
  ck('別の地区: いつもの場所を解除（captureArea空）', nw.area === '', JSON.stringify(nw));
  ck('別の地区: 選択UIが開く', nw.banner === false && nw.cityShown, JSON.stringify(nw));

  ck('JSエラーなし', errs.length === 0, errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
