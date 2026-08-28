// 出店シート（お客様に見せる「今日はどの個体を食べられる？」の一覧）
//   ・A4の実寸で描いて、6個体が枠からはみ出さないこと・QRが文字に重ならないことを実測する
//   ・QRの中身をデコードし直して、その個体の物語ページのURLに戻ることを確かめる
//   ・在庫→個体のまとめ方、選択と枚数、印刷の分割を画面から動かして確かめる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const LABELS = ['TGC-08-T276', 'TGC-08-M170', 'TGC-08-T265', 'TGC-08-M163',
  'TGC-08-T260', 'TGC-08-M167', 'TGC-08-シ010', 'TGC-08-M169'];

// 実データに近い6件（長い地名・部位が複数・記録なしを混ぜる）
const ROWS = [
  { label: 'TGC-08-T276', packs: [{ part_name: '唐揚げ用', weight: 0.83 }],
    ind: { label_id: 'TGC-08-T276', species: 'イノシシ', sex: 'メス', weight_total: 26.3,
      capture_date: '2026-08-17', capture_city: '館山市', capture_area: '洲宮', capture_method: 'くくり罠',
      radiation_test_date: '2026-08-22', radiation_result: '検出下限値以下',
      processing_done_at: '2026-08-21T02:05:26.976+00:00' } },
  { label: 'TGC-08-M163', packs: [{ part_name: '唐揚げ用', weight: 1.35 }, { part_name: 'モモ（シンタマ）', weight: 2.04 }],
    ind: { label_id: 'TGC-08-M163', species: 'イノシシ', sex: 'オス', weight_total: 50.2,
      capture_date: '2026-08-11', capture_city: '南房総市', capture_area: '白浜町白浜', capture_method: '箱罠',
      radiation_test_date: '2026-08-19', radiation_result: '検出下限値以下',
      processing_done_at: '2026-08-21T07:10:23.709+00:00' } },
  { label: 'TGC-08-M167', packs: [{ part_name: '唐揚げ用', weight: 1.18 }, { part_name: '唐揚げ用', weight: 1.39 }, { part_name: '肩ロース', weight: 1.72 }],
    ind: { label_id: 'TGC-08-M167', species: 'イノシシ', sex: 'オス', weight_total: 40.8,
      capture_date: '2026-08-12', capture_city: '南房総市', capture_area: '珠師ケ谷', capture_method: '箱罠',
      radiation_test_date: '2026-08-20', radiation_result: '検出下限値以下',
      processing_done_at: '2026-08-24T06:07:58.962+00:00' } },
  { label: 'TGC-08-シ010', packs: [{ part_name: 'モモ（全体）', weight: 3.11 }],
    ind: { label_id: 'TGC-08-シ010', species: 'シカ', sex: 'メス', weight_total: 31.7,
      capture_date: '2026-08-03', capture_city: '南房総市', capture_area: '和田町上三原', capture_method: 'くくり罠',
      radiation_test_date: null, radiation_result: null,
      processing_done_at: '2026-08-14T05:00:00.000+00:00' } },
  { label: 'TGC-08-M170', packs: [{ part_name: '唐揚げ用', weight: 2.0 }],
    ind: { label_id: 'TGC-08-M170', species: 'イノシシ', sex: 'オス', weight_total: 35,
      capture_date: '2026-08-14', capture_city: '南房総市', capture_area: '上滝田', capture_method: '箱罠',
      radiation_test_date: '2026-08-21', radiation_result: '検出下限値以下',
      processing_done_at: '2026-08-21T03:48:26.456+00:00' } },
  // 個体の記録が引けなかったとき（空欄でも枠が壊れないこと）
  { label: 'TGC-08-T999', species: 'イノシシ', packs: [{ part_name: '唐揚げ用', weight: 1.0 }], ind: null },
];

/* QRを読み直す（バージョン4・5／誤り訂正M）。tests/e2e/kakou-label-qr.e2e.js と同じ手順。
   個体番号が全角（シカの「シ010」など）だとURLが数バイト伸びてv5になるため、両方に対応する。 */
