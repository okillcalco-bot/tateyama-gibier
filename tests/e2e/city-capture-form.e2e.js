// 書類・帳票「市役所用票作成」: 有害鳥獣捕獲票（票＋図面＋写真ページ）を個体検索/手入力＋写真添付で出す
//
//   きっかけ（2026-09-14）
//     市役所（館山有害鳥獣対策協議会）への捕獲票は capture-form の搬入一覧からしか出せず、
//     搬入していない個体（自家消費・埋却）や、あとから写真を付けて出したいときに作れなかった。
//
//   ここで測ること
//     1. 書類・帳票タブにボタンがあり、モーダルで個体検索（個体番号・通し番号・捕獲者）→ 選ぶと票の項目に転記される
//        （くくり罠→くくりわな、ナイフ→刺殺、シカ→ニホンジカ、捕獲者の電話は hunters から）
//     2. 写真を2枚付けると、印刷HTMLは 票（縦）・図面（縦・×印）・写真ページ（横・2枚）の3ページになり、
//        実際にPDFにして 3ページ / 1ページ目は縦 / 3ページ目は横 であることを測る
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

  // 2) 写真2枚（横長・縦長）を付ける
  const mkJpeg = async (w, h, color) => Buffer.from((await page.evaluate(([w, h, c]) => { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; const g = cv.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.font = '80px sans-serif'; g.fillText('9-3-1', 40, 120); return cv.toDataURL('image/jpeg', 0.8).split(',')[1]; }, [w, h, color])), 'base64');
  await page.setInputFiles('#cc-photos', [
    { name: 'photo1.jpg', mimeType: 'image/jpeg', buffer: await mkJpeg(2400, 1800, '#7a5c3a') },
    { name: 'photo2.jpg', mimeType: 'image/jpeg', buffer: await mkJpeg(1500, 2000, '#4a6a3a') },
  ]);
  await page.waitForTimeout(800);
  const pv = await page.evaluate(() => cityCapPhotos.map(p => ({ n: p.name, len: p.src.length, data: p.src.startsWith('data:image/jpeg') })));
  T('写真2枚が端末で縮小されて付く（dataURL・1600px以内）', pv.length === 2 && pv.every(p => p.data) && (await page.evaluate(() => new Promise(res => { const im = new Image(); im.onload = () => res(Math.max(im.width, im.height)); im.src = cityCapPhotos[0].src; }))) <= 1600, JSON.stringify(pv));
  T('写真のプレビューが出る', (await page.$$eval('#cc-photo-preview img', els => els.length)) === 2, '');

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
  T('図面ページ: 地理院タイルと朱色×印', /cyberjapandata\.gsi\.go\.jp\/xyz\/std\/15\//.test(html) && /class="xmark"[^>]*>✕/.test(html) && one('捕獲場所（朱色×印）'), '');
  T('写真ページ: 横向きの名前付きページに写真2枚', /@page land \{ size: A4 landscape/.test(html) && /\.photo-page \{ page: land/.test(html) && (html.match(/class="ph"><img src="data:image\/jpeg/g) || []).length === 2, '');
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
  await p2.pdf({ path: pdfPath, preferCSSPageSize: true, printBackground: true });
  const m = JSON.parse(execFileSync('python3', ['-c', `
import pymupdf, json, sys
d = pymupdf.open(sys.argv[1])
mm = 25.4 / 72
out = {'pages': len(d), 'sizes': [[round(p.rect.width*mm), round(p.rect.height*mm)] for p in d], 'imgs': [len(p.get_images()) for p in d]}
p = d[0]; xs1 = [b[2] for b in p.get_text('blocks') if b[4].strip()]; ys1 = [b[3] for b in p.get_text('blocks') if b[4].strip()]
out['p1_right'] = max(xs1)*mm; out['p1_bottom'] = max(ys1)*mm
print(json.dumps(out))`, pdfPath], { encoding: 'utf8' }));
  T('PDF: 票・図面・写真 の3ページ', m.pages === 3, JSON.stringify(m.sizes));
  T('PDF: 1ページ目は縦（A4 210×297）で票が1ページに収まる', m.sizes[0][0] === 210 && m.sizes[0][1] === 297 && m.p1_bottom <= 290, `${JSON.stringify(m.sizes[0])} 下端=${(m.p1_bottom || 0).toFixed(1)}mm`);
  T('PDF: 3ページ目は横（A4 297×210）で写真が2枚', m.sizes[2][0] === 297 && m.sizes[2][1] === 210 && m.imgs[2] === 2, `${JSON.stringify(m.sizes[2])} imgs=${m.imgs[2]}`);

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
