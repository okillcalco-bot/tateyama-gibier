/* 料理・レシピ（栄養成分つき）タブ ── index.html から読み込む
   2026-09-21 「加工調理とは別タブで料理タブを作って、レシピを蓄積できるようにしたい。
   その際に添付の栄養成分も自動で計算して、商品と紐づけできるようにして。将来的にはそこからラベルも出せるようにしたい。」

   計算の考え方は大阪市「栄養算（えいようさん）ver2.7」と同じ:
     材料ごとに 可食部100gあたりの成分値 × 重量(g) ÷ 100 を足し、人数で割って1人分。
     成分表は日本食品標準成分表2020年版（八訂）増補2023年（data/food-composition-8th.json）。
     重量は「可食部の重さ」として扱う（栄養算と同じく廃棄率は使わない）。
     加熱で減る分は「出来上がり重量」を入れると 100gあたり に反映される。
   食品表示（栄養成分表示）は たんぱく質・脂質・炭水化物 の「基準窒素・従来の値」を使う
   （栄養算の表示は「エネルギー計算に使用している値」。両方を画面で見られるようにしてある）。
   index.html の sb / esc2 / toast / requireAdmin / PM_OPERATORS / pmPrintLabelHtml を使う。 */

const RC_JSON_URL = 'data/food-composition-8th.json';
const RC_CATEGORIES = ['味付け肉', '味付けミンチ', '惣菜・加工品', '弁当・給食', '試作', 'その他'];
const RC_CUSTOM_START = 19001;   // 追加食品（自社原料）の食品番号
// 主な成分（食品表示の5項目）。表示の丸めは栄養算と同じ（エネルギー整数・他は小数1桁）
const RC_MAIN = [
  { k: 'エネルギー', u: 'kcal', d: 0 }, { k: 'たんぱく質', u: 'g', d: 1 }, { k: '脂質', u: 'g', d: 1 },
  { k: '炭水化物', u: 'g', d: 1 }, { k: '食塩相当量', u: 'g', d: 1 } ];
// 栄養算の表示値（エネルギー計算に使用している値）
const RC_EN = { 'たんぱく質': 'たんぱく質（En計算に使用している値）', '脂質': '脂質（En計算に使用している値）', '炭水化物': '炭水化物(利用可能炭水化物)（En計算に使用している値）' };
const RC_EXTRA = ['水分', '食物繊維総量', 'ナトリウム', 'カリウム', 'カルシウム', 'マグネシウム', 'リン', '鉄', '亜鉛', 'コレステロール', 'レチノール活性当量', 'ビタミンD', 'ビタミンB1', 'ビタミンB2', 'ビタミンB6', 'ビタミンB12', '葉酸', 'ビタミンC'];
const RC_CUSTOM_FIELDS = ['エネルギー', '水分', 'たんぱく質', '脂質', '炭水化物', 'ナトリウム', '食塩相当量'];

let rcDb = null, rcKeyIdx = {}, rcCustom = [], rcRecipes = [], rcProducts = [], rcEdit = null, rcLoading = null;
let rcOperators = [];

function rcNorm(s) { return String(s || '').normalize('NFKC').replace(/\s+/g, ''); }
function rcKana(s) { return rcNorm(s).toLowerCase().replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60)); }
function rcFmt(v, d) { if (v == null || !isFinite(v)) return '—'; return Number(v).toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d }); }
function rcUnit(k) { const i = rcKeyIdx[k]; return i == null ? '' : (rcDb.keys[i][1] || ''); }

/* ── 成分表の読み込み（初回だけ。1MB弱の静的JSON） ── */
async function rcLoadDb() {
  if (rcDb) return rcDb;
  if (!rcLoading) rcLoading = (async () => {
    const res = await fetch(RC_JSON_URL);
    if (!res.ok) throw new Error('成分表（' + RC_JSON_URL + '）を読み込めませんでした: HTTP ' + res.status);
    const db = await res.json();
    db.keys = db.keys.map(([n, u]) => [rcNorm(n), u]);
    rcKeyIdx = {}; db.keys.forEach((k, i) => { rcKeyIdx[k[0]] = i; });
    db.foods.forEach(f => { f._s = rcKana([f.n, f.k, f.a, f.ak, f.b, f.bk].join('|')); });
    db.byNo = {}; db.foods.forEach(f => { db.byNo[f.no] = f; });
    rcDb = db; return db;
  })();
  return rcLoading;
}
function rcCustomToFood(c) {
  const v = rcDb.keys.map(k => Number((c.nutrients || {})[k[0]]) || 0);
  return { no: c.food_no, g: 19, n: c.name, c: 0, k: c.kana || '', a: '', ak: '', b: c.memo || '', bk: '', v, custom: true, _s: rcKana([c.name, c.kana, c.memo].join('|')) };
}
function rcFood(no) { no = Number(no); const c = rcCustom.find(x => x.food_no === no && !x.deleted_at); return c ? rcCustomToFood(c) : (rcDb && rcDb.byNo[no]) || null; }
function rcSearch(q, limit) {
  const s = rcKana(q); if (!s) return [];
  const out = [];
  rcCustom.filter(c => !c.deleted_at).map(rcCustomToFood).forEach(f => { if (f._s.includes(s)) out.push(f); });
  for (const f of rcDb.foods) { if (f._s.includes(s)) out.push(f); if (out.length > 400) break; }
  // よく使う食品（○）→ 自社の追加食品 → 名前が短い順（「いのしし・肉・脂身つき・生」のような基本形が先）
  out.sort((a, b) => (b.c - a.c) || ((b.custom ? 1 : 0) - (a.custom ? 1 : 0)) || (a.n.length - b.n.length) || (a.no - b.no));
  return out.slice(0, limit || 40);
}

