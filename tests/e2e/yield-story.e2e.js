// 1頭から取れる量（説明用・2026-11-27 沖「いつでも最新データで伝えられるようにしといて」）
//
//   ここで測ること（データはすべて架空）
//     1. 開くと最新の個体・パックから計算し、決め打ちの数字を出さない（データを変えると数字も変わる）
//     2. 食べるお肉にペットフード用・内臓を混ぜない（最初の手計算で混ぜて「約3割」と言ってしまった）
//     3. 枝肉のまま出した個体（-ED）・記録の食い違い（5%未満/70%超）・取消/削除・他の獣種は数えず、件数を出す
//     4. 部位を「希少部位／ブロック／加工向け」に分け、[小売]・（厚さ）・骨付きを同じ部位として数える
//     5. 話し方（30秒版・3分版）が画面の数字から作られる
//     6. 読めなかったときは数字を出さず赤で知らせる（黙って古い数字や0を出さない）
//     7. スマホの幅で横にはみ出さない／ページエラー・未処理の例外なし
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

// 架空の個体: A(40kg) B(40kg) は数える。C は枝肉出荷、D は食い違い（肉が体重の80%）、E はシカ、F は取消のみ
const IND = [
  { label_id: 'X-A', species: 'イノシシ', weight_total: 40 },
  { label_id: 'X-B', species: 'イノシシ', weight_total: 40 },
  { label_id: 'X-C', species: 'イノシシ', weight_total: 50 },
  { label_id: 'X-D', species: 'イノシシ', weight_total: 10 },
  { label_id: 'X-E', species: 'シカ', weight_total: 50 },
];
const P = (id, part, kg, extra) => Object.assign({ individual_id: id, part_name: part, weight_kg: kg, ident_code: 'TGC-08-' + id + '-XX', status: '在庫', deleted_at: null }, extra || {});
const PACKS = [
  // A: ロース1 ヒレ0.2 モモ2 バラ[小売]0.8 ミンチ用（なし）4 ペット3 レバー0.5 → 食べる 8.0kg（20%）
  P('X-A', 'ロース', 1), P('X-A', 'ヒレ', 0.2), P('X-A', 'モモ（全体）', 2), P('X-A', 'バラ [小売]', 0.8),
  P('X-A', 'ミンチ用（なし）', 4), P('X-A', 'ペットフード用（なし）', 3), P('X-A', 'レバー', 0.5),
  // B: ロース0.8 骨付き モモ2 ミンチ用9.2 ペット1 → 食べる 12.0kg（30%）。取消のパックは数えない
  P('X-B', 'ロース', 0.8), P('X-B', '骨付き モモ', 2), P('X-B', 'ミンチ用', 9.2), P('X-B', 'ペットフード用（あり）', 1),
  P('X-B', 'ロース', 50, { status: '取消' }),
  // C: 枝肉（-ED）→ 数えない
  P('X-C', '胴体', 18, { ident_code: 'TGC-08-X-C-ED' }),
  // D: 肉8kg/体重10kg=80% → 食い違いとして数えない
  P('X-D', 'ミンチ用', 8),
  // E: シカ（イノシシには入らない）
  P('X-E', 'モモ', 15),
];

