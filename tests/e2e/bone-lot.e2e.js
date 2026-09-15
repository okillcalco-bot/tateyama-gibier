// 精肉モード「骨をまとめる」: その週に精肉した個体の骨を1つの在庫（骨ロット）にし、ラベル1枚を出す
//
//   きっかけ（2026-09-15）
//     骨は個体ごとに分けておらず、出荷のたびに「骨 5kg」の手動行になっていた（トレーサビリティの線が骨だけ切れる）。
//     案1: 精肉モードで週の個体を複数選んで1ロットにする。
//
//   ここで測ること
//     1. 「🦴 骨をまとめる」で、その週に全部位完了した個体＋部位登録の記録がある個体が並び、イノシシは既定でチェック
//     2. 獣種が混ざると登録できない（メッセージが出てボタンが無効）
//     3. 登録すると inventory 1行（individual_id=null・individual_code=lot_code=ident_code=TGC-BN-yymmdd-nn・部位 骨・tier 2）と
//        processing_log（各個体→ロット）が保存され、番号は同日の既存ロットの次になる
//     4. ラベルには「骨」「重量」「n頭 個体番号…」「8桁キー」「QR」が入り、40×60mm で個体番号欄が1行・内容が52mm以内
//     5. 番号が重なったら次の番号で登録する／刷り直しボタンで同じラベルが出る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());

  const d = new Date();
  const ymd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const todayIso = d.toISOString();
  const INDS = [
    { label_id: 'TGC-08-T324', species: 'イノシシ', processing_done_at: todayIso, weight_total: 28.2, hunter_name: '沖浩志' },
    { label_id: 'TGC-08-M185', species: 'イノシシ', processing_done_at: todayIso, weight_total: 25.8, hunter_name: '白石秀一' },
    { label_id: 'TGC-08-T320', species: 'イノシシ', processing_done_at: todayIso, weight_total: 23.3, hunter_name: '加藤茂' },
    { label_id: 'TGC-08-ア017', species: 'アライグマ', processing_done_at: todayIso, weight_total: 6.1, hunter_name: '沖浩志' },
  ];
  const posts = { inventory: [], processing_log: [] };
  let dupOnce = false;
  await page.route('**/*', r => {
    const u = r.request().url(), m = r.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    const qs = decodeURIComponent(u.split('?')[1] || '');
    if (/\/rest\/v1\/individuals/.test(u)) {
      if (/processing_done_at=gte/.test(qs)) return J(INDS);
      if (/label_id=in\./.test(qs)) return J([{ label_id: 'TGC-08-T319', species: 'イノシシ', processing_done_at: null, weight_total: 35.7, hunter_name: '加藤茂' }]);
      return J([]);
    }
    if (/\/rest\/v1\/processing_log/.test(u)) {
      if (m === 'POST') { posts.processing_log.push(JSON.parse(r.request().postData() || '[]')); return J([]); }
      return J([{ individual_id: 'TGC-08-T319' }, { individual_id: 'TGC-08-T324' }]);
    }
    if (/\/rest\/v1\/inventory/.test(u)) {
      if (m === 'POST') {
        const body = JSON.parse(r.request().postData() || '{}');
        if (dupOnce) { dupOnce = false; return r.fulfill({ status: 409, contentType: 'application/json', body: '{"code":"23505","message":"duplicate key value violates unique constraint"}' }); }
        posts.inventory.push(body);
        return J([{ ...body, id: 'inv-bone-1', scan_code: '10009901' }]);
      }
      if (/ident_code=like\./.test(qs)) return J([{ ident_code: `TGC-BN-${ymd}-01` }]);
      return J([]);
    }
    return J([]);
  });

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(700);
  await page.evaluate(() => { pmCurrentOperator = '吉田友美'; window.__labels = []; pmPrintLabelHtml = html => { window.__labels.push(html); }; });

  // 1) 開く → 候補
  T('精肉モードに「骨をまとめる」ボタンがある', await page.$eval('#pmBoneLotBtn', el => /骨をまとめる/.test(el.textContent)), '');
  await page.evaluate(() => boneLotOpen());
  await page.waitForTimeout(600);
  const rows = await page.$$eval('#bl-list label', els => els.map(l => ({ id: l.querySelector('b').textContent, on: l.querySelector('input').checked, txt: l.textContent.replace(/\s+/g, ' ') })));
  T('その週の個体5頭（完了4＋部位登録あり1）が並ぶ', rows.length === 5 && rows.some(r => r.id === 'TGC-08-T319' && /部位登録あり/.test(r.txt)), JSON.stringify(rows.map(r => r.id)));
  T('イノシシは既定でチェック、アライグマは外れている', rows.filter(r => r.id !== 'TGC-08-ア017').every(r => r.on) && !rows.find(r => r.id === 'TGC-08-ア017').on, '');
  T('週の範囲が表示される', /（月）〜.*（日）/.test(await page.$eval('#bl-week-label', el => el.textContent)), await page.$eval('#bl-week-label', el => el.textContent));
  T('まとめの表示: 4頭・イノシシ・千葉県産（館山＋南房総の混在）', /4頭/.test(await page.$eval('#bl-summary', el => el.textContent)) && /千葉県産/.test(await page.$eval('#bl-summary', el => el.textContent)), await page.$eval('#bl-summary', el => el.textContent));

  // 2) 獣種が混ざると登録できない
  await page.check('#bl-list label:has-text("ア017") input');
  await page.waitForTimeout(100);
  T('獣種が混ざると警告が出て登録ボタンが無効', /獣種が混ざっています/.test(await page.$eval('#bl-summary', el => el.textContent)) && (await page.$eval('#bl-submit', el => el.disabled)), '');
  await page.uncheck('#bl-list label:has-text("ア017") input');
  await page.waitForTimeout(100);
  T('外すと登録できる', !(await page.$eval('#bl-submit', el => el.disabled)), '');

  // 3) 登録
  await page.fill('#bl-weight', '5.2');
  await page.click('#bl-submit');
  await page.waitForTimeout(900);
  const inv = posts.inventory[0] || {};
  T('inventory に1行: 部位 骨・individual_id なし・individual_code=lot_code=ident_code・tier 2・イノシシ・5.2kg', posts.inventory.length === 1 && inv.part_name === '骨' && inv.individual_id === null && inv.individual_code === inv.ident_code && inv.lot_code === inv.ident_code && inv.tier === 2 && inv.species === 'イノシシ' && inv.weight_kg === 5.2 && inv.process_type === '骨' && inv.status === '在庫' && inv.operator === '吉田友美', JSON.stringify(inv).slice(0, 300));
  T('ロット番号は TGC-BN-yymmdd-02（同日の 01 の次）', inv.ident_code === `TGC-BN-${ymd}-02`, inv.ident_code);
  const logs = posts.processing_log[0] || [];
  T('processing_log に各個体→ロットの4行（individual_id 付き・process_type 骨）', logs.length === 4 && logs.every(l => l.child_ident_code === inv.ident_code && l.individual_id === l.parent_ident_code && l.process_type === '骨') && logs.map(l => l.parent_ident_code).sort().join(',') === 'TGC-08-M185,TGC-08-T319,TGC-08-T320,TGC-08-T324', JSON.stringify(logs).slice(0, 300));
  T('登録できたことが画面に出る（刷り直しボタン付き）', (await page.$eval('#bl-done', el => el.style.display)) !== 'none' && /4頭・5\.200kg/.test(await page.$eval('#bl-done-text', el => el.textContent)), await page.$eval('#bl-done-text', el => el.textContent));

  // 4) ラベル
  const labels = await page.evaluate(() => window.__labels);
  const html = labels[0] || '';
  T('ラベルが1枚出る（骨・5.200 kg・4頭と個体番号・8桁キー・QR）', labels.length === 1 && /class="p"[^>]*>骨</.test(html) && /5\.200/.test(html) && /4頭 T324 M185 T320 T319|4頭 T324 M185 T320 T319/.test(html.replace(/&nbsp;/g, ' ')) && /10009901/.test(html) && /class="qr"/.test(html), html.length + 'B ' + (html.match(/個体管理番号[^<]*/) || [''])[0]);
  const geo = await page.evaluate(async (html) => {
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;left:-9999px;top:0;border:0;width:40mm;height:60mm;';
    document.body.appendChild(f);
    const dd = f.contentDocument; dd.open(); dd.write(html); dd.close();
    await new Promise(r => setTimeout(r, 150));
    const mmPx = (() => { const p = dd.createElement('div'); p.style.cssText = 'width:10mm;position:absolute'; dd.body.appendChild(p); const w = p.getBoundingClientRect().width / 10; p.remove(); return w; })();
    const id = dd.querySelector('.id'); const cs = dd.defaultView.getComputedStyle(id);
    const lh = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
    const ad = dd.querySelector('.ad').getBoundingClientRect();
    const out = { idLines: Math.round(id.getBoundingClientRect().height / lh), bottomMm: ad.bottom / mmPx, idW: id.scrollWidth <= id.clientWidth + 1 };
    f.remove(); return out;
  }, html);
  T('個体番号欄は1行に収まり、内容は52mm以内（下端まで印字できる）', geo.idLines === 1 && geo.idW && geo.bottomMm <= 52, JSON.stringify(geo));
  T('8頭のときは「T1 T2 ほか6頭」のように詰める', /ほか/.test(await page.evaluate(() => boneLotIdsText(['TGC-08-T301', 'TGC-08-T302', 'TGC-08-T303', 'TGC-08-T304', 'TGC-08-T305', 'TGC-08-T306', 'TGC-08-T307', 'TGC-08-T308']))), await page.evaluate(() => boneLotIdsText(['TGC-08-T301', 'TGC-08-T302', 'TGC-08-T303', 'TGC-08-T304', 'TGC-08-T305', 'TGC-08-T306', 'TGC-08-T307', 'TGC-08-T308'])));

  // 5) 刷り直し／番号の重なり
  await page.evaluate(() => boneLotReprint());
  await page.waitForTimeout(100);
  T('刷り直しで同じラベルがもう1枚出る', (await page.evaluate(() => window.__labels.length)) === 2 && (await page.evaluate(() => window.__labels[1] === window.__labels[0])), '');
  dupOnce = true;
  await page.fill('#bl-weight', '3.1');
  await page.click('#bl-submit');
  await page.waitForTimeout(900);
  T('番号が重なった（23505）ときは次の番号で登録する', posts.inventory.length === 2 && posts.inventory[1].ident_code === `TGC-BN-${ymd}-03` && posts.inventory[1].weight_kg === 3.1, posts.inventory[1] && posts.inventory[1].ident_code);

  T('pageerrorなし', errors.length === 0, errors.join(' / '));
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
