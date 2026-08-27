// 胃の内容物（何を食べて育ったか）を捕獲票で記録し、個体の🌿一生に出す
//   線の入口（生態データ）が空だったので、現場で必ず目に入る「餌」から埋める。
//   選ぶだけで済むこと・保存に本当に載ること・編集で戻ってくることを測る。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = [];

  // ── 捕獲票 ──────────────────────────────────────────
  {
    const page = await browser.newContext().then(c => c.newPage());
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', r => {
      const u = r.request().url();
      if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
      if (u.startsWith('file:')) return r.continue();
      if (/\/rest\/v1\//.test(u)) return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return r.fulfill({ status: 200, body: '[]' });
    });
    await page.goto('file://' + path.resolve(__dirname, '../../capture-form.html'));
    await page.waitForTimeout(800);

    // 1) 選択肢が出ている
    const chips = await page.$$eval('#stomachChips .usual-chip', els => els.map(e => e.textContent.trim()));
    results.push(['選択肢が出る', chips.length >= 8, chips.length + '個']);
    results.push(['房総で多いものが並ぶ',
      chips.includes('ドングリ・堅果') && chips.includes('タケノコ・竹') && chips.includes('落花生'), '']);
    results.push(['「ほとんど空」がある', chips.includes('ほとんど空'), '']);

    // 2) 何も選ばなければ null（無理に埋めさせない）
    results.push(['未選択ならnull', await page.evaluate(() => getStomachContents()) === null, '']);

    // 3) 複数選べる
    await page.evaluate(() => { toggleStomach('ドングリ・堅果'); toggleStomach('タケノコ・竹'); });
    let sel = await page.evaluate(() => getStomachContents());
    results.push(['複数選べる', Array.isArray(sel) && sel.length === 2 && sel.includes('ドングリ・堅果') && sel.includes('タケノコ・竹'), JSON.stringify(sel)]);

    // 4) 選んだものは見た目でも分かる
    const activeN = await page.$$eval('#stomachChips .usual-chip.active', els => els.length);
    results.push(['選んだ印がつく', activeN === 2, String(activeN)]);

    // 5) もう一度押すと外れる
    await page.evaluate(() => toggleStomach('タケノコ・竹'));
    sel = await page.evaluate(() => getStomachContents());
    results.push(['押し直すと外れる', sel.length === 1 && sel[0] === 'ドングリ・堅果', JSON.stringify(sel)]);

    // 6) 「ほとんど空」は他と両立しない（両方立つと何を見たのか分からない）
    await page.evaluate(() => toggleStomach('ほとんど空'));
    sel = await page.evaluate(() => getStomachContents());
    results.push(['「ほとんど空」は単独になる', sel.length === 1 && sel[0] === 'ほとんど空', JSON.stringify(sel)]);
    await page.evaluate(() => toggleStomach('イモ類'));
    sel = await page.evaluate(() => getStomachContents());
    results.push(['他を選ぶと「ほとんど空」が外れる', sel.length === 1 && sel[0] === 'イモ類', JSON.stringify(sel)]);

    // 7) 編集で読み戻せる（保存した内容が消えない）
    await page.evaluate(() => { setStomachContents(['稲・米', '果実']); });
    sel = await page.evaluate(() => getStomachContents());
    const back = await page.$$eval('#stomachChips .usual-chip.active', els => els.map(e => e.textContent.trim()));
    results.push(['読み戻せる', sel.length === 2 && back.includes('稲・米') && back.includes('果実'), JSON.stringify(back)]);
    await page.evaluate(() => setStomachContents(null));
    results.push(['空で読み戻すと未選択', await page.evaluate(() => getStomachContents()) === null, '']);

    // 8) 選択肢に無いものを書く欄がある
    results.push(['自由記入の欄がある', await page.$('#stomachNote') !== null, '']);

    results.push(['捕獲票でpageerrorなし', errors.length === 0, errors.join(' / ')]);
    await page.close();
  }

  // ── 業務アプリの🌿一生ビュー ────────────────────────
  {
    const page = await browser.newContext().then(c => c.newPage());
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', r => {
      const u = r.request().url();
      if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
      if (u.startsWith('file:')) return r.continue();
      if (/\/rest\/v1\//.test(u)) return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return r.fulfill({ status: 200, body: '[]' });
    });
    await page.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
    await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
    await page.waitForTimeout(700);

    const txt = await page.evaluate(() => ({
      both: indStomachText({ stomach_contents: ['ドングリ・堅果', 'イモ類'], stomach_note: 'ミカンの皮' }),
      only: indStomachText({ stomach_contents: ['稲・米'], stomach_note: null }),
      none: indStomachText({ stomach_contents: null, stomach_note: null }),
      empty: indStomachText({ stomach_contents: [], stomach_note: '' })
    }));
    results.push(['選択と補足を並べて出す', txt.both === 'ドングリ・堅果・イモ類 / ミカンの皮', txt.both]);
    results.push(['補足なしなら選択だけ', txt.only === '稲・米', txt.only]);
    results.push(['記録がなければ空', txt.none === '' && txt.empty === '', JSON.stringify(txt.none) + JSON.stringify(txt.empty)]);

    // 未記録は「未記録」と分かるように出す（空欄だと入力漏れか無記録か区別できない）
    const html = await page.evaluate(() => indLifeField('胃の内容物', indStomachText({})));
    results.push(['未記録と分かるように出す', /未記録/.test(html), '']);

    // 一生ビューに項目そのものがある
    const src = await page.evaluate(() => indLifeRender.toString());
    results.push(['🌿一生に胃の内容物の行がある', /胃の内容物/.test(src), '']);

    results.push(['業務アプリでpageerrorなし', errors.length === 0, errors.join(' / ')]);
    await page.close();
  }

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' && got != null ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
