// 書類・帳票「市役所用票作成」: 有害鳥獣捕獲票（票＋図面＋写真ページ）を個体検索/手入力＋写真添付で出す
//
//   きっかけ（2026-09-14）
//     市役所（館山有害鳥獣対策協議会）への捕獲票は capture-form の搬入一覧からしか出せず、
//     搬入していない個体（自家消費・埋却）や、あとから写真を付けて出したいときに作れなかった。
//
//   ここで測ること
//     1. 書類・帳票タブにボタンがあり、モーダルで個体検索（個体番号・通し番号・捕獲者）→ 選ぶと票の項目に転記される
//        （くくり罠→くくりわな、ナイフ→刺殺、シカ→ニホンジカ、捕獲者の電話は hunters から）
//     2. 写真を2枚付けると、印刷HTMLは 票・図面（地図と×印だけ）・写真ページ（縦・上＝切る前・下＝切った後）の
//        3ページになり、実際にPDFにして 3ページ すべてA4縦・余白（上14/左右18/下18mm）・写真の上下 を測る。
//        印刷ダイアログで余白「なし」にしても余白が残る（2026-09-14: 余白ゼロで印刷された）
//     2b. Googleマップの座標表示 34°57'25.9"N 139°51'46.8"E を貼ると緯度経度が入る
//     3. 票の内容が添付の様式どおり（■ イノシシ、令和8年9月3日、出野尾、■ メス、50cm・7.9kg、■ くくりわな、
//        ■ 販売（■ 館山ジビエセンター）、沖浩志 070-1410-8808、■ 刺殺、協力員等、館山有害鳥獣対策協議会）
//     4. 検索で選んだ個体には調査票の項目が PATCH で保存され、失敗したときは画面に出る
//     5. 緯度経度が無い手入力のときは図面ページが付かず、その旨が出る
//     6. スマホ幅でモーダルが横スクロールしない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

