// 「この肉の物語」: フードマイレージ・スタンプ・感想の即掲載（やわたんまち 2026-09-19/20 向け）
//
//   きっかけ（2026-09-16）
//     出店で「いま食べているのがどんな一頭か」を見せ、QRから詳細と感想欄へ。特典は付けず、
//     「あなたの一言がこの一頭の記録の最後の一行になる」ことを意味づけにして書いてもらう。
//     ジビエは「獲れた山→センター→会場」しか動かないので、輸入肉との距離の差を見せる。
//
//   ここで測ること
//     1. ?i=個体&e=出店 で開くと、個体RPCに p_event_id が渡る（会場までの距離・今日の商品が出せる）
//     2. 「🚚 距離を見る」ボタンがあり、押すと 山→センター / センター→会場 / 合計 と輸入肉との比較が出る
//     3. 座標が未登録なら「距離を出せません」と正直に出す
//     4. スタンプだけで送れる（p_stamps が渡る）。送信後に「○人目の声」と出て、一覧に即掲載される
//     5. 出店の「今日の商品」「ひとこと」「写真」がページに出る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const BASE = {
  individual_label: 'TGC-08-T276', product: null,
  individual: { label: 'TGC-08-T276', species: 'イノシシ', sex: 'メス', weight_total: 26.3, capture_date: '2026/09/03', place: '館山市 神余', method: 'くくり罠',
    radiation_date: '2026/09/05', radiation_result: '検出下限値以下', processed_date: '2026/09/04', aging_days: 1 },
  parts: [{ part: 'モモ', kg: 2.1 }],
  voices: [{ nickname: '館山の田中', rating: 5, dish: '串焼き', stamps: ['うまい！'], comment: null, at: '2026/09/19' }],
  voice_count: 1,
  photo: 'https://example.test/photo.jpg',
  sheet: { product_note: '串焼き＝モモ', story_text: '神余の栗林で獲れた、脂ののった一頭' },
  event: { id: 'ev1', venue: 'やわたんまち', title: null, date: '2026/09/19' },
  mileage: { capture: { lat: 34.95, lng: 139.86, src: 'area' }, center: { lat: 34.968, lng: 139.8535 }, venue: { name: 'やわたんまち', lat: 34.997, lng: 139.87 }, leg1_km: 2.1, leg2_km: 3.6, total_km: 5.7 },
};

async function open(query, reply) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const calls = [];
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith('file:')) return r.continue();
    if (/example\.test/.test(u)) return r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64') });
    const m = u.match(/\/rest\/v1\/rpc\/(\w+)/);
    if (m) {
      let body = {}; try { body = JSON.parse(r.request().postData() || '{}'); } catch (e) {}
      calls.push({ fn: m[1], body });
      const res = reply(m[1], body, calls);
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res === undefined ? null : res) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
  await page.goto('file://' + path.resolve(__dirname, '../../s.html') + query);
  await page.waitForTimeout(500);
  return { browser, page, errors, calls };
}

(async () => {
  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  // ── 1〜2, 4〜5: 出店の個体シートのQR（?i=&e=）──
  {
    let voices = BASE.voices.slice(); let count = 1;
    const { browser, page, errors, calls } = await open('?i=TGC-08-T276&e=0f0e0d0c-0b0a-4908-8706-050403020100', (fn, body) => {
      if (fn === 'story_get_individual') return Object.assign({}, BASE, { voices, voice_count: count });
      if (fn === 'story_add_voice_individual') {
        count++; voices = [{ nickname: body.p_nickname || null, rating: body.p_rating, dish: body.p_dish, stamps: body.p_stamps, comment: body.p_comment, at: '2026/09/19' }].concat(voices);
        return { ok: true, voice_count: count };
      }
      return null;
    });
    const first = calls[0] || {};
    T('個体RPCに p_event_id が渡る', first.fn === 'story_get_individual' && first.body.p_label === 'TGC-08-T276' && first.body.p_event_id === '0f0e0d0c-0b0a-4908-8706-050403020100', JSON.stringify(first));
    const txt = await page.textContent('#main');
    T('今日の商品・ひとこと・会場が出る', /串焼き＝モモ/.test(txt) && /神余の栗林/.test(txt) && /やわたんまち/.test(txt), '');
    T('写真が出る', await page.$('#main img[src*="photo.jpg"]') !== null, '');
    T('「距離を見る」ボタンがある', await page.$('#mileBtn') !== null, '');
    T('押す前は距離の中身を隠している', await page.$eval('#mileBody', e => e.style.display === 'none'), '');
    await page.click('#mileBtn');
    const mt = await page.textContent('#mileBody');
    T('山→センター 2.1 km と センター→やわたんまち 3.6 km が出る', /山→センター/.test(mt) && /2\.1 km/.test(mt) && /やわたんまち/.test(mt) && /3\.6 km/.test(mt), mt.slice(0, 200));
    T('合計 5.7 km と輸入肉との比較（豪州産の牛肉 約 7,800 km）が出る', /5\.7 km/.test(mt) && /豪州産の牛肉/.test(mt) && /7,800/.test(mt), '');
    T('何分の1かが出る（7800/5.7≒1,368分の1）', /約1,368分の1/.test(mt), mt.match(/約[\d,]+分の1/) && mt.match(/約[\d,]+分の1/)[0]);
    T('特典の文言が無い（意味づけで書いてもらう）', !/割引|クーポン|特典/.test(txt), '');
    T('「最後の一行」の意味づけが出る', /最後の一行/.test(txt) && /猟師/.test(txt), '');
    T('これまでの人数（1人）が出る', /これまでに 1人/.test(txt), '');

    // スタンプだけで送る
    T('スタンプが6つある', (await page.$$('#stamps button')).length === 6, '');
    await page.click('#stamps button[data-s="うまい！"]');
    await page.click('#stamps button[data-s="また食べたい"]');
    await page.click('#send');
    await page.waitForTimeout(500);
    const add = calls.find(c => c.fn === 'story_add_voice_individual');
    T('スタンプが p_stamps で送られる（星・文章なしでも送れる）', add && JSON.stringify(add.body.p_stamps) === '["うまい！","また食べたい"]' && add.body.p_rating === null && add.body.p_comment === '', add && JSON.stringify(add.body));
    const after = await page.textContent('#main');
    T('送信後に「2人目の声」と出る', /2人目の声/.test(after) && /一行が加わりました/.test(after), (after.match(/ありがとうございます[^。]*。/) || [''])[0]);
    T('送った声がすぐ一覧に載る（即掲載）', /また食べたい/.test(after) && /（2人）/.test(after), '');
    T('ページエラーなし', errors.length === 0, errors.join(' / '));
    await browser.close();
  }

  // ── 3: 座標が未登録のとき ──
  {
    const { browser, page, errors } = await open('?i=TGC-08-T276', fn => fn === 'story_get_individual'
      ? Object.assign({}, BASE, { sheet: null, event: null, mileage: { capture: null, center: BASE.mileage.center, venue: null, leg1_km: null, leg2_km: null, total_km: null } }) : null);
    await page.click('#mileBtn');
    const mt = await page.textContent('#mileBody');
    T('座標が無ければ「距離を出せません」と正直に出す', /距離を出せません/.test(mt) && !/km/.test(mt.replace(/km\/L/g, '')), mt.slice(0, 120));
    T('（e無し）ページエラーなし', errors.length === 0, errors.join(' / '));
    await browser.close();
  }

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