const QRSPEC = {
  33: { ver: 4, data: 64, blocks: 2, align: [6, 26] },
  37: { ver: 5, data: 86, blocks: 2, align: [6, 30] },
};
function decodeQR(grid) {
  const N = grid.length;
  const spec = QRSPEC[N];
  if (!spec) throw new Error('対応していないバージョン(モジュール数): ' + N);
  const RES = Array.from({ length: N }, () => new Array(N).fill(false));
  const mark = (r, c) => { if (r >= 0 && c >= 0 && r < N && c < N) RES[r][c] = true; };
  for (const [r0, c0] of [[0, 0], [0, N - 7], [N - 7, 0]])
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) mark(r0 + r, c0 + c);
  for (let i = 0; i < N; i++) { mark(6, i); mark(i, 6); }
  for (const r of spec.align) for (const c of spec.align) {
    if ((r <= 8 && c <= 8) || (r <= 8 && c >= N - 9) || (r >= N - 9 && c <= 8)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
  }
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(8, N - 1 - i); mark(N - 1 - i, 8); }

  let f = 0;
  for (let i = 0; i < 15; i++) {
    let b;
    if (i <= 5) b = grid[i][8];
    else if (i === 6) b = grid[7][8];
    else if (i === 7) b = grid[8][8];
    else if (i === 8) b = grid[8][7];
    else b = grid[8][14 - i];
    f |= b << i;
  }
  const d = (f ^ 0x5412) >> 10;
  const ecLevel = d >> 3, mask = d & 7;
  if (ecLevel !== 0b00) throw new Error('誤り訂正レベルがMではない: ' + ecLevel);

  const MASKS = [
    (i, j) => (i + j) % 2 === 0, (i, j) => i % 2 === 0, (i, j) => j % 3 === 0,
    (i, j) => (i + j) % 3 === 0, (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0,
    (i, j) => (i * j) % 2 + (i * j) % 3 === 0, (i, j) => ((i * j) % 2 + (i * j) % 3) % 2 === 0,
    (i, j) => ((i + j) % 2 + (i * j) % 3) % 2 === 0
  ];

  const bits = [];
  let up = true;
  for (let col = N - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < N; k++) {
      const row = up ? N - 1 - k : k;
      for (const c of [col, col - 1]) {
        if (RES[row][c]) continue;
        bits.push(grid[row][c] ^ (MASKS[mask](row, c) ? 1 : 0));
      }
    }
    up = !up;
  }
  const words = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) words.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  const DATA = spec.data, BLOCKS = spec.blocks, PER = DATA / BLOCKS;
  const dw = [];
  for (let b = 0; b < BLOCKS; b++) for (let i = 0; i < PER; i++) dw.push(words[i * BLOCKS + b]);
  const db = [];
  dw.forEach(w => { for (let i = 7; i >= 0; i--) db.push((w >> i) & 1); });
  const take = (n, at) => parseInt(db.slice(at, at + n).join(''), 2);
  if (take(4, 0) !== 0b0100) throw new Error('バイトモードではない');
  const len = take(8, 4);
  const bytes = [];
  for (let i = 0; i < len; i++) bytes.push(take(8, 12 + i * 8));
  return { text: Buffer.from(bytes).toString('utf8'), mask };
}

