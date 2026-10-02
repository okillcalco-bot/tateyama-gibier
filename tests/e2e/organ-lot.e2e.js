// 精肉モード「内臓をまとめる」: 複数個体の内臓を1つの真空パックにしたとき、1つの在庫（内臓ロット）にしてラベル1枚を出す（2026-10-02）
//
//   きっかけ
//     内臓も複数個体を1つの真空パックにすることがある。骨ロットと同じ仕組みで、部位を選んでまとめられるようにした。
//
//   ここで測ること
//     1. 「🫀 内臓をまとめる」で開くと、表題・説明・部位（既定 レバー）が内臓用になる
//     2. 内臓は獲れた日にさばくので、その週に「捕獲した」個体も候補に出る（精肉完了の個体と重複しない）
//     3. 登録すると inventory 1行（部位=選んだ内臓・TGC-OG-yymmdd-nn・部位コード・tier 2・単価0）と、各個体→ロットの processing_log
//     4. ラベルの部位名が選んだ内臓になり、個体番号欄に「n頭 …」が入る
//     5. 骨で開き直すと骨ロット（TGC-BN-…・部位 骨・単価200）に戻る
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
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const DONE = [{ label_id: 'TGC-08-T324', species: 'イノシシ', processing_done_at: todayIso, weight_total: 28.2, hunter_name: '沖浩志' }];
  const CAUGHT = [
    { label_id: 'TGC-08-T350', species: 'イノシシ', processing_done_at: null, weight_total: 36.5, hunter_name: '平嶋好和', capture_date: today },
    { label_id: 'TGC-08-T351', species: 'イノシシ', processing_done_at: null, weight_total: 41.0, hunter_name: '石井茂夫', capture_date: today },
    { label_id: 'TGC-08-T324', species: 'イノシシ', processing_done_at: todayIso, weight_total: 28.2, hunter_name: '沖浩志', capture_date: today },  // 重複は1回だけ
  ];
  const posts = { inventory: [], processing_log: [] };
  await page.route('**/*', r => {
    const u = r.request().url(), m = r.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    const qs = decodeURIComponent(u.split('?')[1] || '');
    if (/\/rest\/v1\/individuals/.test(u)) {
      if (/processing_done_at=gte/.test(qs)) return J(DONE);
      if (/capture_date=gte/.test(qs)) return J(CAUGHT);
      return J([]);
    }
    if (/\/rest\/v1\/processing_log/.test(u)) {
      if (m === 'POST') { posts.processing_log.push(JSON.parse(r.request().postData() || '[]')); return J([]); }
      return J([]);
    }
    if (/\/rest\/v1\/inventory/.test(u)) {
      if (m === 'POST') { const body = JSON.parse(r.request().postData() || '{}'); posts.inventory.push(body); return J([{ ...body, id: 'inv-og-1', scan_code: '10009911' }]); }
      return J([]);
    }
    return J([]);
  });

  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(700);
  await page.evaluate(() => { pmCurrentOperator = '吉田友美'; window.__labels = []; pmPrintLabelHtml = html => { window.__labels.push(html); }; });

  // 1) 内臓で開く
  T('精肉モードに「内臓をまとめる」ボタンがある', await page.$eval('#pmOrganLotBtn', el => /内臓をまとめる/.test(el.textContent)), '');
  await page.evaluate(() => boneLotOpen('organ'));
  await page.waitForTimeout(600);
  T('表題が内臓ロットになる', /内臓をまとめる/.test(await page.$eval('#bl-title', el => el.textContent)), '');
  T('部位の既定は レバー', (await page.$eval('#bl-part', el => el.value)) === 'レバー', '');
  T('ボタンが「内臓ロットを登録してラベル印刷」', /内臓ロットを登録/.test(await page.$eval('#bl-submit', el => el.textContent)), await page.$eval('#bl-submit', el => el.textContent));

  // 2) 候補: 精肉完了＋その週に捕獲（重複なし）
  const rows = await page.$$eval('#bl-list label', els => els.map(l => ({ id: l.querySelector('b').textContent, txt: l.textContent.replace(/\s+/g, ' ') })));
  T('その週に捕獲した個体も候補に出る（T350・T351）', rows.some(r => r.id === 'TGC-08-T350' && /捕獲/.test(r.txt)) && rows.some(r => r.id === 'TGC-08-T351'), JSON.stringify(rows.map(r => r.id)));
  T('同じ個体は1回だけ（T324）', rows.filter(r => r.id === 'TGC-08-T324').length === 1 && rows.length === 3, JSON.stringify(rows.map(r => r.id)));

  // 3) ハツで登録
  await page.selectOption('#bl-part', 'ハツ');
  await page.uncheck('#bl-list label:has-text("T324") input');
  await page.fill('#bl-weight', '1.35');
  await page.click('#bl-submit');
  await page.waitForTimeout(900);
  const inv = posts.inventory[0] || {};
  T('inventory に1行: 部位 ハツ・TGC-OG-yymmdd-01・部位コード HT・tier 2・単価0・個体なし', posts.inventory.length === 1 && inv.part_name === 'ハツ' && inv.ident_code === `TGC-OG-${ymd}-01` && inv.barcode_num === 'HT' && inv.tier === 2 && inv.unit_price === 0 && inv.individual_id === null && inv.lot_code === inv.ident_code && inv.process_type === 'ハツ' && inv.weight_kg === 1.35, JSON.stringify(inv).slice(0, 300));
  const logs = posts.processing_log[0] || [];
  T('processing_log に各個体→ロットの2行（process_type ハツ）', logs.length === 2 && logs.every(l => l.child_ident_code === inv.ident_code && l.process_type === 'ハツ' && l.individual_id === l.parent_ident_code) && logs.map(l => l.parent_ident_code).sort().join(',') === 'TGC-08-T350,TGC-08-T351', JSON.stringify(logs).slice(0, 300));
  T('登録できたことが画面に出る（部位・頭数・重さ）', /ハツ・2頭・1\.350kg/.test(await page.$eval('#bl-done-text', el => el.textContent)), await page.$eval('#bl-done-text', el => el.textContent));

  // 4) ラベル
  const html = (await page.evaluate(() => window.__labels))[0] || '';
  T('ラベルの部位名がハツ・2頭と個体番号・8桁キー', /class="p"[^>]*>ハツ</.test(html) && /2頭 T350 T351/.test(html.replace(/&nbsp;/g, ' ')) && /10009911/.test(html), (html.match(/個体管理番号[^<]*/) || [''])[0]);

  // 5) 骨で開き直すと骨ロット
  await page.evaluate(() => boneLotOpen());
  await page.waitForTimeout(500);
  T('骨で開くと表題・部位が骨に戻る', /骨をまとめる/.test(await page.$eval('#bl-title', el => el.textContent)) && (await page.$eval('#bl-part', el => el.value)) === '骨', '');
  await page.fill('#bl-weight', '4.0');
  await page.click('#bl-submit');
  await page.waitForTimeout(900);
  const bone = posts.inventory[1] || {};
  T('骨ロットは従来どおり（TGC-BN-…・部位 骨・コード111・単価200）', bone.part_name === '骨' && /^TGC-BN-/.test(bone.ident_code) && bone.barcode_num === '111' && bone.unit_price === 200, JSON.stringify(bone).slice(0, 200));

  // 6) 出荷時の単価: 価格マスタの「ハツ（心臓）」と在庫の「ハツ」が一致する
  const price = await page.evaluate(() => {
    const pm = [{ species: 'イノシシ', part_name: 'ハツ（心臓）', grade: '並', price_standard: 1000, price_local: 500 }, { species: 'イノシシ', part_name: 'タン（舌）', grade: '並', price_standard: 1000 }];
    return { ht: directShipPrice(pm, 'local', { species: 'イノシシ', part_name: 'ハツ', grade: '並' }), tn: directShipPrice(pm, 'standard', { species: 'イノシシ', part_name: 'タン', grade: '並' }), lv: directShipPrice(pm, 'standard', { species: 'イノシシ', part_name: 'レバー', grade: '並' }) };
  });
  T('出荷時の単価: 「ハツ」→ 価格マスタ「ハツ（心臓）」のローカル500円、「タン」→1000円', price.ht === 500 && price.tn === 1000, JSON.stringify(price));
  T('価格マスタに無い部位（レバー）は単価なしのまま（警告が出る側）', price.lv === null, JSON.stringify(price));
  T('pageerrorなし', errors.length === 0, errors.join(' / '));
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