/* ── 計算（栄養算と同じ: 100gあたり × g ÷ 100 の合計、人数で割って1人分） ── */
function rcCompute(items, servings, yieldG, packG) {
  const n = rcDb.keys.length, totals = new Array(n).fill(0); let sumG = 0; const missing = [];
  const skip = rcKeyIdx['廃棄率'];
  items.forEach(it => {
    const f = rcFood(it.food_no); const g = Number(it.grams) || 0;
    if (!f) { missing.push(it.food_name || String(it.food_no)); return; }
    sumG += g;
    f.v.forEach((v, i) => { if (i !== skip) totals[i] += (Number(v) || 0) * g / 100; });
  });
  const yG = Number(yieldG) > 0 ? Number(yieldG) : sumG;
  const per100 = totals.map(v => yG ? v * 100 / yG : 0);
  const sv = Number(servings) > 0 ? Number(servings) : 1;
  const perServ = totals.map(v => v / sv);
  const pG = Number(packG) > 0 ? Number(packG) : null;
  const perPack = pG ? per100.map(v => v * pG / 100) : null;
  return { totals, per100, perServ, perPack, sumG, yieldG: yG, servings: sv, packG: pG, missing };
}
function rcPick(arr, keys) { const o = {}; keys.forEach(k => { const i = rcKeyIdx[k]; if (i != null) o[k] = Math.round(arr[i] * 1000) / 1000; }); return o; }
function rcNutritionCache(calc, items) {
  const keys = [...RC_MAIN.map(m => m.k), ...Object.values(RC_EN), ...RC_EXTRA];
  const ing = items.slice().sort((a, b) => (Number(b.grams) || 0) - (Number(a.grams) || 0)).map(it => rcIngredientName(it));
  return { per100g: rcPick(calc.per100, keys), per_serving: rcPick(calc.perServ, keys), per_pack: calc.perPack ? rcPick(calc.perPack, keys) : null, total: rcPick(calc.totals, keys),
    sum_g: Math.round(calc.sumG * 10) / 10, yield_g: Math.round(calc.yieldG * 10) / 10, servings: calc.servings, pack_g: calc.packG, ingredients: ing, source: '日本食品標準成分表2020年版（八訂）増補2023年', computed_at: new Date().toISOString() };
}
// 原材料名（食品表示用）: 「いのしし・肉・脂身つき・生」→「いのしし肉」のように材料の見出しだけにする。メモがあればそれを優先
function rcIngredientName(it) {
  if (it.note && it.note.trim()) return it.note.trim();
  const f = rcFood(it.food_no); const n = (f ? f.n : it.food_name) || '';
  if (/^いのしし/.test(n)) return 'いのしし肉';
  if (/^しか/.test(n)) return 'しか肉';
  return n.split('・').slice(0, 2).join('').replace(/[（(].*$/, '');
}

/* ── 一覧 ── */
async function loadRecipes() {
  const grid = document.getElementById('rc-grid'); if (!grid) return;
  grid.innerHTML = '<div class="loading"><span class="spin"></span>読み込み中...</div>';
  try {
    const [db, recipes, custom, products] = await Promise.all([
      rcLoadDb(),
      sb('GET', 'recipes', null, '?select=*&deleted_at=is.null&order=category.asc,name.asc'),
      sb('GET', 'recipe_foods', null, '?select=*&deleted_at=is.null&order=food_no.asc'),
      sb('GET', 'products', null, '?select=id,name,category,unit&deleted_at=is.null&order=name.asc'),
    ]);
    rcRecipes = recipes; rcCustom = custom; rcProducts = products;
    try { rcOperators = (typeof PM_OPERATORS !== 'undefined' && PM_OPERATORS.length) ? PM_OPERATORS : []; } catch (e) { rcOperators = []; }
    rcRenderList();
    const st = document.getElementById('rc-status');
    if (st) st.textContent = `成分表 ${db.foods.length.toLocaleString()}食品（八訂・増補2023年）＋ 追加食品 ${custom.length}件`;
  } catch (e) {
    grid.innerHTML = `<div class="empty-state" style="color:var(--red);grid-column:1/-1;">読み込めませんでした: ${esc2(sbSafeMsg(e))}</div>`;
  }
}
function rcRenderList() {
  const grid = document.getElementById('rc-grid'); if (!grid) return;
  const q = rcKana(document.getElementById('rc-search').value), cat = document.getElementById('rc-cat').value;
  const list = rcRecipes.filter(r => (!cat || r.category === cat) && (!q || rcKana([r.name, r.category, r.memo, (r.nutrition || {}).ingredients ? r.nutrition.ingredients.join(' ') : ''].join('|')).includes(q)));
  const cnt = document.getElementById('rc-count');
  if (cnt) cnt.textContent = `${rcRecipes.length}件の料理（商品と紐づき ${rcRecipes.filter(r => r.product_id).length}件）`;
  if (!list.length) { grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1;">料理がまだありません。「＋ 料理を追加」から材料と重量を入れると、栄養成分が自動で出ます。</div>'; return; }
  grid.innerHTML = list.map(r => {
    const n = r.nutrition || {}, p = n.per100g || {}, prod = rcProducts.find(x => x.id === r.product_id);
    const vals = RC_MAIN.map(m => `<div class="rc-nv"><span>${m.k}</span><b>${rcFmt(p[m.k], m.d)}<small>${m.u}</small></b></div>`).join('');
    return `<div class="rc-card" data-id="${r.id}">
      <div style="display:flex;justify-content:space-between;gap:6px;align-items:flex-start;">
        <div style="font-weight:700;font-size:15px;line-height:1.4;">${esc2(r.name)}</div>
        <span class="badge badge-gold">${esc2(r.category || 'その他')}</span>
      </div>
      <div style="font-size:12px;color:var(--text2);margin-top:4px;">${r.servings ? `${r.servings}人分` : ''}${n.yield_g ? `・出来上がり ${rcFmt(n.yield_g, 0)}g` : ''}${n.ingredients && n.ingredients.length ? `・材料 ${n.ingredients.length}品` : ''}</div>
      <div style="font-size:12px;margin-top:4px;">${prod ? `🛍 <b>${esc2(prod.name)}</b>` : '<span style="color:var(--text3);">商品と未紐づけ</span>'}</div>
      <div class="rc-nvs"><div style="grid-column:1/-1;font-size:11px;color:var(--text2);">100gあたり</div>${vals}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">
        <button class="btn btn-primary btn-sm" style="flex:1;" onclick="rcOpen('${r.id}')">開く・編集</button>
        <button class="btn btn-sm" onclick="rcLabelOpen('${r.id}')">🏷 栄養成分表示</button>
      </div>
    </div>`; }).join('');
}

/* ── 編集 ── */
function rcOpenNew() {
  rcEdit = { id: null, items: [] };
  rcFillForm({ name: '', category: RC_CATEGORIES[0], servings: 1, yield_g: '', product_id: '', pack_g: '', steps: '', memo: '', created_by: '' });
  document.getElementById('recipeModalTitle').textContent = '料理 新規登録';
  document.getElementById('rc-delete-btn').style.display = 'none';
  rcRenderItems();
  document.getElementById('recipeModal').style.display = 'block';
  setTimeout(() => document.getElementById('rc-f-name').focus(), 50);
}
async function rcOpen(id) {
  const r = rcRecipes.find(x => x.id === id); if (!r) return;
  let items = [];
  try { items = await sb('GET', 'recipe_items', null, `?recipe_id=eq.${id}&select=*&order=sort.asc,created_at.asc`); }
  catch (e) { toast('材料を読み込めませんでした: ' + sbSafeMsg(e), 'error'); return; }
  rcEdit = { id, items: items.map(it => ({ food_no: it.food_no, food_name: it.food_name, grams: Number(it.grams) || 0, note: it.note || '' })) };
  rcFillForm(r);
  document.getElementById('recipeModalTitle').textContent = '料理の編集';
  document.getElementById('rc-delete-btn').style.display = '';
  rcRenderItems();
  document.getElementById('recipeModal').style.display = 'block';
}
function rcFillForm(r) {
  const catSel = document.getElementById('rc-f-category');
  catSel.innerHTML = RC_CATEGORIES.map(c => `<option>${esc2(c)}</option>`).join('');
  catSel.value = RC_CATEGORIES.includes(r.category) ? r.category : 'その他';
  const prodSel = document.getElementById('rc-f-product_id');
  prodSel.innerHTML = '<option value="">（紐づけない）</option>' + rcProducts.map(p => `<option value="${p.id}">${esc2(p.name)}</option>`).join('');
  prodSel.value = r.product_id || '';
  const bySel = document.getElementById('rc-f-created_by');
  bySel.innerHTML = '<option value="">担当者</option>' + rcOperators.map(n => `<option>${esc2(n)}</option>`).join('');
  bySel.value = r.created_by || '';
  ['name', 'servings', 'yield_g', 'pack_g', 'steps', 'memo'].forEach(f => { document.getElementById('rc-f-' + f).value = r[f] == null ? '' : r[f]; });
  document.getElementById('rc-food-q').value = ''; document.getElementById('rc-food-results').innerHTML = '';
}
// 商品を選んだら、商品名の「200g」から1袋の内容量を入れる（空のときだけ）
function rcProductChanged() {
  const p = rcProducts.find(x => x.id === document.getElementById('rc-f-product_id').value);
  const el = document.getElementById('rc-f-pack_g');
  if (p && !el.value) { const m = /(\d+(?:\.\d+)?)\s*(g|ｇ|グラム)/i.exec(p.name); if (m) el.value = m[1]; }
  rcRecalc();
}
function rcFoodSearch() {
  const q = document.getElementById('rc-food-q').value, box = document.getElementById('rc-food-results');
  if (!rcDb) { box.innerHTML = '<div class="muted">成分表を読み込み中…</div>'; return; }
  const res = rcSearch(q, 40);
  if (!q.trim()) { box.innerHTML = ''; return; }
  if (!res.length) { box.innerHTML = `<div class="rc-hit muted">「${esc2(q)}」に合う食品がありません。ひらがな・別名（例: ぼたん肉）でも探せます。無い原料は「追加食品」に登録してください。</div>`; return; }
  box.innerHTML = res.map(f => `<div class="rc-hit" onclick="rcAddFood(${f.no})"><span class="rc-hit-no">${f.custom ? '自社' : (f.c ? '○' : '')} ${f.no}</span><span class="rc-hit-n">${esc2(f.n)}${f.a ? `<small>（${esc2(f.a)}）</small>` : ''}</span><span class="rc-hit-g">${esc2((rcDb.groups || {})[String(f.g)] || '')}</span><span class="rc-hit-e">${rcFmt(f.v[rcKeyIdx['エネルギー']], 0)}kcal</span></div>`).join('');
}
function rcAddFood(no) {
  const f = rcFood(no); if (!f || !rcEdit) return;
  rcEdit.items.push({ food_no: f.no, food_name: f.n, grams: 0, note: '' });
  document.getElementById('rc-food-q').value = ''; document.getElementById('rc-food-results').innerHTML = '';
  rcRenderItems();
  const inputs = document.querySelectorAll('#rc-items input[data-f="grams"]'); const last = inputs[inputs.length - 1]; if (last) { last.focus(); last.select && last.select(); }
}
function rcItemChange(i, f, v) { if (!rcEdit || !rcEdit.items[i]) return; rcEdit.items[i][f] = f === 'grams' ? (parseFloat(v) || 0) : v; rcRecalc(); }
function rcItemRemove(i) { if (!rcEdit) return; rcEdit.items.splice(i, 1); rcRenderItems(); }
function rcRenderItems() {
  const body = document.getElementById('rc-items'); if (!body || !rcEdit) return;
  body.innerHTML = rcEdit.items.length ? rcEdit.items.map((it, i) => { const f = rcFood(it.food_no);
    return `<tr><td style="font-size:12.5px;">${esc2(f ? f.n : it.food_name)}<div style="font-size:10.5px;color:var(--text3);">${f && f.custom ? '追加食品' : '成分表'} ${it.food_no}${f ? '' : '（成分表に見つかりません）'}</div></td>
      <td><input class="form-input" type="number" step="0.1" min="0" inputmode="decimal" data-f="grams" value="${it.grams || ''}" oninput="rcItemChange(${i},'grams',this.value)" style="width:82px;text-align:right;"></td>
      <td><input class="form-input" data-f="note" value="${esc2(it.note || '')}" placeholder="表示名・下処理など" oninput="rcItemChange(${i},'note',this.value)" style="min-width:110px;"></td>
      <td><button class="btn btn-sm" onclick="rcItemRemove(${i})" title="外す">✕</button></td></tr>`; }).join('')
    : '<tr><td colspan="4" class="muted" style="padding:10px;">上の検索から食品を選んで、重量（g）を入れてください。</td></tr>';
  rcRecalc();
}
function rcFormVals() {
  const v = {}; ['name', 'category', 'servings', 'yield_g', 'product_id', 'pack_g', 'steps', 'memo', 'created_by'].forEach(f => { v[f] = document.getElementById('rc-f-' + f).value; });
  return v;
}
function rcRecalc() {
  const box = document.getElementById('rc-calc'); if (!box || !rcEdit || !rcDb) return;
  const v = rcFormVals();
  const c = rcCompute(rcEdit.items, v.servings, v.yield_g, v.pack_g);
  rcEdit.calc = c;
  const cols = [['合計', c.totals], [`1人分（${c.servings}人）`, c.perServ], ['100gあたり', c.per100]]; if (c.perPack) cols.push([`1袋（${c.packG}g）`, c.perPack]);
  const showEn = document.getElementById('rc-show-en').checked, showAll = document.getElementById('rc-show-all').checked;
  const rows = RC_MAIN.map(m => ({ k: m.k, label: m.k, u: m.u, d: m.d }));
  if (showEn) Object.keys(RC_EN).forEach(k => rows.push({ k: RC_EN[k], label: k + '（En計算値・栄養算の表示）', u: 'g', d: 1 }));
  if (showAll) RC_EXTRA.forEach(k => { if (rcKeyIdx[k] != null) rows.push({ k, label: k, u: rcUnit(k), d: /^(ナトリウム|カリウム|カルシウム|マグネシウム|リン|コレステロール|レチノール活性当量|葉酸|ビタミンC)$/.test(k) ? 0 : (/^(ビタミンB1|ビタミンB2|ビタミンB6|鉄|亜鉛)$/.test(k) ? 2 : 1) }); });
  box.innerHTML = `<div style="font-size:12px;color:var(--text2);margin-bottom:4px;">材料合計 <b>${rcFmt(c.sumG, 0)}g</b>${Number(v.yield_g) > 0 ? `／出来上がり <b>${rcFmt(c.yieldG, 0)}g</b>（100gあたりはこちらで割る）` : '／出来上がり重量は未入力（材料合計で割る）'}${c.missing.length ? `<span style="color:var(--red);"> ※成分表に無い材料: ${esc2(c.missing.join('、'))}</span>` : ''}</div>
    <div style="overflow-x:auto;"><table class="rc-table"><thead><tr><th>成分</th>${cols.map(x => `<th style="text-align:right;">${esc2(x[0])}</th>`).join('')}</tr></thead><tbody>
    ${rows.map(r => { const i = rcKeyIdx[r.k]; return `<tr><td>${esc2(r.label)}<small style="color:var(--text3);"> ${esc2(r.u)}</small></td>${cols.map(x => `<td style="text-align:right;font-variant-numeric:tabular-nums;">${i == null ? '—' : rcFmt(x[1][i], r.d)}</td>`).join('')}</tr>`; }).join('')}
    </tbody></table></div>`;
}
async function rcSave() {
  if (!rcEdit) return;
  const v = rcFormVals();
  if (!v.name.trim()) { toast('料理名を入れてください', 'error'); return; }
  const items = rcEdit.items.filter(it => it.food_no);
  const calc = rcCompute(items, v.servings, v.yield_g, v.pack_g);
  const payload = { name: v.name.trim(), category: v.category, servings: v.servings === '' ? null : Number(v.servings), yield_g: v.yield_g === '' ? null : Number(v.yield_g),
    product_id: v.product_id || null, pack_g: v.pack_g === '' ? null : Number(v.pack_g), steps: v.steps.trim() || null, memo: v.memo.trim() || null, created_by: v.created_by || null,
    nutrition: rcNutritionCache(calc, items), updated_at: new Date().toISOString() };
  try {
    let id = rcEdit.id;
    if (id) { await sb('PATCH', 'recipes', payload, '?id=eq.' + id); }
    else { const rows = await sb('POST', 'recipes', payload); id = rows && rows[0] && rows[0].id; if (!id) throw new Error('保存の応答に id がありません'); }
    await sb('DELETE', 'recipe_items', null, '?recipe_id=eq.' + id);
    if (items.length) await sb('POST', 'recipe_items', items.map((it, i) => ({ recipe_id: id, food_no: it.food_no, food_name: it.food_name, grams: it.grams || 0, note: it.note || null, sort: i })));
    toast(`料理「${payload.name}」を保存しました（材料 ${items.length}品・100gあたり ${rcFmt(calc.per100[rcKeyIdx['エネルギー']], 0)}kcal）`);
    document.getElementById('recipeModal').style.display = 'none';
    rcEdit = null;
    loadRecipes();
  } catch (e) { toast('保存に失敗しました: ' + sbSafeMsg(e), 'error'); }
}
async function rcDelete() {
  if (!rcEdit || !rcEdit.id) return;
  if (!requireAdmin('料理の削除')) return;
  const r = rcRecipes.find(x => x.id === rcEdit.id);
  if (!confirm(`料理「${r ? r.name : ''}」を削除しますか？（一覧から消えます。材料の記録は残ります）`)) return;
  try { await sb('PATCH', 'recipes', { deleted_at: new Date().toISOString() }, '?id=eq.' + rcEdit.id); toast('削除しました'); document.getElementById('recipeModal').style.display = 'none'; rcEdit = null; loadRecipes(); }
  catch (e) { toast('削除に失敗しました: ' + sbSafeMsg(e), 'error'); }
}

/* ── 追加食品（自社原料・成分表に無いもの） ── */
function rcFoodsOpen() {
  rcFoodsRender();
  document.getElementById('rcFoodModal').style.display = 'block';
}
function rcFoodsRender() {
  const body = document.getElementById('rc-foods-body');
  body.innerHTML = rcCustom.filter(c => !c.deleted_at).map(c => `<tr><td>${c.food_no}</td><td>${esc2(c.name)}<div style="font-size:10.5px;color:var(--text3);">${esc2(c.kana || '')}</div></td>${RC_CUSTOM_FIELDS.map(k => `<td style="text-align:right;">${rcFmt(Number((c.nutrients || {})[k]) || 0, k === 'エネルギー' ? 0 : 1)}</td>`).join('')}<td><button class="btn btn-sm" onclick="rcFoodEdit('${c.id}')">編集</button></td></tr>`).join('')
    || `<tr><td colspan="${RC_CUSTOM_FIELDS.length + 3}" class="muted" style="padding:10px;">まだありません。市販のたれ・仕入れ調味料など、成分表に無い原料をパッケージの栄養成分表示から登録します（100gあたり）。</td></tr>`;
}
function rcFoodEdit(id) {
  const c = id ? rcCustom.find(x => x.id === id) : null;
  document.getElementById('rc-cf-id').value = c ? c.id : '';
  document.getElementById('rc-cf-name').value = c ? c.name : '';
  document.getElementById('rc-cf-kana').value = c ? (c.kana || '') : '';
  document.getElementById('rc-cf-memo').value = c ? (c.memo || '') : '';
  RC_CUSTOM_FIELDS.forEach(k => { document.getElementById('rc-cf-' + k).value = c ? ((c.nutrients || {})[k] ?? '') : ''; });
  document.getElementById('rc-cf-form').style.display = 'block';
  document.getElementById('rc-cf-name').focus();
}
async function rcFoodSave() {
  const id = document.getElementById('rc-cf-id').value, name = document.getElementById('rc-cf-name').value.trim();
  if (!name) { toast('原料名を入れてください', 'error'); return; }
  const nutrients = {};
  RC_CUSTOM_FIELDS.forEach(k => { const v = document.getElementById('rc-cf-' + k).value; if (v !== '') nutrients[k] = Number(v) || 0; });
  // 食塩相当量だけ入っていてナトリウムが無いときは換算（ナトリウム mg = 食塩 g × 1000 ÷ 2.54）。逆も同じ
  if (nutrients['食塩相当量'] != null && nutrients['ナトリウム'] == null) nutrients['ナトリウム'] = Math.round(nutrients['食塩相当量'] * 1000 / 2.54);
  if (nutrients['ナトリウム'] != null && nutrients['食塩相当量'] == null) nutrients['食塩相当量'] = Math.round(nutrients['ナトリウム'] * 2.54 / 1000 * 100) / 100;
  const payload = { name, kana: document.getElementById('rc-cf-kana').value.trim() || null, memo: document.getElementById('rc-cf-memo').value.trim() || null, nutrients, updated_at: new Date().toISOString() };
  try {
    if (id) await sb('PATCH', 'recipe_foods', payload, '?id=eq.' + id);
    else { const max = rcCustom.reduce((m, c) => Math.max(m, c.food_no), RC_CUSTOM_START - 1); payload.food_no = max + 1; await sb('POST', 'recipe_foods', payload); }
    rcCustom = await sb('GET', 'recipe_foods', null, '?select=*&deleted_at=is.null&order=food_no.asc');
    document.getElementById('rc-cf-form').style.display = 'none';
    rcFoodsRender(); toast(`追加食品「${name}」を保存しました`);
    if (rcEdit) rcRenderItems();
  } catch (e) { toast('保存に失敗しました: ' + sbSafeMsg(e), 'error'); }
}

/* ── 食品表示（一括表示）・栄養成分表示・ラベル ──
   2026-09-21 「食品表示で必要なのは何？最低限揃えないといけないのを詰めて可能なら1枚にしたい。」
   容器包装入り加工食品の義務表示（食品表示基準）:
     名称／原材料名（重量順・アレルゲン）／添加物／原料原産地名／内容量／期限／保存方法／製造者（名称・住所）／栄養成分表示
     冷凍食品はさらに 凍結前加熱の有無・加熱調理の必要性。
   料理から自動で出るもの: 名称（商品名）・原材料名・内容量（1袋g）・栄養成分表示・製造者。
   それ以外（期限の日数・保存方法・凍結前加熱・加熱調理・添加物・原料原産地名・アレルゲン）は料理ごとに label に持つ。
   文字の大きさ: 表示可能面積 150cm² 以下は 5.5pt 以上でよい（40×60mm＝24cm²）。 */
const RC_LABEL_DEFAULT = { product_type: '冷凍', expiry_days: 365, storage: '-18℃以下で保存', pre_heated: '加熱していません', need_heating: '加熱してお召し上がりください', additives: '', origin: '', allergens: '' };
const RC_MAKER = '合同会社アルコ 館山ジビエセンター', RC_MAKER_ADDR = '千葉県館山市西長田1163-5';
let rcLabelCurrent = null;
function rcLabelSettings(r) { return Object.assign({}, RC_LABEL_DEFAULT, r.label || {}); }
// 原料原産地名の既定: いちばん重い原材料が肉なら「いのしし肉（千葉県産）」
function rcOriginDefault(r) {
  const first = ((r.nutrition || {}).ingredients || [])[0] || '';
  if (/いのしし|しか/.test(first)) return first + '（千葉県産）';
  return first ? first + '（国産）' : '';
}
function rcExpiryStr(days) { const d = new Date(); d.setDate(d.getDate() + (Number(days) || 0)); return d.toLocaleDateString('ja-JP'); }
function rcLabelData(r) {
  const n = r.nutrition || {}; const prod = rcProducts.find(x => x.id === r.product_id); const st = rcLabelSettings(r);
  const basis = n.per_pack && n.pack_g ? { label: `1袋（${rcFmt(n.pack_g, 0)}g）あたり`, vals: n.per_pack } : { label: '100gあたり', vals: n.per100g || {} };
  let ingredients = (n.ingredients || []).join('、');
  if (st.allergens && st.allergens.trim()) ingredients += `（一部に${st.allergens.trim()}を含む）`;
  const rows = [['名称', prod ? prod.name : r.name], ['原材料名', ingredients || '—']];
  if (st.additives && st.additives.trim()) rows.push(['添加物', st.additives.trim()]);
  rows.push(['原料原産地名', st.origin && st.origin.trim() ? st.origin.trim() : rcOriginDefault(r)]);
  rows.push(['内容量', n.pack_g ? rcFmt(n.pack_g, 0) + 'g' : '—']);
  rows.push([st.product_type === '冷凍' ? '消費期限' : '消費期限', rcExpiryStr(st.expiry_days)]);
  rows.push(['保存方法', st.storage || '—']);
  if (st.product_type === '冷凍') { rows.push(['凍結前加熱の有無', st.pre_heated || '—']); rows.push(['加熱調理の必要性', st.need_heating || '—']); }
  rows.push(['製造者', RC_MAKER + '　' + RC_MAKER_ADDR]);
  return { name: prod ? prod.name : r.name, recipe: r.name, basis, ingredients, packG: n.pack_g, prod, st, rows };
}
function rcLabelBoxHtml(d, cls) {
  return `<div class="${cls || 'rc-nl'}"><div class="rc-nl-h">栄養成分表示（${esc2(d.basis.label)}）</div>${RC_MAIN.map(m => `<div class="rc-nl-r"><span>${m.k}</span><span>${rcFmt(d.basis.vals[m.k], m.d)}${m.u}</span></div>`).join('')}<div class="rc-nl-f">推定値（日本食品標準成分表2020年版（八訂）増補2023年による計算値）</div></div>`;
}
function rcLabelOpen(id) {
  const r = rcRecipes.find(x => x.id === id); if (!r) return;
  if (!r.nutrition || !r.nutrition.per100g) { toast('先に材料と重量を入れて保存してください', 'error'); return; }
  rcLabelCurrent = r;
  const d = rcLabelData(r), st = d.st;
  const sel = (id, opts, val) => `<select class="form-input" id="${id}">${opts.map(o => `<option${o === val ? ' selected' : ''}>${esc2(o)}</option>`).join('')}</select>`;
  const missing = [];
  if (!d.packG) missing.push('内容量（料理の「1袋の内容量」）');
  if (!d.prod) missing.push('名称（商品と紐づけると商品名になります。今は料理名）');
  document.getElementById('rc-lbl-title').textContent = d.name;
  document.getElementById('rc-lbl-body').innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start;">
      <div>
        <div class="rc-ik">${d.rows.map(([k, v]) => `<div class="rc-ik-r"><span>${esc2(k)}</span><span>${esc2(v)}</span></div>`).join('')}</div>
        <div style="margin-top:10px;">${rcLabelBoxHtml(d)}</div>
        <div class="muted" style="margin-top:6px;">${d.packG ? `1袋 ${rcFmt(d.packG, 0)}g で計算。` : '1袋の内容量が未入力なので 100gあたり で表示。'}100gあたり: ${RC_MAIN.map(m => `${m.k} ${rcFmt((r.nutrition.per100g || {})[m.k], m.d)}${m.u}`).join('／')}</div>
      </div>
      <div style="font-size:12.5px;line-height:1.6;">
        <div style="font-weight:700;color:var(--gold);margin-bottom:6px;">表示の設定（この料理に保存されます）</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          <div class="form-group" style="margin:0"><label>区分</label>${sel('rc-lb-product_type', ['冷凍', '冷蔵'], st.product_type)}</div>
          <div class="form-group" style="margin:0"><label>期限（印刷日から何日）</label><input class="form-input" id="rc-lb-expiry_days" type="number" min="1" value="${esc2(st.expiry_days)}"></div>
          <div class="form-group" style="margin:0;grid-column:1/-1"><label>保存方法</label><input class="form-input" id="rc-lb-storage" value="${esc2(st.storage)}"></div>
          <div class="form-group" style="margin:0"><label>凍結前加熱の有無（冷凍のみ）</label>${sel('rc-lb-pre_heated', ['加熱していません', '加熱してあります'], st.pre_heated)}</div>
          <div class="form-group" style="margin:0"><label>加熱調理の必要性（冷凍のみ）</label>${sel('rc-lb-need_heating', ['加熱してお召し上がりください', '解凍してそのままお召し上がりいただけます'], st.need_heating)}</div>
          <div class="form-group" style="margin:0;grid-column:1/-1"><label>原料原産地名（空なら「${esc2(rcOriginDefault(r))}」）</label><input class="form-input" id="rc-lb-origin" value="${esc2(st.origin)}" placeholder="${esc2(rcOriginDefault(r))}"></div>
          <div class="form-group" style="margin:0;grid-column:1/-1"><label>アレルゲン（特定原材料8品目: えび・かに・くるみ・小麦・そば・卵・乳・落花生。「小麦・大豆」のように）</label><input class="form-input" id="rc-lb-allergens" value="${esc2(st.allergens)}" placeholder="例: 小麦・大豆"></div>
          <div class="form-group" style="margin:0;grid-column:1/-1"><label>添加物（使っていなければ空）</label><input class="form-input" id="rc-lb-additives" value="${esc2(st.additives)}" placeholder="例: 調味料（アミノ酸等）"></div>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px;align-items:center;"><button class="btn btn-sm btn-primary" onclick="rcLabelSaveSettings()">設定を保存して表示を更新</button><span class="muted" id="rc-lb-saved"></span></div>
        ${missing.length ? `<div style="margin-top:8px;color:var(--red);font-size:12px;">要入力: ${missing.map(esc2).join('／')}</div>` : ''}
      </div>
    </div>
    <div class="muted" style="margin-top:10px;line-height:1.7;">
      <b>義務表示（食品表示基準・容器包装入り加工食品）</b>: 名称／原材料名（重量順・アレルゲン）／添加物／原料原産地名／内容量／期限／保存方法／製造者／栄養成分表示。冷凍食品は 凍結前加熱の有無・加熱調理の必要性 も。
      表示可能面積が150cm²以下なら文字は5.5pt以上でよく、40×60mm（24cm²）1枚に全部入ります（「表示を全部入れた1枚」）。
      なお30cm²以下の包装は原材料名・添加物・原料原産地名・内容量・栄養成分表示を省略でき、名称・期限・保存方法・製造者・アレルゲンは省略できません。
    </div>`;
  document.getElementById('rcLabelModal').style.display = 'block';
}
async function rcLabelSaveSettings() {
  const r = rcLabelCurrent; if (!r) return;
  const g = id => (document.getElementById(id) || {}).value || '';
  const label = { product_type: g('rc-lb-product_type'), expiry_days: Number(g('rc-lb-expiry_days')) || RC_LABEL_DEFAULT.expiry_days, storage: g('rc-lb-storage').trim(), pre_heated: g('rc-lb-pre_heated'), need_heating: g('rc-lb-need_heating'), origin: g('rc-lb-origin').trim(), allergens: g('rc-lb-allergens').trim(), additives: g('rc-lb-additives').trim() };
  try {
    await sb('PATCH', 'recipes', { label, updated_at: new Date().toISOString() }, '?id=eq.' + r.id);
    r.label = label;
    rcLabelOpen(r.id);
    const el = document.getElementById('rc-lb-saved'); if (el) el.textContent = '保存しました';
  } catch (e) { toast('表示の設定を保存できませんでした: ' + sbSafeMsg(e), 'error'); }
}
function rcLabelPrint(kind) {
  const r = rcLabelCurrent; if (!r) return;
  const d = rcLabelData(r);
  // 40×60mm では見出しを1行に収めるため「1袋250gあたり」の短い書き方にする
  const basisLabel = kind === 'a4' ? `（${d.basis.label}）` : ' ' + d.basis.label.replace(/[（）]/g, '');
  const box = `<div class="nl"><div class="h">栄養成分表示${esc2(basisLabel)}</div>${RC_MAIN.map(m => `<div class="r"><span>${m.k}</span><span>${rcFmt(d.basis.vals[m.k], m.d)}${m.u}</span></div>`).join('')}<div class="f">推定値（八訂成分表による計算値）</div></div>`;
  let css, body;
  if (kind === 'a4') {
    css = `@page{size:A4;margin:15mm}*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Meiryo','Yu Gothic',sans-serif;color:#000}h1{font-size:18pt;margin-bottom:6mm}.g{display:grid;grid-template-columns:1fr 1fr;gap:10mm}.nl{border:1.5pt solid #000;padding:3mm 4mm;font-size:12pt;width:80mm}.nl .h{font-weight:bold;border-bottom:1pt solid #000;margin-bottom:2mm;padding-bottom:1mm}.nl .r{display:flex;justify-content:space-between;padding:.6mm 0}.nl .f{font-size:8pt;color:#333;margin-top:2mm}.ik{border:1.5pt solid #000;font-size:11pt}.ik div{display:grid;grid-template-columns:32mm 1fr;border-bottom:.5pt solid #000}.ik div:last-child{border-bottom:none}.ik span{padding:1.2mm 2mm;line-height:1.5}.ik span:first-child{border-right:.5pt solid #000;font-weight:bold}.s{font-size:9pt;color:#444;margin-top:8mm;line-height:1.6}`;
    body = `<h1>${esc2(d.name)}</h1><div class="g"><div class="ik">${d.rows.map(([k, v]) => `<div><span>${esc2(k)}</span><span>${esc2(v)}</span></div>`).join('')}</div><div>${box}</div></div>
      <div class="s">レシピ: ${esc2(d.recipe)}／材料合計 ${rcFmt((r.nutrition || {}).sum_g, 0)}g・出来上がり ${rcFmt((r.nutrition || {}).yield_g, 0)}g・${(r.nutrition || {}).servings || 1}人分。100gあたり: ${RC_MAIN.map(m => `${m.k} ${rcFmt((r.nutrition.per100g || {})[m.k], m.d)}${m.u}`).join('／')}。計算日 ${((r.nutrition || {}).computed_at || '').slice(0, 10)}</div>`;
  } else if (kind === 'full') {
    // 表示を全部入れた1枚（40×60mm）。一括表示の文字は 5.5pt（表示可能面積150cm²以下の下限）。
    // 余白は精肉ラベルと同じ実測値（左4.5mm・上1.8mm・下3mm）。
    // 項目名を左の列にする表組みだと「凍結前加熱の有無」で折り返して高さが 66mm になった（実測）ので、
    // 項目名を太字にして値を続ける流し込みにし、内容量と消費期限は1行にまとめる。栄養成分表示は横並び
    css = `@page{size:40mm 60mm;margin:0}*{box-sizing:border-box;margin:0;padding:0}body{width:40mm;height:60mm;font-family:'Meiryo','Yu Gothic',sans-serif;padding:1.8mm .5mm 3mm 4.5mm;overflow:hidden;color:#000}
      .n{font-size:8pt;font-weight:bold;line-height:1.2;margin-bottom:.6mm}
      .ik{border:.5pt solid #000;padding:.4mm .7mm;font-size:5.5pt;line-height:1.25}.ik div{margin:0}.ik b{font-weight:bold}
      .nl{margin-top:.8mm;font-size:5.5pt;line-height:1.3}.nl .h{font-weight:bold}.nl .r{display:inline-block;margin-right:1.6mm;white-space:nowrap}.nl .f{font-size:3.8pt;color:#333}`;
    const nut = `<div class="nl"><div class="h">栄養成分表示${esc2(basisLabel)}</div>${RC_MAIN.map(m => `<span class="r">${m.k} ${rcFmt(d.basis.vals[m.k], m.d)}${m.u}</span>`).join('')}<div class="f">推定値（八訂成分表による計算値）</div></div>`;
    const rows = d.rows.map(([k, v]) => [k, k === '製造者' ? RC_MAKER + ' ' + RC_MAKER_ADDR : v]);
    const lines = []; for (let i = 0; i < rows.length; i++) { const [k, v] = rows[i];
      if (k === '内容量' && rows[i + 1] && rows[i + 1][0] === '消費期限') { lines.push(`<div><b>内容量</b> ${esc2(v)}　<b>消費期限</b> ${esc2(rows[i + 1][1])}</div>`); i++; }
      else lines.push(`<div><b>${esc2(k)}</b> ${esc2(v)}</div>`); }
    body = `<div class="n">${esc2(d.name)}</div><div class="ik">${lines.join('')}</div>${nut}`;
  } else {
    // 栄養成分・原材料だけの補助ラベル（40×60mm・精肉ラベルの隣に貼る）
    css = `@page{size:40mm 60mm;margin:0}*{box-sizing:border-box;margin:0;padding:0}body{width:40mm;height:60mm;font-family:'Meiryo','Yu Gothic',sans-serif;padding:1.8mm .5mm 3mm 4.5mm;overflow:hidden;color:#000}.n{font-size:8pt;font-weight:bold;border-bottom:.5pt solid #000;padding-bottom:.4mm;line-height:1.2}.i{font-size:5.5pt;line-height:1.25;margin-top:.6mm}.i b{font-weight:bold}.nl{border:.6pt solid #000;padding:.8mm 1mm;margin-top:1mm;font-size:6.5pt}.nl .h{font-weight:bold;border-bottom:.4pt solid #000;margin-bottom:.4mm;padding-bottom:.2mm;font-size:6pt}.nl .r{display:flex;justify-content:space-between;line-height:1.35}.nl .f{font-size:3.8pt;color:#333;margin-top:.4mm}.mk{font-size:4pt;color:#333;margin-top:.8mm;line-height:1.25}`;
    body = `<div class="n">${esc2(d.name)}</div><div class="i"><b>原材料名</b> ${esc2(d.ingredients || '—')}</div><div class="i"><b>内容量</b> ${d.packG ? rcFmt(d.packG, 0) + 'g' : '—'}　<b>保存方法</b> ${esc2(d.st.storage)}</div>${box}<div class="mk">製造者 ${RC_MAKER}<br>${RC_MAKER_ADDR}</div>`;
  }
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${css}</style></head><body>${body}</body></html>`;
  if (typeof pmPrintLabelHtml === 'function') pmPrintLabelHtml(html);
  else { const w = window.open('', '_blank'); w.document.write(html); w.document.close(); w.print(); }
}

/* 加工調理タブの商品カードに、紐づいた料理を出す（loadProducts の最後から呼ばれる） */
async function rcAnnotateProducts() {
  try {
    const rows = await sb('GET', 'recipes', null, '?select=id,name,product_id,nutrition&deleted_at=is.null&product_id=not.is.null');
    document.querySelectorAll('#products-grid [data-product-id]').forEach(card => {
      const rs = rows.filter(r => r.product_id === card.dataset.productId); if (!rs.length) return;
      const p = (rs[0].nutrition || {}).per100g || {};
      const el = document.createElement('div'); el.className = 'rc-prod-note';
      el.innerHTML = `🍳 ${rs.map(r => esc2(r.name)).join('・')}<span style="color:var(--text2);"> 100g ${rcFmt(p['エネルギー'], 0)}kcal・塩 ${rcFmt(p['食塩相当量'], 1)}g</span>`;
      el.onclick = () => { const b = document.querySelector('.tab-btn[data-tab="recipes"]'); if (b) b.click(); };
      card.appendChild(el);
    });
  } catch (e) { /* 表示だけなので失敗しても業務は止めない */ }
}
