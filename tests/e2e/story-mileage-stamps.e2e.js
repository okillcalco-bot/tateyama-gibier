// 「この肉の物語」: フードマイレージ表示・スタンプ・感想の即掲載（やわたんまち 2026-09-19/20 向け）
//
//   きっかけ（2026-09-16）
//     出店で「いま食べているのがどんな一頭か」を見せ、QRから詳細と感想欄へ。特典は付けず、
//     「あなたの一言がこの一頭の記録の最後の一行になる」ことを意味づけにして書いてもらう。
//     距離（km）と フードマイレージ（重量×距離＝kg・km）は別の指標として扱い、混同しない。
//
//   ここで測ること
//     1. ?i=個体&e=出店 で開くと、個体RPCに p_event_id が渡る（会場までの距離・今日の商品が出せる）
//     2. 「このお肉が旅した距離」が 捕獲地点→センター／センター→販売・提供地点／合計 で最初から見える
//     3. 「フードマイレージって？」は閉じたアコーディオンで、開くと 重量×距離 の説明が出る
//     4. 商品重量が無い（個体から開いた）ときは kg・km を出さない（生体重量を使わない）
//     5. 参考比較は「どれくらい近い？ 参考比較」で、値は参考値・概算と分かり、出典が出る。出典の無い値は出さない
//     6. 「この一頭は、館山の山から○km。」が大きく出る
//     7. 販売・提供地点が無いとき（パックのQR）は「捕獲地点 → 館山ジビエセンター まで」と明記し、合計を出さない
//     8. 商品重量があるとき（パック）は 商品重量×距離 の kg・km が出る
//     9. 座標が無ければ「距離を出せません」と正直に出す。参考比較の設定が取れなくても既定値で出る
//    10. スタンプだけで送れる（p_stamps が渡る）。送信後に「○人目の声」と出て、一覧に即掲載される
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
const REF = { title: 'どれくらい近い？ 参考比較', note: '一般的な輸送距離の参考値・概算です。', items: [
  { name: '豪州産の牛肉', km: 6600, kind: 'estimate', source: '館山ジビエセンター試算（主産地: クイーンズランド州）', sourceUrl: null, calculationNote: '産地の代表点〜センターの直線距離の概算' },
  { name: '米国産の豚肉', km: 9800, kind: 'estimate', source: '館山ジビエセンター試算（主産地: 中西部）', sourceUrl: 'https://example.test/src', calculationNote: '同上' },
  { name: '出典なしの値', km: 12345, kind: 'estimate', source: null, sourceUrl: null, calculationNote: '' },
] };