(async () => {
  const outDir = process.env.DOC_TEST_OUT || require('os').tmpdir();
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());

  const patches = [];
  let failPatch = false;
  const IND = { id: 'i-330', label_id: 'TGC-08-T330', serial_number: 540, species: 'イノシシ', capture_date: '2026-09-03', capture_area: '出野尾', capture_koaza: null, capture_city: '館山市', hunter_name: '沖浩志', sex: 'メス', weight_total: 7.9, body_length_cm: 50, capture_method: 'くくり罠', finishing_method: 'ナイフ', finisher_name: null, has_fetus: false, is_juvenile: false, trap_number: null, bait_type: null, trap_set_date: '2026-09-01', disposal_method: null, submitter_name: null, special_notes: '協力員等', capture_lat: 34.98, capture_lng: 139.84, photo_tail_before: null, photo_tail_after: null, photo_extra: null, image_url: null };
  const DEER = { id: 'i-2', label_id: 'TGC-08-M100', serial_number: 500, species: 'シカ', capture_date: '2026-08-20', capture_area: '神余', hunter_name: '加藤茂', sex: 'オス', weight_total: 30, capture_method: '銃猟', finishing_method: '銃', has_fetus: null, is_juvenile: true, capture_lat: null, capture_lng: null };
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    const qs = decodeURIComponent(u.split('?')[1] || '');
    if (/\/rest\/v1\/hunters/.test(u)) return J([{ name: '沖浩志', phone: '070-1410-8808' }, { name: '加藤茂', phone: '090-0000-0000' }]);
    if (/\/rest\/v1\/individuals/.test(u) && r.request().method() === 'PATCH') {
      patches.push({ qs, body: JSON.parse(r.request().postData() || '{}') });
      return failPatch ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' }) : J([{ id: 'i-330' }]);
    }
    if (/\/rest\/v1\/individuals/.test(u)) {
      if (/serial_number\.eq\.540|label_id\.ilike\.\*T330\*/.test(qs)) return J([IND]);
      if (/hunter_name\.ilike\.\*加藤\*/.test(qs)) return J([DEER]);
      return J([IND, DEER]);
    }
    return J([]);
  });

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  await page.goto('file://' + path.resolve(__dirname, '../../index.html') + '?tab=docs');
  await page.waitForTimeout(600);

  // 1) ボタン → モーダル → 検索 → 転記
  T('書類・帳票に「市役所用票作成」ボタンがある', await page.$eval('#city-cap-open-btn', el => /市役所用票作成/.test(el.textContent)), '');
  await page.click('#city-cap-open-btn');
  await page.waitForTimeout(500);
  T('モーダルが開き、最近の搬入個体が並ぶ', (await page.$eval('#cityCapModal', el => getComputedStyle(el).display)) === 'block' && (await page.$$eval('#cc-search-results .cc-hit', els => els.length)) === 2, '');
  await page.fill('#cc-search', 'T330');
  await page.waitForTimeout(500);
  const hits = await page.$$eval('#cc-search-results .cc-hit', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  T('個体番号で検索できる（TGC-08-T330・通し540・出野尾）', hits.length === 1 && /TGC-08-T330/.test(hits[0]) && /通し540/.test(hits[0]) && /出野尾/.test(hits[0]), hits.join(' | '));
  await page.click('#cc-search-results .cc-hit');
  await page.waitForTimeout(200);
  const f1 = await page.evaluate(() => cityCapCollect());
  T('選ぶと票の項目に転記される（捕獲日・大字・性別・体長体重）', f1.capture_date === '2026-09-03' && f1.capture_area === '出野尾' && f1.sex === 'メス' && f1.body_length_cm === '50' && f1.weight_total === '7.9', JSON.stringify(f1).slice(0, 200));
  T('語の読み替え: くくり罠→くくりわな、ナイフ→刺殺、処理方法は既定で販売（館山ジビエセンター）', f1.capture_method === 'くくりわな' && f1.finishing_method === '刺殺（竹槍・ナイフなど）' && f1.disposal_method === '販売（館山ジビエセンター）', `${f1.capture_method}/${f1.finishing_method}/${f1.disposal_method}`);
  T('捕獲者の電話は hunters から入り、止め刺し者・提出者は捕獲者で埋まる', f1.hunter_tel === '070-1410-8808' && f1.finisher_name === '沖浩志' && f1.finisher_tel === '070-1410-8808' && f1.submitter_name === '沖浩志', `${f1.hunter_tel}/${f1.finisher_name}/${f1.submitter_name}`);
  T('胎児 無・成獣・特記事項が転記される', f1.has_fetus === '無' && f1.is_juvenile === '成獣' && f1.special_notes === '協力員等', `${f1.has_fetus}/${f1.is_juvenile}/${f1.special_notes}`);
  T('選択中の個体が表示され、台帳へ保存の選択肢が出る', /TGC-08-T330/.test(await page.$eval('#cc-selected', el => el.textContent)) && (await page.$eval('#cc-save-back-row', el => el.style.display)) !== 'none', '');

  // 2) 写真: 「切った後」を先に、「切る前」を後から付けても、ページでは 切る前＝上・切った後＝下 になる
  const mkJpeg = async (w, h, color) => Buffer.from((await page.evaluate(([w, h, c]) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const g = cv.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.font = '80px sans-serif'; g.fillText('9-3-1', 40, 120); return cv.toDataURL('image/jpeg', 0.8).split(',')[1]; }, [w, h, color])), 'base64');
  await page.setInputFiles('#cc-photo-after', [{ name: 'after.jpg', mimeType: 'image/jpeg', buffer: await mkJpeg(1500, 2000, '#4a6a3a') }]);
  await page.waitForTimeout(500);
  await page.setInputFiles('#cc-photo-before', [{ name: 'before.jpg', mimeType: 'image/jpeg', buffer: await mkJpeg(2400, 1800, '#7a5c3a') }]);
  await page.waitForTimeout(800);
  const pv = await page.evaluate(() => cityCapPhotos.map(p => ({ n: p.name, k: p.kind, data: p.src.startsWith('data:image/jpeg') })));
  T('写真2枚が端末で縮小されて付く（dataURL・1600px以内・種類つき）', pv.length === 2 && pv.every(p => p.data) && pv.some(p => p.k === 'before') && pv.some(p => p.k === 'after') && (await page.evaluate(() => new Promise(res => { const im = new Image(); im.onload = () => res(Math.max(im.width, im.height)); im.src = cityCapPhotos[0].src; }))) <= 1600, JSON.stringify(pv));
  T('写真のプレビューに「切る前（上）」「切った後（下）」の札が出る', (await page.$$eval('#cc-photo-preview img', els => els.length)) === 2 && /切る前（上）/.test(await page.$eval('#cc-photo-preview', el => el.textContent)) && /切った後（下）/.test(await page.$eval('#cc-photo-preview', el => el.textContent)), '');
  const ord = await page.evaluate(() => cityCapPhotosOrdered().map(p => p.kind));
  T('ページの順は 切る前 → 切った後', ord.join(',') === 'before,after', ord.join(','));

  // Googleマップの座標表示（DMS）から緯度経度を入れられる
  const dms = await page.evaluate(() => cityCapParseCoord('34°57\'25.9"N 139°51\'46.8"E'));
  T('DMS「34°57\'25.9"N 139°51\'46.8"E」→ 34.957194 / 139.863', dms && Math.abs(dms.lat - 34.957194) < 1e-5 && Math.abs(dms.lng - 139.863) < 1e-5, JSON.stringify(dms));
  const dec = await page.evaluate(() => [cityCapParseCoord('34.9572, 139.8630'), cityCapParseCoord('139.8630 34.9572'), cityCapParseCoord('abc')]);
  T('「34.9572, 139.8630」・経度緯度の逆順も読める。読めない文字列は null', dec[0].lat === 34.9572 && dec[0].lng === 139.863 && dec[1].lat === 34.9572 && dec[2] === null, JSON.stringify(dec));
  await page.fill('#cc-coord-paste', '34°57\'25.9"N 139°51\'46.8"E');
  await page.dispatchEvent('#cc-coord-paste', 'change');
  await page.waitForTimeout(200);
  const f1b = await page.evaluate(() => cityCapCollect());
  T('貼り付け欄に入れると緯度・経度の欄が埋まる', Math.abs(parseFloat(f1b.capture_lat) - 34.957194) < 1e-5 && Math.abs(parseFloat(f1b.capture_lng) - 139.863) < 1e-5, `${f1b.capture_lat}/${f1b.capture_lng}`);

  // 3) 票を作る（window.open を差し替えてHTMLを捕まえる）
  await page.evaluate(() => { window.__doc = ''; window.open = () => ({ document: { open() { window.__doc = ''; }, write(s) { window.__doc += s; }, close() {} } }); });
  await page.click('#cc-print-btn');
  await page.waitForTimeout(800);
  const html = await page.evaluate(() => window.__doc);
  const one = s => html.includes(s);
  T('票: 表題と様式の文言', one('有害鳥獣捕獲票') && one('（イノシシ等獣類別捕獲用）') && one('※太枠内を記入してください') && one('館山有害鳥獣対策協議会') && one('添付品：捕獲獣の尾'), String(html.length));
  T('票: ■ イノシシ／令和 8 年 9 月 3 日／（大字）出野尾', one('■ イノシシ') && one('□ ニホンジカ') && one('令和 8 年 　9 月 　3 日') && one('（大字）　出野尾'), '');
  T('票: ■ メス・胎児 ■ 無、50 cm・7.9 kg', one('□ オス（□ 幼）　■ メス（□ 幼）') && one('■ 無') && one('50　cm') && one('7.9　kg'), '');
  T('票: ■ くくりわな、■ 販売（■ 館山ジビエセンター）、わな設置日 令和8年9月1日', one('■ くくりわな') && one('□ 箱わな') && one('■ 販売（ ■ 館山ジビエセンター　□ ジビエ堂') && one('令和 8 年 　9 月 　1 日'), '');
  T('票: 捕獲者・止め刺し者 沖浩志 070-1410-8808、■ 刺殺、特記事項 協力員等', (html.match(/沖浩志/g) || []).length >= 3 && (html.match(/070-1410-8808/g) || []).length >= 2 && one('■ 刺殺（竹槍・ナイフなど）') && one('□ 射殺（銃）') && one('協力員等'), '');
  T('図面ページ: 地理院タイルと朱色×印だけ（見出し・捕獲者などの文字は無い）', /cyberjapandata\.gsi\.go\.jp\/xyz\/std\/15\//.test(html) && /class="xmark"[^>]*>✕/.test(html) && !one('捕獲場所（朱色×印）') && /class="page map-page"/.test(html), '');
  T('写真ページ: A4縦・上が「切る前」、下が「切った後」', !/landscape/.test(html) && /class="ph" data-kind="before"><img src="data:image\/jpeg[\s\S]*class="ph" data-kind="after"><img src="data:image\/jpeg/.test(html), '');
  T('選んだ個体に調査票の項目が保存される（PATCH・小字/体長/設置日/処理方法/止め刺し者）', patches.length === 1 && /id=eq\.i-330/.test(patches[0].qs) && patches[0].body.body_length_cm === 50 && patches[0].body.trap_set_date === '2026-09-01' && patches[0].body.disposal_method === '販売（館山ジビエセンター）' && patches[0].body.finisher_name === '沖浩志' && patches[0].body.has_fetus === false && patches[0].body.is_juvenile === false && !!patches[0].body.survey_downloaded_at, JSON.stringify(patches[0] || {}).slice(0, 200));
  T('保存の確認が画面に出る', /保存しました/.test(await page.$eval('body', el => el.textContent)), '');

  // 実際にPDFにして、ページ数と向きを測る（タイルは外部なので差し替える）
  const htmlPath = path.join(outDir, 'city-cap-test.html');
  fs.writeFileSync(htmlPath, html);
  const p2 = await ctx.newPage();
  await p2.route('**/cyberjapandata.gsi.go.jp/**', r => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64') }));
  await p2.goto('file://' + htmlPath);
  await p2.waitForTimeout(500);
  const pdfPath = path.join(outDir, 'city-cap-test.pdf');
  const pdfNone = path.join(outDir, 'city-cap-none.pdf');
  await p2.pdf({ path: pdfPath, preferCSSPageSize: true, printBackground: true });
  await p2.pdf({ path: pdfNone, format: 'A4', margin: { top: '0', right: '0', bottom: '0', left: '0' }, printBackground: true });
  const measure = f => JSON.parse(execFileSync('python3', ['-c', `
import pymupdf, json, sys
d = pymupdf.open(sys.argv[1])
mm = 25.4 / 72
out = {'pages': len(d), 'sizes': [[round(p.rect.width*mm), round(p.rect.height*mm)] for p in d], 'imgs': [len(p.get_images()) for p in d]}
p = d[0]; W, H = p.rect.width, p.rect.height
bl = [b for b in p.get_text('blocks') if b[4].strip()]
out['p1'] = {'left': min(b[0] for b in bl)*mm, 'top': min(b[1] for b in bl)*mm, 'right': (W-max(b[2] for b in bl))*mm, 'bottom': (H-max(b[3] for b in bl))*mm}
if len(d) >= 3:
    ims = sorted(d[2].get_image_info(), key=lambda i: i['bbox'][1])
    out['p3'] = [{'top': i['bbox'][1]*mm, 'w': (i['bbox'][2]-i['bbox'][0])*mm, 'h': (i['bbox'][3]-i['bbox'][1])*mm, 'left': i['bbox'][0]*mm} for i in ims]
    mp = sorted(d[1].get_image_info(), key=lambda i: i['bbox'][1])
    out['p2'] = {'imgs': len(mp), 'top': min(i['bbox'][1] for i in mp)*mm if mp else None, 'text': d[1].get_text().strip()[:40]}
print(json.dumps(out))`, f], { encoding: 'utf8' }));
  const m = measure(pdfPath), mn = measure(pdfNone);
  const fmt = p => `左${p.left.toFixed(1)} 上${p.top.toFixed(1)} 右${p.right.toFixed(1)} 下${p.bottom.toFixed(1)}mm`;
  T('PDF: 票・図面・写真 の3ページ・すべてA4縦', m.pages === 3 && m.sizes.every(s => s[0] === 210 && s[1] === 297), JSON.stringify(m.sizes));
  T('PDF: 票の余白は市役所の見本どおり（上14・左右18・下18mm 以上）', m.p1.left >= 17 && m.p1.top >= 13 && m.p1.right >= 17 && m.p1.bottom >= 17, fmt(m.p1));
  T('PDF: 印刷ダイアログで余白「なし」にしても同じ余白が残る', mn.pages === 3 && mn.p1.left >= 17 && mn.p1.top >= 13 && mn.p1.right >= 17 && mn.p1.bottom >= 17, `pages=${mn.pages} ${fmt(mn.p1)}`);
  T('PDF: 図面ページは地図（タイル）と×印だけで、文字は出典のみ', m.p2.imgs >= 6 && /^出典/.test(m.p2.text), JSON.stringify(m.p2));
  T('PDF: 写真ページは写真2枚が上下に並び、上が横長（切る前）・下が縦長（切った後）', m.imgs[2] === 2 && m.p3.length === 2 && m.p3[0].w > m.p3[0].h && m.p3[1].h > m.p3[1].w && m.p3[1].top > m.p3[0].top + m.p3[0].h - 1, JSON.stringify(m.p3));
  T('PDF: 写真も左右18mm以上の余白の中に収まる', m.p3.every(i => i.left >= 17 && i.left + i.w <= 193), JSON.stringify(m.p3.map(i => [i.left.toFixed(1), (i.left + i.w).toFixed(1)])));

  // 4) 保存に失敗したら画面に出る（票は作られる）
  failPatch = true;
  await page.evaluate(() => { window.__doc = ''; });
  await page.click('#cc-print-btn');
  await page.waitForTimeout(800);
  T('台帳への保存に失敗しても票は作られ、失敗が画面に出る', (await page.evaluate(() => window.__doc.length)) > 1000 && /保存に失敗しました/.test(await page.$eval('body', el => el.textContent)), '');
  failPatch = false;

  // 5) 手入力（緯度経度なし）: 図面ページ無し・写真なし → 1ページ
  await page.evaluate(() => cityCapOpen());
  await page.waitForTimeout(400);
  await page.fill('#cc-search', '加藤');
  await page.waitForTimeout(500);
  await page.click('#cc-search-results .cc-hit');
  await page.waitForTimeout(200);
  const f2 = await page.evaluate(() => cityCapCollect());
  T('シカ→ニホンジカ、銃猟→銃器、銃→射殺、幼獣、胎児は未記入', f2.species === 'ニホンジカ' && f2.capture_method === '銃器' && f2.finishing_method === '射殺（銃）' && f2.is_juvenile === '幼獣' && f2.has_fetus === '', `${f2.species}/${f2.capture_method}/${f2.finishing_method}/${f2.is_juvenile}/${f2.has_fetus}`);
  await page.evaluate(() => cityCapClearSelected());
  T('選択を外すと手入力扱い（台帳保存の選択肢が消える）', (await page.$eval('#cc-save-back-row', el => el.style.display)) === 'none' && (await page.evaluate(() => cityCapSelected)) === null, '');
  await page.evaluate(() => { window.__doc = ''; });
  await page.click('#cc-print-btn');
  await page.waitForTimeout(600);
  const html2 = await page.evaluate(() => window.__doc);
  T('緯度経度なし・写真なしは票だけ（図面・写真ページ無し）でPATCHもしない', html2.includes('■ ニホンジカ') && !/cyberjapandata/.test(html2) && !/photo-page"/.test(html2) && patches.length === 2, `patches=${patches.length}`);
  T('図面が付かない旨が画面に出る', /図面ページは付きません/.test(await page.$eval('body', el => el.textContent)), '');

  // 6) スマホ幅
  const of = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  T('スマホ幅で横スクロールしない', of <= 1, String(of));
  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
