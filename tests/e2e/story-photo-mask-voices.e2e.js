// この肉の物語（s.html）: 写真を切らずに見せる・捕獲者名を出さない個体は看板を覆う・感想は匿名が基本（2026-09-18）
//   1. 写真は max-height/cover で切らない（幅いっぱい・高さは自動）
//   2. hunter_public が true でない看板つき写真（photo_kind=board）は左下に覆い（番号・捕獲日だけ）を重ねる。
//      覆いは写真の実寸から看板の高さの割合で決まる（縦写真 390px 基準: 番号行＋5行 ≒ 28%＋余裕）
//   3. hunter_public=true、または出店シートの写真（photo_kind=sheet）は覆わない
//   4. 声: ニックネーム無しは「匿名さん」、あれば「◯◯ さん」。スタンプの集計（うまい！ ×2）が出る
//   5. 送ると一番上の声が「あなたの一行」として目立つ
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

// 1×1 の JPEG ではなく、縦長 300×400 の PNG を data URL で作る（naturalWidth/Height を測るため）
function pngDataUrl(w, h) {
  const zlib = require('zlib');
  const crc = (buf) => { let c, crcTable = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } let cr = 0xffffffff; for (const b of buf) cr = crcTable[(cr ^ b) & 0xff] ^ (cr >>> 8); return (cr ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h, 0x80); for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + png.toString('base64');
}
const PHOTO = pngDataUrl(300, 400);

const base = (over) => Object.assign({
  individual_label: 'TGC-08-T333', product: null,
  individual: { label: 'TGC-08-T333', species: 'イノシシ', sex: 'メス', weight_total: 49.5, capture_date: '2026/09/17', place: '館山市 笠名', method: 'くくり罠',
    radiation_date: '2026/09/18', radiation_result: '検出下限値以下', processed_date: '2026/09/17', processed_kind: 'organ', aging_days: null, hunter_public: false },
  parts: [{ part: 'レバー', kg: 1 }], photo: PHOTO, photo_kind: 'board',
  voices: [
    { nickname: null, rating: 5, dish: 'レバから', comment: 'くさみゼロ', stamps: ['うまい！', 'くさみゼロ'], at: '2026/09/19' },
    { nickname: '館山の田中', rating: 4, dish: null, comment: null, stamps: ['うまい！'], at: '2026/09/19' },
  ], voice_count: 2,
  sheet: { product_note: 'レバから子', story_text: null }, event: { id: 'ev1', venue: 'やわたんまち', title: 'やわたんまち', date: '2026/09/19' }, mileage: null,
}, over || {});

async function open(story, onAdd) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext({ viewport: { width: 390, height: 844 } }).then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let cur = story;
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith('file:') || u.startsWith('data:')) return r.continue();
    const m = u.match(/\/rest\/v1\/rpc\/(\w+)/);
    if (m) {
      if (m[1] === 'story_add_voice_individual') { cur = onAdd(cur, JSON.parse(r.request().postData() || '{}')); return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, voice_count: cur.voice_count }) }); }
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(m[1] === 'story_get_individual' ? cur : null) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
  await page.goto('file://' + path.resolve(__dirname, '../../s.html') + '?i=TGC-08-T333&e=ev1'); await page.waitForTimeout(700);
  return { browser, page, errors };
}

