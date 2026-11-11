// 在庫の件数・重量が「1000行で切れた分」や「表示した200行」から作られていないか（2026-10-18 外部レビュー指摘の検証）
//   症状: limit なしの GET が1000行で切れ、在庫が1000行を超えるとダッシュボードの在庫点数・重量が実際より少なく出た。
//   在庫一覧は新しい200行を取ってから獣種で絞るため、古いシカ在庫が「シカ」で0件、加工パック（個体番号なし）が獣種で全部消えた。
//   ここでは PostgREST と同じく1回1000行で打ち切るモックを使い、全件で数えていることを測る。件数・データはすべて架空。
const pw = (() => { try { return require('/opt/node22/lib/node_modules/playwright'); } catch (e) { return require('playwright'); } })();
const { chromium } = pw;
const path = require('path');

// ── 架空の在庫 4,567行（件数は試験用に決めた値）──
const INV = []; let n = 0;
const day = k => new Date(Date.UTC(2026, 9, 18) - k * 3600e3).toISOString();
const add = (o) => INV.push({ id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`, deleted_at: null, tier: 2, grade: '並', location_code: null, ...o });
for (let k = 0; k < 662; k++) add({ ident_code: `TGC-08-T${k}-MO`, individual_id: `TGC-08-T${k}`, species: 'イノシシ', part_name: k % 2 ? 'モモ' : 'ロース', weight: 0.8, status: '在庫', created_at: day(k), updated_at: day(k) });
for (let k = 0; k < 338; k++) add({ ident_code: `TGC-MI-B${k}`, individual_id: null, individual_code: `TGC-MI-B${k}`, tier: 3, species: 'イノシシ', part_name: 'ミンチ', weight: 0.5, status: '在庫', created_at: day(k + 5), updated_at: day(k + 5) });
for (let k = 0; k < 67; k++) add({ ident_code: `TGC-08-SHI${k}-MOS`, individual_id: `TGC-08-シ${k}`, species: 'シカ', part_name: 'モモ（ソト）', weight: 0.7, status: '在庫', created_at: day(2000 + k), updated_at: day(2000 + k) });   // 古い（新しい200件に入らない）
for (let k = 0; k < 3500; k++) add({ ident_code: `TGC-08-T${k}-OLD`, individual_id: `TGC-08-T${k}`, species: 'イノシシ', part_name: 'バラ', weight: 1, status: '出荷済', created_at: day(3000 + k), updated_at: day(3000 + k) });
const STOCK = INV.filter(i => i.status === '在庫');
const STOCK_KG = STOCK.reduce((s, i) => s + i.weight, 0);
const IND = [...new Set(INV.map(i => i.individual_id).filter(Boolean))].map(l => ({ label_id: l, species: /シ/.test(l) ? 'シカ' : 'イノシシ', deleted_at: null }));
const NOID = Array.from({ length: 1500 }, (_, k) => ({ key: 'k' + k, v: k }));   // id 列が無い表

// PostgREST もどき: eq / is.null / in / order / limit / offset / select / count=exact。1回最大1000行
function rest(rows, qs, headers, hasId = true) {
  const p = new URLSearchParams(qs);
  let r = rows.slice();
  for (const [k, v] of p) {
    if (['select', 'order', 'limit', 'offset', 'or'].includes(k)) continue;
    if (v === 'is.null') r = r.filter(x => x[k] == null);
    else if (v.startsWith('eq.')) r = r.filter(x => String(x[k]) === v.slice(3));
    else if (v.startsWith('in.(')) { const set = v.slice(4, -1).split(',').map(s => s.replace(/^"|"$/g, '')); r = r.filter(x => set.includes(String(x[k]))); }
  }
  const ord = p.get('order');
  if (ord) { const [c, dir] = ord.split('.'); if (c === 'id' && !hasId) return { status: 400, body: { message: 'column id does not exist' } }; r.sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (dir === 'desc' ? -1 : 1)); }
  const total = r.length;
  const off = +(p.get('offset') || 0), lim = Math.min(1000, p.has('limit') ? +p.get('limit') : 1000);
  r = r.slice(off, off + lim);
  const sel = p.get('select');
  if (sel && sel !== '*' && !sel.includes('(')) { const cols = sel.split(','); r = r.map(x => Object.fromEntries(cols.map(c => [c, x[c]]))); }
  const range = /count=exact/.test(headers.prefer || '') ? { 'content-range': `0-${Math.max(0, r.length - 1)}/${total}`, 'access-control-expose-headers': 'content-range' } : {};
  if (/count=exact/.test(headers.prefer || '')) r = r.slice(0, 1);
  return { status: 200, body: r, headers: range };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext(); await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_role_v1', 'admin'); localStorage.setItem('tg_staff_key', 'TESTKEY'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const calls = [];
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith('file:')) return r.continue();
    if (/fonts\.|cdn|jsdelivr/.test(u)) return r.fulfill({ status: 200, body: '' });
    const m = /\/rest\/v1\/([^?]+)\??(.*)$/.exec(decodeURIComponent(u));
    if (!m) return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    const [, table, qs] = m; calls.push(table + '?' + qs);
    const src = table === 'inventory' ? INV : table === 'individuals' ? IND : table === 'noid_table' ? NOID : null;
    if (!src || r.request().method() !== 'GET') return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    const out = rest(src, qs, r.request().headers(), table !== 'noid_table');
    return r.fulfill({ status: out.status, contentType: 'application/json', headers: out.headers || {}, body: JSON.stringify(out.body) });
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(800);
  const results = []; const T = (nm, ok, got) => results.push([nm, ok, got == null ? '' : String(got)]);

  // ① limit なしの GET が1000行で切れない（id 順で継ぎ足し、重複なし）
  const all = await page.evaluate(() => sb('GET', 'inventory', null, '?select=id,status&deleted_at=is.null'));
  T('limit なしの GET で 4,567行すべて取れる（1000行で切れない）', all.length === INV.length, all.length);
  T('継ぎ足しで行が重複しない', new Set(all.map(x => x.id)).size === all.length, new Set(all.map(x => x.id)).size);
  const noid = await page.evaluate(() => sb('GET', 'noid_table', null, '?select=key'));
  T('id 列の無い表でも全件（1,500行）取れる', noid.length === 1500, noid.length);
  const small = await page.evaluate(() => sb('GET', 'inventory', null, '?select=id&status=eq.出荷済&limit=5'));
  T('limit を書いた GET はその件数のまま（5件）', small.length === 5, small.length);

  // ② ダッシュボード: 在庫点数・重量は全在庫から
  await page.evaluate(() => loadDashboard());
  await page.waitForTimeout(1500);
  const dash = await page.evaluate(() => ({ stock: document.getElementById('dc-stock').textContent, kg: document.getElementById('dc-weight').textContent, boar: document.getElementById('chart-boar').textContent }));
  T(`ダッシュボードの在庫点数 = 全在庫 ${STOCK.length}点`, +dash.stock === STOCK.length, dash.stock);
  T(`ダッシュボードの在庫重量 = 全在庫 ${STOCK_KG.toFixed(1)}kg`, dash.kg === STOCK_KG.toFixed(1), dash.kg);
  T('部位別グラフに加工パック（ミンチ）が入る', /ミンチ/.test(dash.boar), dash.boar.slice(0, 80));

  // ③ 在庫一覧: 獣種はDBで絞る・件数は全件数で出す
  const list = async (status, species, part = '') => page.evaluate(async ([st, sp, pt]) => {
    document.getElementById('inv-filter-status').value = st; document.getElementById('inv-filter-species').value = sp;
    const ps = document.getElementById('inv-filter-part'); if (pt && ![...ps.options].some(o => o.value === pt)) ps.add(new Option(pt, pt)); ps.value = pt;
    document.getElementById('inv-filter-search').value = '';
    await loadInventory();
    return { rows: document.querySelectorAll('#inv-body tr').length, cnt: (document.getElementById('inv-count') || {}).textContent || '', sp: [...new Set(invData.map(i => i._species))], parts: [...document.getElementById('inv-filter-part').options].map(o => o.value).filter(Boolean) };
  }, [status, species, part]);
  const deer = await list('在庫', 'シカ');
  T('「在庫・シカ」で古いシカ在庫67件（架空）が全部出る（修正前は0件）', deer.rows === 67 && deer.cnt === '該当 67件', `${deer.rows}行 / ${deer.cnt}`);
  const boar = await list('在庫', 'イノシシ');
  T('「在庫・イノシシ」: 200行表示＋全件数（1,000件）を明示', boar.rows === 200 && /該当 1000件のうち新しい順に 200件/.test(boar.cnt), `${boar.rows}行 / ${boar.cnt}`);
  T('加工パック（個体番号なし）の獣種が「-」ではなくイノシシ', boar.sp.length === 1 && boar.sp[0] === 'イノシシ', JSON.stringify(boar.sp));
  T('部位の選択肢は表示中の200行ではなく条件に合う全在庫から（ミンチ・モモ・ロース）', ['ミンチ', 'モモ', 'ロース'].every(p => boar.parts.includes(p)), JSON.stringify(boar.parts));
  const anyst = await list('', '');
  T('条件なし: 件数は全 4,567件と明示', /該当 4567件/.test(anyst.cnt), anyst.cnt);
  T('部位の選択肢に古い行にしかない部位（モモ（ソト）・バラ）も出る', anyst.parts.includes('モモ（ソト）') && anyst.parts.includes('バラ'), JSON.stringify(anyst.parts));
  const deerPart = await list('在庫', 'シカ', 'モモ（ソト）');
  T('部位で絞っても部位の選択肢が消えない', deerPart.parts.includes('モモ（ソト）') && deerPart.rows === 67, `${deerPart.rows} ${JSON.stringify(deerPart.parts)}`);

  T('pageerrorなし', errors.length === 0, errors.join(' / '));
  let pass = 0;
  for (const [nm, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + nm + (got ? '  [' + String(got).slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
