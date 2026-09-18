// 捕獲票: 「この肉の物語」（お客さん向けページ）に捕獲者名を出してよいか（2026-09-18 沖）
//   きっかけ: 公開ページの写真（看板つきカメラ）に捕獲者名が焼き込まれていた。
//   1. 既定は「出してよい」。捕獲者マスタで「出さない」になっている人を選ぶと自動で「出さない」に切り替わる
//   2. 登録の POST に hunter_name_public が入る（出さない → false）。保存後に捕獲者マスタへ今回の選択を PATCH
//   3. 看板つきカメラの看板: hunter_name_public=false の個体は「捕獲者」行を入れない（true/未設定は入れる）
//   4. 編集で開くと登録済みの値（true→出してよい、false/未確認→出さない）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const HUNTERS = [
  { name: '加藤茂', phone: '', memo: '', furigana: 'かとうしげる', name_public: null },
  { name: '塩倉千春', phone: '', memo: '', furigana: 'しおくらちはる', name_public: false },
  { name: '沖浩志', phone: '', memo: '', furigana: 'おきひろし', name_public: true },
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  const writes = [];
  await page.route('**/*', r => {
    const u = decodeURIComponent(r.request().url()), m = r.request().method();
    if (u.startsWith('file:')) return r.continue();
    if (/cdn|jsdelivr|fonts\./.test(u)) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    const J = x => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (/\/hunters/.test(u) && m === 'GET') return J(HUNTERS);
    if (/\/hunters/.test(u) && m === 'PATCH') { writes.push({ t: 'hunters', u, body: JSON.parse(r.request().postData() || '{}') }); return J([{}]); }
    if (/\/individuals/.test(u) && m === 'POST') { const b = JSON.parse(r.request().postData() || '{}'); writes.push({ t: 'individuals', body: b }); return J([Object.assign({ id: 'new1' }, b, { label_id: 'TGC-08-T999' })]); }
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../capture-form.html')); await page.waitForTimeout(800);
  const results = []; const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);
  const toggle = () => page.evaluate(() => ({ st: state.hunter_name_public, on: [...document.querySelectorAll('[data-field="hunter_name_public"] .toggle-btn.active')].map(b => b.dataset.val).join() }));

  // 1) 既定は出してよい
  const t0 = await toggle();
  T('既定は「出してよい」', t0.st === '出す' && t0.on === '出す', JSON.stringify(t0));

  // マスタで「出さない」の人を選ぶ → 出さない。未確認の人 → そのまま。true の人 → 出す
  await page.evaluate(() => pickHunterSuggest('塩倉千春')); await page.waitForTimeout(300);
  const t1 = await toggle();
  T('マスタで「出さない」の人（塩倉）を選ぶと自動で「出さない」', t1.st === '出さない' && t1.on === '出さない', JSON.stringify(t1));
  await page.evaluate(() => pickHunterSuggest('沖浩志')); await page.waitForTimeout(300);
  const t2 = await toggle();
  T('マスタで「出してよい」の人（沖）を選ぶと「出してよい」に戻る', t2.st === '出す', JSON.stringify(t2));
  await page.evaluate(() => pickHunterSuggest('塩倉千春')); await page.waitForTimeout(300);
  await page.evaluate(() => pickHunterSuggest('加藤茂')); await page.waitForTimeout(300);
  const t3 = await toggle();
  T('未確認の人（加藤）を選んでも直前の選択のまま（勝手に変えない）', t3.st === '出さない', JSON.stringify(t3));

  // 2) 登録: 出さない → hunter_name_public=false、マスタへ PATCH
  await page.evaluate(() => { document.querySelector('[data-field="species"] .toggle-btn[data-val="キョン"]').click(); document.querySelector('[data-field="sex"] .toggle-btn[data-val="オス"]').click(); });
  await page.fill('#weight', '8'); await page.waitForTimeout(300);
  await page.evaluate(() => handleSubmit()); await page.waitForTimeout(900);
  const ind = writes.find(w => w.t === 'individuals'), hp = writes.find(w => w.t === 'hunters');
  T('登録の POST に hunter_name_public=false が入る', ind && ind.body.hunter_name_public === false && ind.body.hunter_name === '加藤茂', JSON.stringify(ind && { n: ind.body.hunter_name, p: ind.body.hunter_name_public }));
  T('保存後に捕獲者マスタ（加藤茂）へ name_public=false を PATCH', hp && /name=eq\.加藤茂/.test(hp.u) && hp.body.name_public === false, JSON.stringify(hp && { u: hp.u.slice(-40), b: hp.body }));
  T('登録後（resetForm）は「出してよい」に戻る', (await toggle()).st === '出す', '');

  // 3) 看板: false は捕獲者行なし、true/未設定はあり
  const board = await page.evaluate(() => ({
    no: arBoardData({ label_id: 'TGC-08-T332', serial_number: 541, capture_date: '2026-09-17', hunter_name: '小谷耕作', hunter_name_public: false, capture_city: '館山市', capture_area: '神余', sex: 'メス', weight_total: 22.9 }).lines.map(l => l[0]),
    yes: arBoardData({ label_id: 'TGC-08-T333', serial_number: 542, capture_date: '2026-09-17', hunter_name: '山﨑善夫', hunter_name_public: true, capture_city: '館山市', capture_area: '笠名', sex: 'メス', weight_total: 49.5 }).lines.map(l => l[0]),
    unset: arBoardData({ label_id: 'TGC-08-T334', serial_number: 543, capture_date: '2026-09-17', hunter_name: '八橋伸行', capture_city: '館山市', capture_area: '神余', sex: 'オス', weight_total: 34.7 }).lines.map(l => l[0]),
  }));
  T('看板: 出さない人は「捕獲者」行が無い', !board.no.includes('捕獲者') && board.no.includes('通し番号') && board.no.includes('捕獲場所'), board.no.join());
  T('看板: 出してよい・未設定は「捕獲者」行あり', board.yes.includes('捕獲者') && board.unset.includes('捕獲者'), board.yes.join() + ' / ' + board.unset.join());

  // 4) 編集で開くと登録済みの値
  const ed = await page.evaluate(() => {
    const out = {};
    setHunterPublicToggle('出す'); editRecordId = null;
    // 編集の fill と同じ規則（true→出す、false/null→出さない）
    [true, false, null].forEach(v => { setHunterPublicToggle(v === true ? '出す' : '出さない'); out[String(v)] = state.hunter_name_public; });
    return out;
  });
  T('編集: true→出す、false→出さない、未確認(null)→出さない', ed['true'] === '出す' && ed['false'] === '出さない' && ed['null'] === '出さない', JSON.stringify(ed));
  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
