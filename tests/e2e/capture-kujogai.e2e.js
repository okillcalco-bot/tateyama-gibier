// 捕獲票入力: アライグマ・ハクビシンの「駆除外」（市役所からの持込・個人宅など）（2026-10-05）
//
//   きっかけ
//     市役所から搬入されたアライグマを捕獲票入力で登録しようとすると、駆除の個体として
//     放血・搬送が必須、看板写真が「📷 撮影」待ちのまま、番号も仮-のままになった。
//     駆除外（TGC-08-アコ###）の区分は業務アプリの個体台帳にしか無く、捕獲票入力には無かった。
//
//   ここで測ること
//     1. 捕獲区分の欄はアライグマ・ハクビシンだけに出る（イノシシに切り替えると消えて区分も外れる）
//     2. 駆除外を選ぶと番号が TGC-08-アコ### になる（駆除外は通し番号なし → 番号の大きい順で次を出す）
//     3. 駆除（ア###）の次番号を探すときは アコ を混ぜない
//     4. 駆除外では放血・搬送が「任意」になり、未入力の一覧にも出ない
//     5. 保存すると AUTO-アコ・capture_category=駆除外 で送る（駆除なら null）
//     6. 今日の搬入一覧で、駆除外は「📷 撮影」ではなく「駆除外」と出る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());

  const queries = []; const posts = [];
  let today = [];
  await page.route('**/*', r => {
    const u = decodeURIComponent(r.request().url()); const m = r.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = (b, st) => r.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (!/\/rest\/v1\//.test(u)) return r.fulfill({ status: 200, body: '[]' });
    if (m === 'GET' && /\/individuals\?label_id=like\.TGC-08-/.test(u)) {
      queries.push(u);
      if (/\?label_id=like\.TGC-08-アコ\*/.test(u)) return J([{ serial_number: null, label_id: 'TGC-08-アコ002' }]);
      if (/like\.TGC-08-ア\*/.test(u)) return J([{ serial_number: 24, label_id: 'TGC-08-ア024' }]);
      return J([]);
    }
    if (m === 'GET' && /\/individuals\?or=\(capture_date/.test(u)) return J(today);
    if (m === 'POST' && /\/individuals/.test(u)) { const b = JSON.parse(r.request().postData() || '{}'); posts.push(Array.isArray(b) ? b[0] : b); return J([{ id: 'new1', ...(Array.isArray(b) ? b[0] : b), label_id: 'TGC-08-アコ003' }], 201); }
    if (/\/staff/.test(u)) return J([{ name: 'テスト' }]);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../capture-form.html'));
  await page.waitForTimeout(900);

  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);
  const vis = () => page.$eval('#categoryRow', el => getComputedStyle(el).display !== 'none');
  const click = sel => page.evaluate(s => document.querySelector(s).click(), sel);

  await click('[data-field="species"] [data-val="イノシシ"]');
  T('イノシシでは捕獲区分の欄が出ない', !(await vis()), '');
  await click('[data-field="species"] [data-val="アライグマ"]');
  await click('[data-field="capture_city"] [data-val="館山市"]');
  await page.waitForTimeout(300);
  T('アライグマでは捕獲区分の欄が出る', await vis(), '');
  const kujoLabel = await page.$eval('#indLabelId', el => el.value);
  const qKujo = queries.filter(q => /like\.TGC-08-ア\*/.test(q)).pop() || '';
  T('駆除の番号は ア025（アコ を混ぜずに探す）', kujoLabel === 'TGC-08-ア025' && /not\.like\.TGC-08-アコ\*/.test(qKujo), kujoLabel + ' ' + qKujo.split('?')[1]);

  await click('[data-field="capture_category"] [data-val="駆除外"]');
  await page.waitForTimeout(300);
  const koLabel = await page.$eval('#indLabelId', el => el.value);
  T('駆除外を選ぶと TGC-08-アコ003（通し番号なしでも番号の大きい順で次）', koLabel === 'TGC-08-アコ003', koLabel);
  const badges = await page.evaluate(() => [document.getElementById('bleedReqBadge').textContent, document.getElementById('transportReqBadge').textContent]);
  T('駆除外では放血・搬送が「任意」', badges.join(',') === '任意,任意', badges.join(','));
  const missing = await page.evaluate(() => collectMissing().join(','));
  T('駆除外では放血・搬送が未入力の一覧に出ない', !/放血|搬送/.test(missing), missing);
  T('説明（市役所の様式に入らない・写真不要）が出る', await page.$eval('#categoryNote', el => getComputedStyle(el).display !== 'none' && /市役所/.test(el.textContent)), '');

  // 保存
  await page.evaluate(() => {
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.value = v; };
    set('captureDate', '2026-10-05'); set('captureTime', '09:00'); set('captureArea', '館山'); set('hunterName', 'テスト');
    set('weight', '4.3'); set('recorder', 'テスト');
    document.querySelector('[data-field="capture_method"] [data-val="箱罠"]')?.click();
    document.querySelector('[data-field="sex"] [data-val="メス"]')?.click();
  });
  await page.evaluate(() => handleSubmit());
  await page.waitForTimeout(1200);
  const post = posts[0] || {};
  T('保存は AUTO-アコ・capture_category=駆除外', post.label_id === 'AUTO-アコ' && post.capture_category === '駆除外', JSON.stringify({ l: post.label_id, c: post.capture_category, s: post.serial_number }));

  // イノシシに切り替えると区分が外れる
  await page.evaluate(() => { if (typeof resetForm === 'function') resetForm(); });
  await page.waitForTimeout(100);
  await click('[data-field="species"] [data-val="アライグマ"]');
  await click('[data-field="capture_category"] [data-val="駆除外"]');
  await click('[data-field="species"] [data-val="イノシシ"]');
  await page.waitForTimeout(200);
  T('別の獣種に切り替えると駆除外が外れる', await page.evaluate(() => !isKujoGai() && !state.capture_category), '');

  // 今日の搬入一覧
  today = [
    { id: 'a', label_id: 'TGC-08-アコ003', species: 'アライグマ', capture_category: '駆除外', image_url: null, capture_time: '09:00', hunter_name: '沖浩志', created_at: '2026-10-05T05:00:00Z' },
    { id: 'b', label_id: 'TGC-08-ア025', species: 'アライグマ', capture_category: null, image_url: null, capture_time: '08:00', hunter_name: 'A', created_at: '2026-10-05T04:00:00Z' },
  ];
  await page.evaluate(async () => { await loadList(); });
  await page.waitForTimeout(400);
  const cards = await page.$$eval('.card', els => els.map(e => e.innerText.replace(/\s+/g, ' ')));
  const ko = cards.find(c => c.includes('アコ003')) || '', kj = cards.find(c => c.includes('ア025')) || '';
  T('一覧: 駆除外は「駆除外」、駆除は「📷 撮影」', /駆除外/.test(ko) && !/撮影/.test(ko) && /撮影/.test(kj), JSON.stringify([ko.slice(0, 60), kj.slice(0, 60)]));
  T('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