(async () => {
  const results = []; const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  // ── A) 名前を出さない個体・看板つき写真 ──
  {
    const { browser, page, errors } = await open(base(), (cur, body) => Object.assign({}, cur, { voice_count: 3, voices: [{ nickname: body.p_nickname || null, rating: body.p_rating, dish: body.p_dish, comment: body.p_comment, stamps: body.p_stamps, at: '2026/09/19' }].concat(cur.voices) }));
    const ph = await page.evaluate(() => { const img = document.querySelector('.ph-wrap img'); const m = document.querySelector('.sign-mask'); const ir = img.getBoundingClientRect(), mr = m && m.getBoundingClientRect();
      return { imgW: ir.width, imgH: ir.height, nat: img.naturalWidth + 'x' + img.naturalHeight, maxH: getComputedStyle(img).maxHeight, fit: getComputedStyle(img).objectFit, mask: !!m, mText: m && m.textContent, mL: mr && (mr.left - ir.left), mB: mr && (ir.bottom - mr.bottom), mW: mr && mr.width, mH: mr && mr.height, blur: m && getComputedStyle(m).backdropFilter }; });
    T('写真は切らない（max-height なし・高さは実寸比 300×400 → 幅の4/3）', ph.maxH === 'none' && Math.abs(ph.imgH - ph.imgW * 4 / 3) < 2, JSON.stringify(ph));
    T('看板の覆いがある（番号と捕獲日だけ・ぼかし）', ph.mask && /TGC-08-T333/.test(ph.mText) && /捕獲日 2026\/09\/17/.test(ph.mText) && /blur/.test(ph.blur || ''), ph.mText);
    T('覆いは左下（左3%・下2.3%）で幅62%', ph.mL >= 0 && ph.mL < ph.imgW * 0.05 && ph.mB >= 0 && ph.mB < ph.imgH * 0.04 && Math.abs(ph.mW - ph.imgW * 0.62) < 3, JSON.stringify({ mL: ph.mL, mB: ph.mB, mW: ph.mW, imgW: ph.imgW }));
    // 縦 390px 基準: codeF=23.4 lineF=14.04 → boxH=20+31.6+94.8=146.4 / logH=520 → 28.2% +5 = 33%
    T('覆いの高さは看板の高さの割合（縦写真 ≒ 33%）', Math.abs(ph.mH / ph.imgH - 0.33) < 0.02, (ph.mH / ph.imgH).toFixed(3));
    const v = await page.evaluate(() => ({ names: [...document.querySelectorAll('.voice .nm')].map(e => e.textContent), tally: [...document.querySelectorAll('.card .chips .chip')].map(e => e.textContent).filter(t => /×/.test(t)), label: document.querySelector('label[for="nickname"]').textContent, hasMine: !!document.querySelector('.voice.mine') }));
    T('声: ニックネーム無しは「匿名さん」、あれば「館山の田中 さん」', v.names.join('|') === '匿名さん|館山の田中 さん', v.names.join('|'));
    T('スタンプの集計（うまい！ ×2・くさみゼロ ×1）', v.tally.join('|') === 'うまい！ ×2|くさみゼロ ×1', v.tally.join('|'));
    T('ニックネーム欄は「匿名さん」が既定と分かる', /匿名さん/.test(v.label), v.label);
    T('送る前は「あなたの一行」は無い', !v.hasMine, '');
    // 5) 送る → 一番上が「あなたの一行」
    await page.evaluate(() => { toggleStamp('また食べたい'); document.getElementById('nickname').value = 'はじめてジビエ'; });
    await page.click('#send'); await page.waitForTimeout(800);
    const after = await page.evaluate(() => { const m = document.querySelector('.voice.mine'); return { mine: !!m, first: m && document.querySelector('.voice') === m, nm: m && m.querySelector('.nm').textContent, badge: m && m.querySelector('.mine-badge') && m.querySelector('.mine-badge').textContent, count: (document.querySelector('.card h2 .ic + *') || {}).textContent, head: [...document.querySelectorAll('.card h2')].map(h => h.textContent).find(t => /食べた人の声/.test(t)) }; });
    T('送ると一番上の声が「あなたの一行」（ニックネーム「はじめてジビエ さん」）', after.mine && after.first && after.nm === 'はじめてジビエ さん' && after.badge === 'あなたの一行', JSON.stringify(after));
    T('人数が3人に増える', /（3人）/.test(after.head || ''), after.head);
    T('pageerrorなし(A)', errors.length === 0, errors.join(' / '));
    await browser.close();
  }

  // ── B) 名前を出してよい個体 → 覆いなし。出店シートの写真も覆いなし ──
  {
    const st = base({}); st.individual = Object.assign({}, st.individual, { hunter_public: true });
    const { browser, page, errors } = await open(st, c => c);
    T('出してよい個体は覆いが無い', !(await page.$('.sign-mask')), '');
    await browser.close();
    const st2 = base({ photo_kind: 'sheet' });
    const o2 = await open(st2, c => c);
    T('出店シートの写真（看板なし）は覆いが無い', !(await o2.page.$('.sign-mask')), '');
    T('pageerrorなし(B)', errors.length === 0 && o2.errors.length === 0, errors.concat(o2.errors).join(' / '));
    await o2.browser.close();
  }

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
