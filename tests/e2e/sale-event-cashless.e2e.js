// 出店の入金を「現金」と「キャッシュレス」に分けて持つ
//
//   きっかけ（2026-08-29/30 川島夜店市）
//     現金 40,700 / PayPay 15,200 のように必ず2本立てで入金される。
//     欄が1つしか無いと合算するしかなく、レジ締めの現金とも突き合わせられないし、
//     PayPayの入金確認もできない。
//
//   ここで測ること
//     1. 現金とキャッシュレスを別々に保存できる
//     2. 突き合わせは「現金＋キャッシュレス」と明細の合計で行う
//     3. 片方だけでも突き合わせが働く（0円の側を未入力扱いにしない）
//     4. 帳票にも内訳が出る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

// 実際の記録そのまま
const EV = {
  id: 'e1', event_date: '2026-08-29', venue_id: 'v1', venue_name: '川島夜店市', title: '川島夜店市',
  status: '実績確定', cash_total: 40700, cashless_total: 15200,
  booth_fee: null, other_cost: null, visitors: null, staff_names: null,
  start_time: null, end_time: null, weather: null, end_date: null, note: null
};
const ITEMS = [
  { id: 'i1', event_id: 'e1', kind: 'other', item_name: 'いの太郎',   price_basis: 'unit', unit_price: 700, qty_taken: 62, qty_sold: 62, amount: 43400 },
  { id: 'i2', event_id: 'e1', kind: 'other', item_name: 'レバから子', price_basis: 'unit', unit_price: 500, qty_taken: 25, qty_sold: 25, amount: 12500 }
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());

  const patches = [];
  await page.route('**/*', r => {
    const u = r.request().url(), m = r.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/rest\/v1\/sale_event_items/.test(u)) return J(ITEMS);
    if (/\/rest\/v1\/sale_events/.test(u)) {
      if (m === 'PATCH') { patches.push(JSON.parse(r.request().postData() || '{}')); return J([EV]); }
      return J([EV]);
    }
    if (/\/rest\/v1\/event_venues/.test(u)) return J([{ id: 'v1', name: '川島夜店市' }]);
    return J([]);
  });

  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(700);

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  // ── 1) 欄が2つある ──
  T('現金の欄がある', await page.evaluate(() => !!document.getElementById('ev-d-cash')), '');
  T('キャッシュレスの欄がある', await page.evaluate(() => !!document.getElementById('ev-d-cashless')), '');
  const lbl = await page.evaluate(() => {
    const el = document.getElementById('ev-d-cashless');
    return el && el.closest('.form-group') ? el.closest('.form-group').textContent.replace(/\s+/g, '') : '';
  });
  T('PayPayと分かる書き方', /PayPay/.test(lbl), lbl.slice(0, 40));

  // ── 2) 開くと両方が入る ──
  await page.evaluate(async () => { await evOpen('e1'); });
  await page.waitForTimeout(700);
  T('現金が画面に出る', (await page.$eval('#ev-d-cash', el => el.value)) === '40700', await page.$eval('#ev-d-cash', el => el.value));
  T('キャッシュレスが画面に出る', (await page.$eval('#ev-d-cashless', el => el.value)) === '15200', await page.$eval('#ev-d-cashless', el => el.value));

  // ── 3) 突き合わせは合計で行う ──
  const sum = await page.$eval('#ev-d-total', el => el.textContent.replace(/\s+/g, ' '));
  T('明細の売上は55,900円', /55,900/.test(sum), sum.slice(0, 60));
  T('入金の合計で突き合わせる', /入金.*55,900/.test(sum), sum.slice(-140));
  T('内訳（現金・キャッシュレス）も見せる',
    /現金.*40,700/.test(sum) && /キャッシュレス.*15,200/.test(sum), sum.slice(-140));
  T('ぴったり合っていると分かる', /ぴったり/.test(sum) && !/合っていません/.test(sum), sum.slice(-70));

  // ── 4) 保存すると両方送る ──
  patches.length = 0;
  await page.evaluate(async () => { await evSaveHead(); });
  await page.waitForTimeout(500);
  T('保存で現金を送る', patches.length && patches[0].cash_total === 40700, JSON.stringify(patches[0] || {}).slice(0, 90));
  T('保存でキャッシュレスも送る', patches.length && patches[0].cashless_total === 15200, '');

  // ── 5) 片方だけでも突き合わせが働く（現金0・PayPayのみ等） ──
  await page.evaluate(() => {
    evCur.cash_total = 0; evCur.cashless_total = 55900;
    evRenderItems();
  });
  await page.waitForTimeout(300);
  const sum2 = await page.$eval('#ev-d-total', el => el.textContent.replace(/\s+/g, ' '));
  T('現金0でも突き合わせる（未入力扱いにしない）', /入金.*55,900/.test(sum2) && /ぴったり/.test(sum2), sum2.slice(-120));

  // ── 6) ずれていれば赤で知らせる ──
  await page.evaluate(() => { evCur.cash_total = 40000; evCur.cashless_total = 15200; evRenderItems(); });
  await page.waitForTimeout(300);
  const sum3 = await page.$eval('#ev-d-total', el => el.textContent.replace(/\s+/g, ' '));
  T('ずれたら知らせる', /合っていません/.test(sum3), sum3.slice(-90));

  // ── 7) 未入力なら突き合わせを出さない ──
  await page.evaluate(() => { evCur.cash_total = null; evCur.cashless_total = null; evRenderItems(); });
  await page.waitForTimeout(300);
  const sum4 = await page.$eval('#ev-d-total', el => el.textContent.replace(/\s+/g, ' '));
  T('未入力なら差の行を出さない', !/入金/.test(sum4), sum4.slice(-60));

  // ── 8) 出店報告書にも内訳が出る ──
  const rep = await page.evaluate(() => {
    evCur.cash_total = 40700; evCur.cashless_total = 15200;
    let html = '';
    const orig = window.evPrintDoc;
    window.evPrintDoc = (css, body) => { html = body; };
    try { evReportPrint(); } finally { window.evPrintDoc = orig; }
    return html.replace(/\s+/g, ' ');
  });
  T('報告書に入金の合計が出る', /入金の合計<\/th><td class="n">¥55,900/.test(rep) || /入金の合計[^¥]*¥55,900/.test(rep), rep.slice(0, 0) || '');
  T('報告書に現金の内訳が出る', /うち現金[^¥]*¥40,700/.test(rep), '');
  T('報告書にキャッシュレスの内訳が出る', /うちキャッシュレス[^¥]*¥15,200/.test(rep), '');
  T('報告書の差はゼロ', /¥0/.test(rep), '');
  T('報告書に商品名が出る', /いの太郎/.test(rep) && /レバから子/.test(rep), '');

  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