// 画面から読ませる在庫（tier2・在庫）。M167は2パック＝1個体にまとまるはず。
const INV = [
  { ident_code: 'TGC-08-M169-KG', scan_code: '10000974', individual_id: 'TGC-08-M169', species: 'イノシシ', part_name: '唐揚げ用', weight: 1.31, processed_at: '2026-08-27T03:34:06+00:00', created_at: '2026-08-27T03:34:06+00:00' },
  { ident_code: 'TGC-08-M167-KG', scan_code: '10000769', individual_id: 'TGC-08-M167', species: 'イノシシ', part_name: '唐揚げ用', weight: 1.18, processed_at: '2026-08-24T03:30:31+00:00', created_at: '2026-08-24T03:30:31+00:00' },
  { ident_code: 'TGC-08-M167-KG-2', scan_code: '10000785', individual_id: 'TGC-08-M167', species: 'イノシシ', part_name: '唐揚げ用', weight: 1.39, processed_at: '2026-08-24T06:02:05+00:00', created_at: '2026-08-24T06:02:05+00:00' },
  { ident_code: 'TGC-08-T260-RO', scan_code: '10000600', individual_id: 'TGC-08-T260', species: 'イノシシ', part_name: 'ロース', weight: 2.2, processed_at: '2026-08-21T07:00:00+00:00', created_at: '2026-08-21T07:00:00+00:00' },
  // 100日前＝「最近30日」では出ない
  { ident_code: 'TGC-08-T100-KG', scan_code: '10000100', individual_id: 'TGC-08-T100', species: 'イノシシ', part_name: '唐揚げ用', weight: 0.9, processed_at: '2026-05-01T00:00:00+00:00', created_at: '2026-05-01T00:00:00+00:00' },
];
const INDS = [
  { label_id: 'TGC-08-M169', species: 'イノシシ', sex: 'オス', weight_total: 41.1, capture_date: '2026-08-13', capture_city: '南房総市', capture_area: '川谷', capture_method: '箱罠', radiation_test_date: '2026-08-21', radiation_result: '検出下限値以下', processing_done_at: '2026-08-27T03:36:26+00:00' },
  { label_id: 'TGC-08-M167', species: 'イノシシ', sex: 'オス', weight_total: 40.8, capture_date: '2026-08-12', capture_city: '南房総市', capture_area: '珠師ケ谷', capture_method: '箱罠', radiation_test_date: '2026-08-20', radiation_result: '検出下限値以下', processing_done_at: '2026-08-24T06:07:58+00:00' },
  { label_id: 'TGC-08-T260', species: 'イノシシ', sex: 'メス', weight_total: 36.8, capture_date: '2026-08-10', capture_city: '館山市', capture_area: '山本', capture_method: '箱罠', radiation_test_date: '2026-08-12', radiation_result: '検出下限値以下', processing_done_at: '2026-08-21T07:18:15+00:00' },
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  // 「最近30日」の判定を固定するため、今日を2026-08-28にする
  await ctx.addInitScript(() => {
    const RealDate = Date;
    const NOW = new RealDate('2026-08-28T10:00:00+09:00').getTime();
    function FakeDate(...a) { return a.length === 0 ? new RealDate(NOW) : new RealDate(...a); }
    FakeDate.prototype = RealDate.prototype;
    FakeDate.now = () => NOW; FakeDate.parse = RealDate.parse; FakeDate.UTC = RealDate.UTC;
    window.Date = FakeDate;
    try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {}
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const asked = [];
  page.on('dialog', async d => { asked.push(d.message()); await d.dismiss(); });

  const seen = { inv: [], ind: [] };
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    // 出店シートの問い合わせだけを見る（ダッシュボード等も inventory を読むため）
    if (/\/rest\/v1\/inventory\?/.test(u) && /individual_id=not\.is\.null/.test(u)) { seen.inv.push(u); return J(INV); }
    if (/\/rest\/v1\/individuals\?/.test(u) && /label_id=in\./.test(u)) {
      seen.ind.push(u);
      const want = decodeURIComponent(u).match(/label_id=in\.\(([^)]*)\)/)[1].split(',').map(s => s.replace(/"/g, ''));
      return J(INDS.filter(x => want.includes(x.label_id)));
    }
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(700);

  const results = [];
  const T = (name, ok, got) => results.push([name, ok, got == null ? '' : String(got)]);

  // ── 1) A4実寸のレイアウト ──
  const layout = await page.evaluate(async rows => {
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;left:-9999px;top:0;border:0;width:210mm;height:297mm;';
    document.body.appendChild(f);
    const doc = f.contentDocument; doc.open();
    doc.write(evSheetHtml(rows, '館山ジビエセンター 出店', '8月29日')); doc.close();
    await new Promise(r => setTimeout(r, 200));

    const probe = doc.createElement('div');
    probe.style.cssText = 'width:10mm;position:absolute'; doc.body.appendChild(probe);
    const mm = probe.getBoundingClientRect().width / 10; probe.remove();

    const pg = doc.querySelector('.pg').getBoundingClientRect();
    const cards = [...doc.querySelectorAll('.cd')];
    const out = {
      pageWmm: pg.width / mm, pageHmm: pg.height / mm, cards: cards.length,
      cols: new Set(cards.map(c => Math.round(c.getBoundingClientRect().left))).size,
      rows: new Set(cards.map(c => Math.round(c.getBoundingClientRect().top))).size,
      each: cards.map(c => {
        const r = c.getBoundingClientRect();
        const ft = c.querySelector('.ft').getBoundingClientRect();
        const pt = c.querySelector('.pt').getBoundingClientRect();
        const qr = c.querySelector('.qr svg').getBoundingClientRect();
        return {
          wMm: r.width / mm, hMm: r.height / mm,
          overflow: c.scrollHeight - c.clientHeight,          // 枠からあふれた分(px)
          insidePage: r.bottom <= pg.bottom + 0.5 && r.right <= pg.right + 0.5,
          qrOverlap: ft.top < pt.bottom - 0.5,                // QR行が部位の文字に重なる
          qrBottomIn: qr.bottom <= r.bottom + 0.5,
          qrMm: qr.width / mm,
          // 案内文が途中で折り返していないか（加工ラベルで起きた不具合と同じ測り方）
          capWrapped: [...c.querySelectorAll('.qx small')].some(el => el.getClientRects().length > 1)
        };
      }),
      // 見出し
      title: doc.querySelector('.hd .t').textContent,
      date: doc.querySelector('.hd .d').textContent
    };
    f.remove();
    return out;
  }, ROWS);

  T('用紙が194mm幅', Math.abs(layout.pageWmm - 194) < 0.3, layout.pageWmm.toFixed(1) + 'mm');
  T('用紙が281mm高', Math.abs(layout.pageHmm - 281) < 0.3, layout.pageHmm.toFixed(1) + 'mm');
  T('1枚に6個体', layout.cards === 6, layout.cards);
  T('2列3段に並ぶ', layout.cols === 2 && layout.rows === 3, `${layout.cols}列${layout.rows}段`);
  T('見出しと日付が出る', layout.title.includes('出店') && layout.date === '8月29日', layout.title + ' / ' + layout.date);
  layout.each.forEach((c, n) => {
    T(`カード${n + 1}: 中身が枠からあふれない`, c.overflow <= 1, c.overflow + 'px');
    T(`カード${n + 1}: 用紙からはみ出さない`, c.insidePage, '');
    T(`カード${n + 1}: QRが文字に重ならない`, !c.qrOverlap, '');
    T(`カード${n + 1}: QRが枠内に収まる`, c.qrBottomIn, '');
    T(`カード${n + 1}: QRが28mm`, Math.abs(c.qrMm - 28) < 0.3, c.qrMm.toFixed(1) + 'mm');
    T(`カード${n + 1}: 案内文が途中で折れない`, !c.capWrapped, '');
  });
  // 1モジュールの実寸（小さすぎるとスマホで読めない）。加工ラベルの13mmより余裕がある。
  T('1モジュールが0.60mm以上', 28 / 41 >= 0.6, ((28 / 41) * 1000).toFixed(0) + 'μm');

  // ── 2) QRの中身が個体の物語URLに戻る ──
  const mats = await page.evaluate(labels => labels.map(l => {
    const svg = makeQRSVG(individualStoryUrl(l), 28);
    const T2 = +svg.match(/viewBox="0 0 (\d+)/)[1], N = T2 - 8;
    const g = Array.from({ length: N }, () => new Array(N).fill(0));
    const re = /<rect x="(\d+)" y="(\d+)" width="1"/g; let m;
    while ((m = re.exec(svg))) { const x = +m[1] - 4, y = +m[2] - 4; if (x >= 0 && y >= 0 && x < N && y < N) g[y][x] = 1; }
    return { g, url: individualStoryUrl(l) };
  }), LABELS);
  let ok = 0, bad = '';
  for (let i = 0; i < LABELS.length; i++) {
    try {
      const { text } = decodeQR(mats[i].g);
      if (text === mats[i].url) ok++; else if (!bad) bad = text;
    } catch (e) { if (!bad) bad = LABELS[i] + ': ' + e.message; }
  }
  T(`QRを読み直すと個体の物語URLに戻る(${LABELS.length}件)`, ok === LABELS.length, `${ok}/${LABELS.length} ${bad}`);
  T('全角の個体番号でもURLが壊れない',
    mats[6].url === 'https://tateyama-gibier.vercel.app/s.html?i=TGC-08-%E3%82%B7010', mats[6].url);
  T('QRの行き先はパックでなく個体（?i=）',
    /\/s\.html\?i=/.test(mats[0].url) && !/\?c=/.test(mats[0].url), mats[0].url);

  // ── 3) 会場に貼る「一覧QR」のポスター ──
  const EVID = '3f2a1b6c-1111-4222-8333-444455556666';
  const poster = await page.evaluate(async id => {
    const html = evPosterHtml(id, 'テスト会場', '8月29日', 6, 2);
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;left:-9999px;top:0;border:0;width:210mm;height:297mm;';
    document.body.appendChild(f);
    const doc = f.contentDocument; doc.open(); doc.write(html); doc.close();
    await new Promise(r => setTimeout(r, 200));
    const probe = doc.createElement('div');
    probe.style.cssText = 'width:10mm;position:absolute'; doc.body.appendChild(probe);
    const mm = probe.getBoundingClientRect().width / 10; probe.remove();
    const po = doc.querySelector('.po').getBoundingClientRect();
    const qr = doc.querySelector('.qr svg').getBoundingClientRect();
    const out = {
      wMm: po.width / mm, hMm: po.height / mm, qrMm: qr.width / mm,
      overflow: doc.querySelector('.po').scrollHeight - doc.querySelector('.po').clientHeight,
      text: doc.body.textContent.replace(/\s+/g, ' '),
      url: eventListUrl(id)
    };
    f.remove();
    return out;
  }, EVID);
  T('ポスターがA4に収まる', poster.overflow <= 1 && Math.abs(poster.wMm - 186) < 0.3, `${poster.overflow}px / ${poster.wMm.toFixed(1)}mm`);
  T('ポスターのQRが96mm', Math.abs(poster.qrMm - 96) < 0.5, poster.qrMm.toFixed(1) + 'mm');
  T('ポスターは出店の一覧へ飛ぶ', poster.url === 'https://tateyama-gibier.vercel.app/s.html?e=' + EVID, poster.url);
  T('小分けがあることも書く', /小分けパックは、入っている一頭たちをすべて載せています/.test(poster.text), '');
  T('会場と日付が出る', poster.text.includes('テスト会場') && poster.text.includes('8月29日'), '');

  const pmat = await page.evaluate(id => {
    const svg = makeQRSVG(eventListUrl(id), 96);
    const T2 = +svg.match(/viewBox="0 0 (\d+)/)[1], N = T2 - 8;
    const g = Array.from({ length: N }, () => new Array(N).fill(0));
    const re = /<rect x="(\d+)" y="(\d+)" width="1"/g; let m;
    while ((m = re.exec(svg))) { const x = +m[1] - 4, y = +m[2] - 4; if (x >= 0 && y >= 0 && x < N && y < N) g[y][x] = 1; }
    return { g, url: eventListUrl(id) };
  }, EVID);
  let pok = '';
  try { pok = decodeQR(pmat.g).text; } catch (e) { pok = 'ERR ' + e.message; }
  T('ポスターのQRを読み直すと一覧URLに戻る', pok === pmat.url, pok);

  // ── 4) 一頭のカードには小分けを混ぜない ──
  const mixed = await page.evaluate(() => {
    evItems = [
      { kind: 'inventory', individual_label: 'TGC-08-M169', part_name: '唐揚げ用', weight_kg: 1.31, species: 'イノシシ' },
      { kind: 'inventory', individual_label: 'TGC-08-M169', part_name: 'ロース',   weight_kg: 2.10, species: 'イノシシ' },
      { kind: 'inventory', individual_label: 'TGC-08-M168', part_name: '唐揚げ用', weight_kg: 1.62, species: 'イノシシ' },
      { kind: 'lot',   item_name: 'スライス肉（3mm）', qty_taken: 7, member_labels: ['TGC-08-M159', 'TGC-08-M160'] },
      { kind: 'other', item_name: 'ジビエカレー', qty_taken: 20 }
    ];
    evIndCache = {};
    const rows = evCardRows();
    return { n: rows.length, labels: rows.map(r => r.label), packs: rows.map(r => r.packs.length) };
  });
  T('カードは個体ごとに1枚', mixed.n === 2, mixed.labels.join(','));
  T('小分け・その他はカードにしない', !mixed.labels.some(l => /スライス|カレー/.test(l)), mixed.labels.join(','));
  T('同じ個体の複数パックは1枚にまとめる', mixed.packs[0] === 2, JSON.stringify(mixed.packs));

  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [name, okk, got] of results) { console.log((okk ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + got + ']' : '')); if (okk) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