async function open(query, reply, { refFails } = {}) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const calls = [];
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith('file:')) return r.continue();
    if (/example\.test\/photo/.test(u)) return r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64') });
    if (/\/rest\/v1\/app_settings/.test(u)) { calls.push({ fn: 'app_settings' }); return refFails ? r.fulfill({ status: 500, body: 'boom' }) : r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ value: REF }]) }); }
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

  // ── 1〜6, 10: 出店の個体シートのQR（?i=&e=）──
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
    const first = calls.find(c => c.fn !== 'app_settings') || {};
    T('個体RPCに p_event_id が渡る', first.fn === 'story_get_individual' && first.body.p_label === 'TGC-08-T276' && first.body.p_event_id === '0f0e0d0c-0b0a-4908-8706-050403020100', JSON.stringify(first));
    T('参考比較の値を app_settings から読む', calls.some(c => c.fn === 'app_settings'), '');
    const txt = await page.textContent('#main');
    T('今日の商品・ひとこと・会場が出る', /串焼き＝モモ/.test(txt) && /神余の栗林/.test(txt) && /やわたんまち/.test(txt), '');
    T('写真が出る', await page.$('#main img[src*="photo.jpg"]') !== null, '');
    // 距離（最初から見える）
    T('「このお肉が旅した距離」が最初から見える', /このお肉が旅した距離/.test(txt), '');
    T('捕獲地点 → 館山ジビエセンター 2.1 km', /捕獲地点 → 館山ジビエセンター[\s\S]{0,40}2\.1 km/.test(txt), '');
    T('館山ジビエセンター → やわたんまち 3.6 km', /館山ジビエセンター → やわたんまち[\s\S]{0,40}3\.6 km/.test(txt), '');
    T('合計 5.7 km', /合計[\s\S]{0,30}5\.7 km/.test(txt), '');
    T('「まで」の注記は出ない（販売・提供地点まで揃っている）', !/館山ジビエセンター まで/.test(txt) && !/まだ含まれていません/.test(txt), '');
    T('地区の概ね中心で数えている注記', /捕獲地区のおおよその中心/.test(txt), '');
    // 説明アコーディオン
    const infoOpen = await page.$eval('#mileInfo', d => d.open);
    T('「フードマイレージって？」は閉じている', infoOpen === false && /フードマイレージって？/.test(txt), String(infoOpen));
    T('閉じている間は説明文が見えない', (await page.isVisible('#mileInfo > div')) === false, '');
    await page.click('#mileInfo summary');
    T('開くと 重量×距離 の説明が出る', await page.$eval('#mileInfo', d => d.open) && /食品の重量 × 輸送距離/.test(txt) && /輸送に関する指標であり/.test(txt), '');
    // 厳密値（個体から開いたときは商品重量が無いので出さない）
    T('商品重量が無ければ kg・km を出さない（生体重量26.3kgを使わない）', await page.$('#mileKgKm') === null && !/kg・km/.test(txt), '');
    // 参考比較
    T('参考比較のボタンがあり、中身は隠れている', await page.$eval('#mileBtn', b => b.textContent) === 'どれくらい近い？ 参考比較を見る' && await page.$eval('#mileBody', e => e.style.display === 'none'), '');
    await page.click('#mileBtn');
    const mt = await page.textContent('#mileBody');
    T('見出し「どれくらい近い？ 参考比較」と「参考値・概算」', /どれくらい近い？ 参考比較/.test(mt) && /参考値・概算/.test(mt), mt.slice(0, 120));
    T('比較対象は約 6,600 km・約 9,800 km（設定値）', /豪州産の牛肉/.test(mt) && /約 6,600 km/.test(mt) && /約 9,800 km/.test(mt), '');
    T('出典の無い値は出さない', !/出典なしの値/.test(mt) && !/12,345/.test(mt), '');
    T('何分の1かが出る（6600/5.7≒1,158分の1）', /約1,158分の1/.test(mt), (mt.match(/約[\d,]+分の1/) || [''])[0]);
    T('出典と注記に source / URL / calculationNote が出る', /館山ジビエセンター試算/.test(mt) && /直線距離の概算/.test(mt) && await page.$('#mileBody a[href="https://example.test/src"]') !== null, '');
    T('燃料の推定など、実測でない数字を混ぜない', !/ガソリン/.test(txt), '');
    // 一番伝えたい一文
    const msg = await page.textContent('#mileMsg');
    T('「この一頭は、館山の山から2.1 km。」が出る', /この一頭は、館山の山から2\.1 km。/.test(msg), msg.slice(0, 60));
    T('「この地域に生きていた命を、この地域で食材にしています」', /遠くから運ばれてきた食材ではなく/.test(msg) && /この地域で食材にしています/.test(msg), '');
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

  // ── 7〜8: パックのQR（?c=）。販売・提供地点は無い。商品重量がある ──
  {
    const { browser, page, errors } = await open('?c=12345678', fn => fn === 'story_get'
      ? { scan_code: '12345678', product: { name: 'モモ', kg: 0.85, ident: 'TGC-08-T276-MO' }, individual: BASE.individual, parts: BASE.parts, voices: [],
          mileage: { capture: { lat: 34.95, lng: 139.86, src: 'area' }, center: { lat: 34.968, lng: 139.8535 }, venue: null, leg1_km: 2.1, leg2_km: null, total_km: 2.1 } } : null);
    const txt = await page.textContent('#main');
    T('パック: 「捕獲地点 → 館山ジビエセンター まで」と明記し、合計を出さない', /捕獲地点 → 館山ジビエセンター まで[\s\S]{0,40}2\.1 km/.test(txt) && /まだ含まれていません/.test(txt) && !/合計/.test(txt), '');
    T('パック: 商品重量 0.85kg × 2.1km ＝ 1.8 kg・km が出る', await page.$('#mileKgKm') !== null && /この商品のフードマイレージ[\s\S]{0,30}1\.8 kg・km/.test(txt) && /商品重量 0\.85 kg × 移動距離 2\.1 km（捕獲地点→センターまで）/.test(txt), '');
    T('パック: 「このお肉（センターまで）」として比較する', /このお肉（センターまで）/.test(await page.textContent('#mileBody')), '');
    T('パック: 「この一頭は、館山の山から2.1 km。」', /この一頭は、館山の山から2\.1 km。/.test(await page.textContent('#mileMsg')), '');
    const fm = await page.evaluate(() => [foodMileageKgKm(0.85, 2.1), foodMileageKgKm(null, 5), foodMileageKgKm(2, 0), foodMileageKgKm(0, 3)]);
    T('関数: 重量か距離が無ければ null（0にしない）、あれば 重量×距離', JSON.stringify(fm) === '[1.8,null,null,null]', JSON.stringify(fm));
    const model = await page.evaluate(() => buildMileageModel({ capture: { lat: 1, lng: 1 }, center: { lat: 1, lng: 1.1 }, venue: { name: '店', lat: 1, lng: 1.2 }, leg1_km: 11.1, leg2_km: 11.1, total_km: 22.2 }, { kg: 2 }));
    T('関数: 販売地点があれば legs 2本・合計・kg・km（将来の拡張用の形）', model.legs.length === 2 && model.complete === true && model.totalKm === 22.2 && model.kgKm === 44.4 && 'transport' in model && 'co2' in model, JSON.stringify(model));
    T('（パック）ページエラーなし', errors.length === 0, errors.join(' / '));
    await browser.close();
  }

  // ── 9: 座標が未登録のとき（参考比較の設定も取れない） ──
  {
    const { browser, page, errors } = await open('?i=TGC-08-T276', fn => fn === 'story_get_individual'
      ? Object.assign({}, BASE, { sheet: null, event: null, mileage: { capture: null, center: BASE.mileage.center, venue: null, leg1_km: null, leg2_km: null, total_km: null } }) : null, { refFails: true });
    const txt = await page.textContent('#main');
    T('座標が無ければ「距離を出せません」と正直に出す', /距離を出せません/.test(txt) && !/km/.test(txt.replace(/km・km/g, '')), '');
    T('座標が無くても「この一頭は、館山の山から。」は出る（km なし）', /この一頭は、館山の山から。/.test(await page.textContent('#mileMsg')), '');
    T('比較ボタンは出ない', await page.$('#mileBtn') === null, '');
    T('設定が取れなくても既定値で動く（エラーにしない）', errors.length === 0, errors.join(' / '));
    await browser.close();
  }

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
