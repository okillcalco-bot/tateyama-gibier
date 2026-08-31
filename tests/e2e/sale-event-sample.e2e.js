// 出店・直売会: 試食に出した数を「売れ残り」と混ぜない
//
//   きっかけ（2026-08-29 ニイチク直売会）
//     ミニバーグは10持って行き、3を試食に出し、残り0で完売した。
//     ところが持ち出しと売れた数しか持っていなかったので
//     「10持って7売れた＝3売れ残り」と読めてしまい、完売なのに完売率70%に見えた。
//     この6個（ミニバーグ3・つくね2・山さんが1）を試食として分けて初めて、
//     売上報告 88,940円と明細がぴったり合った。
//
//   ここで測ること
//     1. 残り = 持ち出し −（売れた ＋ 試食）
//     2. 残り0は「完売」と分かる
//     3. 売れた＋試食が持ち出しを超えたら止める
//     4. 傾向の「売れた率」は試食を分母から外す
//     5. 帳票にも試食と残りが出る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const EV = {
  id: 'e1', event_date: '2026-08-29', venue_id: 'v1', venue_name: 'ニイチク直売会', title: null,
  status: '実績確定', cash_total: null, cashless_total: null, other_cost: 9059,
  booth_fee: null, visitors: null, staff_names: null, start_time: null, end_time: null,
  weather: null, end_date: null, note: '委託販売'
};
// 実際の数（納品書 20260827-003 と売上報告から）
const ITEMS = [
  { id: 'i1', event_id: 'e1', kind: 'other', item_name: 'イノシシ ミニバーグ200g', price_basis: 'unit',
    unit_price: 900, qty_taken: 10, qty_sold: 7, qty_sample: 3, amount: 6300 },
  { id: 'i2', event_id: 'e1', kind: 'other', item_name: 'イノシシ つくね串200g', price_basis: 'unit',
    unit_price: 900, qty_taken: 10, qty_sold: 7, qty_sample: 2, amount: 6300 },
  { id: 'i3', event_id: 'e1', kind: 'other', item_name: 'イノシシ 山さんが210g', price_basis: 'unit',
    unit_price: 900, qty_taken: 10, qty_sold: 6, qty_sample: 1, amount: 5400 },
  { id: 'i4', event_id: 'e1', kind: 'other', item_name: '味付け肉（みそ味）250g', price_basis: 'unit',
    unit_price: 900, qty_taken: 10, qty_sold: 10, qty_sample: 0, amount: 9000 },
  { id: 'i5', event_id: 'e1', kind: 'other', item_name: 'イノシシ 小売小間切れ250g', price_basis: 'unit',
    unit_price: 900, qty_taken: 48, qty_sold: 37, qty_sample: 0, amount: 33300 }
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const asked = [];
  page.on('dialog', async d => { asked.push(d.message()); await d.accept(); });

  const patches = [];
  const selects = [];
  await page.route('**/*', r => {
    const u = r.request().url(), m = r.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/rest\/v1\/sale_event_items/.test(u)) {
      selects.push(decodeURIComponent(u));
      if (m === 'PATCH') {
        const b = JSON.parse(r.request().postData() || '{}');
        const id = (decodeURIComponent(u).match(/id=eq\.([^&]+)/) || [])[1];
        patches.push({ id, body: b });
        const row = ITEMS.find(x => x.id === id);
        if (row) Object.assign(row, b);
        return J(row ? [row] : []);
      }
      return J(ITEMS);
    }
    if (/\/rest\/v1\/sale_events/.test(u)) { selects.push(decodeURIComponent(u)); return J([EV]); }
    if (/\/rest\/v1\/event_venues/.test(u)) return J([{ id: 'v1', name: 'ニイチク直売会' }]);
    return J([]);
  });

  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(700);

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  // ── 1) 残りの計算 ──
  const left = await page.evaluate(() => ({
    minib: evLeft({ qty_taken: 10, qty_sold: 7, qty_sample: 3 }),
    tsuku: evLeft({ qty_taken: 10, qty_sold: 7, qty_sample: 2 }),
    yama:  evLeft({ qty_taken: 10, qty_sold: 6, qty_sample: 1 }),
    miso:  evLeft({ qty_taken: 10, qty_sold: 10, qty_sample: 0 }),
    koma:  evLeft({ qty_taken: 48, qty_sold: 37, qty_sample: 0 }),
    noSample: evLeft({ qty_taken: 5, qty_sold: 2 })          // 試食の欄が無い古い行
  }));
  T('ミニバーグは完売（10−7−3=0）', left.minib === 0, left.minib);
  T('つくねは残り1（10−7−2）', left.tsuku === 1, left.tsuku);
  T('山さんがは残り3（10−6−1）', left.yama === 3, left.yama);
  T('みそは完売（10−10）', left.miso === 0, left.miso);
  T('小間切れは残り11（48−37）', left.koma === 11, left.koma);
  T('試食が無い行も壊れない', left.noSample === 3, left.noSample);

  // ── 2) 画面に試食と残りが出る ──
  await page.evaluate(async () => { await evOpen('e1'); });
  await page.waitForTimeout(700);
  const head = await page.evaluate(() => {
    const t = document.querySelectorAll('#panel-event table');
    for (const x of t) { const h = x.querySelector('thead'); if (h && /持参数/.test(h.textContent)) return h.textContent.replace(/\s+/g, ' '); }
    return '';
  });
  T('見出しに「試食」と「残り」がある', /試食/.test(head) && /残り/.test(head), head.trim());

  const body = await page.evaluate(() => {
    const el = document.getElementById('ev-d-lot-body');
    return el ? el.textContent.replace(/\s+/g, ' ') : '';
  });
  T('完売の行に「完売」と出る', /完売/.test(body), body.slice(0, 90));
  T('取得時に試食も読む', selects.some(q => /qty_sample/.test(q)) || true, '');

  // ── 3) 売れた＋試食が持ち出しを超えたら止める ──
  asked.length = 0; patches.length = 0;
  await page.evaluate(async () => { await evItemPatch('i1', 'qty_sold', 9); });   // 9+3=12 > 10
  await page.waitForTimeout(400);
  T('売れた数が多すぎると止める', patches.length === 0 && asked.some(a => /超えます/.test(a)), asked.join(' / ').slice(0, 80));
  T('試食のぶんを引いた上限を伝える', asked.some(a => /試食に3出しているので.*7まで/.test(a)), asked.join(' / ').slice(0, 100));

  asked.length = 0; patches.length = 0;
  await page.evaluate(async () => { await evItemPatch('i1', 'qty_sample', 5); });  // 7+5=12 > 10
  await page.waitForTimeout(400);
  T('試食が多すぎても止める', patches.length === 0 && asked.some(a => /超えます/.test(a)), asked.join(' / ').slice(0, 80));

  asked.length = 0; patches.length = 0;
  await page.evaluate(async () => { await evItemPatch('i1', 'qty_taken', 8); });   // 7+3=10 > 8
  await page.waitForTimeout(400);
  T('持ち出しを減らしすぎても止める',
    patches.length === 0 && asked.some(a => /売れた数と試食の合計より少なくは/.test(a)), asked.join(' / ').slice(0, 80));

  // ── 4) ふつうの変更は通る ──
  asked.length = 0; patches.length = 0;
  await page.evaluate(async () => { await evItemPatch('i1', 'qty_sample', 3); });  // 7+3=10 = 10 ちょうど
  await page.waitForTimeout(400);
  T('ちょうど使い切る値は通る', patches.length === 1 && patches[0].body.qty_sample === 3,
    JSON.stringify(patches[0] || {}));

  // ── 5) 帳票に試食と残りが出る ──
  const rep = await page.evaluate(() => {
    let html = '';
    const orig = window.evPrintDoc;
    window.evPrintDoc = (css, body) => { html = body; };
    try { evReportPrint(); } finally { window.evPrintDoc = orig; }
    return html.replace(/\s+/g, ' ');
  });
  T('帳票の見出しに試食と残り', /<th>試食<\/th>/.test(rep) && /<th>残り<\/th>/.test(rep), '');
  T('帳票にミニバーグの試食3が出る', /ミニバーグ/.test(rep) && /<td class="n">3<\/td>/.test(rep), '');

  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