async function run(page, inds, packs, fail) {
  const seen = {};
  await page.unroute('**/*').catch(() => {});
  await page.route('**/*', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url());
    if (url.startsWith('file:')) return rt.continue();
    if (!/\/rest\/v1\//.test(url)) return rt.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    const table = url.split('/rest/v1/')[1].split('?')[0];
    const J = (x, s) => rt.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (req.method() !== 'GET') return J([]);
    if (table === 'inventory' && /tier=eq\.2/.test(url)) { seen.inv = url; return fail ? J({ message: 'timeout' }, 500) : J(packs); }
    if (table === 'individuals' && /weight_total/.test(url)) { seen.ind = url; return J(inds); }
    return J([]);
  });
  return seen;
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => {
    try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'staff'); } catch (e) {}
    window.alert = () => {}; window.confirm = () => true; window.prompt = () => null;
    window.__rej = []; window.addEventListener('unhandledrejection', e => window.__rej.push(String(e.reason && e.reason.message || e.reason)));
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const seen = await run(page, IND, PACKS);
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(900);
  await page.evaluate(() => document.querySelector('[data-tab="yield"]').click());
  await page.waitForTimeout(600);

  const kpi = await page.evaluate(() => (document.getElementById('yd-kpi') || {}).innerText || '');
  T('1. 開くと個体・部位パックを読んで計算する', seen.ind && seen.inv, JSON.stringify(Object.keys(seen)));
  T('2. 食べるお肉は体重の25%（ペット・レバーを混ぜない: (8+12)/(40+40)）', /25%[\s\S]*食べられるお肉/.test(kpi), kpi.replace(/\n/g, ' '));
  T('2. 1頭あたりのお肉 10.0kg・平均体重 40.0kg', /10\.0kg/.test(kpi) && /平均体重 40\.0kg/.test(kpi), kpi.replace(/\n/g, ' '));
  T('2. ペットフード用は別に 2.0kg（体重の5%）', /2\.0kg[\s\S]*ペットフード用（体重の5%）/.test(kpi), kpi.replace(/\n/g, ' '));
  const r = await page.evaluate(() => { const s = document.getElementById('panel-yield').innerText; return s; });
  T('3. 数えた頭数は2頭（枝肉・食い違い・シカ・取消を除く）', /2頭の実測/.test(r), (r.match(/[\d]+頭の実測/) || [''])[0]);
  const notes = await page.evaluate(() => document.getElementById('yd-notes').innerText);
  T('3. 数えなかった個体の件数を出す（枝肉1頭・食い違い1頭）', /枝肉のまま出した 1頭/.test(notes) && /70%超）1頭/.test(notes), notes.replace(/\n/g, ' '));
  const cats = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#yd-cats tr[data-cat]')].map(tr => [tr.dataset.cat, [...tr.cells].map(c => c.innerText)])));
  // 希少 (1+0.2+0.8)/2=1.0kg・10% ／ ブロック (2+0.8+2)/2=2.4kg・24% ／ 加工 (4+9.2)/2=6.6kg・66%
  T('4. 希少部位 1.0kg・10%（ロース・ヒレ）', cats.premium && cats.premium[1] === '1.0kg' && cats.premium[2] === '10%', JSON.stringify(cats.premium));
  T('4. ブロック 2.4kg・24%（[小売]・骨付きも同じ部位）', cats.block && cats.block[1] === '2.4kg' && cats.block[2] === '24%' && /モモ 2\.00kg/.test(cats.block[3]) && /バラ 0\.40kg/.test(cats.block[3]), JSON.stringify(cats.block));
  T('4. 加工向け 6.6kg・66%', cats.processing && cats.processing[1] === '6.6kg' && cats.processing[2] === '66%', JSON.stringify(cats.processing));
  const s30 = await page.evaluate(() => document.getElementById('yd-s30').innerText);
  T('5. 30秒版が数字から作られる（25%・40kgで10kg）', /約25%/.test(s30) && /40kgのイノシシなら10kg/.test(s30), s30);
  const s3 = await page.evaluate(() => document.getElementById('yd-s3').innerText);
  T('5. 3分版に頭数と希少部位の割合が入る', /2頭の実測/.test(s3) && /お肉の10%/.test(s3), s3.replace(/\n/g, ' / ').slice(0, 200));
  const warn = await page.evaluate(() => { const a = document.querySelector('#yd-result [role=alert]'); return a ? a.innerText : ''; });
  T('5. 頭数が少ないときは「今のところ」と添えるよう知らせる', /まだ2頭分/.test(warn), warn);

  // データが変わると数字も変わる（決め打ちでない）: B を外すと A だけ＝20%
  await run(page, IND.filter(d => d.label_id !== 'X-B'), PACKS);
  await page.evaluate(() => loadYield());
  await page.waitForTimeout(500);
  const kpi2 = await page.evaluate(() => document.getElementById('yd-kpi').innerText);
  T('1. データを変えると数字も変わる（Aだけ→20%・8.0kg）', /20%/.test(kpi2) && /8\.0kg/.test(kpi2), kpi2.replace(/\n/g, ' '));

  // 獣種の切り替え
  await run(page, IND, PACKS);
  await page.evaluate(() => yieldSetSpecies('シカ'));
  await page.waitForTimeout(500);
  const sika = await page.evaluate(() => document.getElementById('yd-kpi').innerText);
  T('3. シカに切り替えるとシカだけで数える（15/50=30%）', /30%/.test(sika) && /15\.0kg/.test(sika), sika.replace(/\n/g, ' '));
  await page.evaluate(() => yieldSetSpecies('イノシシ'));
  await page.waitForTimeout(400);

  // 読めなかったとき
  await run(page, IND, PACKS, true);
  await page.evaluate(() => loadYield());
  await page.waitForTimeout(500);
  const fail = await page.evaluate(() => ({ st: document.getElementById('yd-status').innerText, role: document.getElementById('yd-status').getAttribute('role'), res: document.getElementById('yd-result').innerText }));
  T('6. 読めなかったら数字を出さず赤で知らせる', /読めませんでした/.test(fail.st) && fail.role === 'alert' && fail.res.trim() === '', JSON.stringify(fail).slice(0, 200));

  await run(page, IND, PACKS);
  await page.evaluate(() => loadYield());
  await page.waitForTimeout(500);
  const over = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
  T('7. スマホの幅で横にはみ出さない', over === 0, over);
  T('7. ページエラー・未処理の例外なし', errors.length === 0 && (await page.evaluate(() => window.__rej.length)) === 0, errors.concat(await page.evaluate(() => window.__rej)).join(' / '));
  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
