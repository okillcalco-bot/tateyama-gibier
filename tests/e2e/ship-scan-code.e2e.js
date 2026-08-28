// 出荷スキャン: ラベルのバーコード（8桁の数字キー）で在庫が引けること
//
//   事故（2026-08-28 優美＆Co. の出荷登録）
//     ラベル3枚のバーコードが「読めない」と言われた。実際はスキャナは読めていて、
//     handleShippingScan が読み取った値を先に normIdent へ通していたため
//     '10000992' → 'TGC-08-10000992' という存在しない識別コードで在庫を探していた。
//     加工処理(kkScanAdd)は生の値を渡していたので、出荷とトレーサビリティだけが落ちた。
//
//   ここで測ること
//     1. 8桁の数字キーは scan_code で引く（頭を足さない）
//     2. 短縮コード・旧ラベル(X-428-RO)も引ける
//     3. 削除済みの行を指すラベルは行き止まりにせず、同じ個体の在庫を出して選ばせる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const ORDER = {
  id: 'o1', order_code: 'ORD-TEST01', status: '確認済', customer_id: 'c1',
  delivery_date: '2026-08-28', order_date: '2026-08-24', total_amount: 0
};
// 実際に読めなかった3枚と同じ形
const INV = [
  { id: 'i1', ident_code: 'TGC-08-T272-KR', scan_code: '10000992', part_name: '肩ロース', weight: '1.07', weight_kg: '1.070',
    species: 'イノシシ', individual_id: 'TGC-08-T272', individual_code: 'TGC-08-T272', status: '在庫', tier: 2, deleted_at: null },
  { id: 'i2', ident_code: 'TGC-08-M168-RO-2', scan_code: '10000922', part_name: 'ロース', weight: '1.93', weight_kg: '1.930',
    species: 'イノシシ', individual_id: 'TGC-08-M168', individual_code: 'TGC-08-M168', status: '在庫', tier: 2, deleted_at: null },
  // 登録し直しで消えた行。手元のパックにはこのラベルが貼ってある
  { id: 'i3', ident_code: 'TGC-08-T271-KR-3', scan_code: '10000944', part_name: '肩ロース', weight: '1.07', weight_kg: '1.070',
    species: 'イノシシ', individual_id: 'TGC-08-T271', individual_code: 'TGC-08-T271', status: '在庫', tier: 2,
    deleted_at: '2026-08-27T03:17:38.099+00:00' },
  // 生き残っている双子
  { id: 'i4', ident_code: 'TGC-08-T271-KR-2', scan_code: '10000943', part_name: '肩ロース', weight: '1.07', weight_kg: '1.070',
    species: 'イノシシ', individual_id: 'TGC-08-T271', individual_code: 'TGC-08-T271', status: '在庫', tier: 2, deleted_at: null },
  // 旧ラベル（TGC頭が無い実在の識別コード。本番に在庫33件ある）
  { id: 'i5', ident_code: 'X-428-RO', scan_code: '10000501', part_name: 'ロース', weight: '2.10', weight_kg: '2.100',
    species: 'イノシシ', individual_id: 'X-428', individual_code: 'X-428', status: '在庫', tier: 2, deleted_at: null }
];

// PostgREST の絞り込みを、本番と同じ意味で再現する
function pick(qs) {
  const m = qs.match(/scan_code=eq\.([^&]+)/);
  if (m) return INV.filter(r => r.scan_code === m[1]);
  const e = qs.match(/(?:^|[?&])ident_code=eq\.([^&]+)/);
  if (e) return INV.filter(r => r.ident_code === e[1]);
  const or = qs.match(/or=\(([^)]*)\)/);
  if (or) {
    const idents = [...or[1].matchAll(/ident_code\.eq\."?([^",)]+)"?/g)].map(x => x[1]);
    const inds = [...or[1].matchAll(/individual(?:_code|_id)\.eq\.([^",)]+)/g)].map(x => x[1]);
    const like = [...or[1].matchAll(/ident_code\.like\.([^",)]+)/g)].map(x => x[1].replace(/\*$/, ''));
    let rows = INV.filter(r =>
      idents.includes(r.ident_code)
      || inds.includes(r.individual_code) || inds.includes(r.individual_id)
      || like.some(p => r.ident_code.startsWith(p)));
    if (/status=eq\./.test(qs)) rows = rows.filter(r => r.status === '在庫');
    if (/deleted_at=is\.null/.test(qs)) rows = rows.filter(r => !r.deleted_at);
    return rows;
  }
  return [];
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));

  const invQueries = [];
  const patches = [];
  await page.route('**/*', r => {
    const u = r.request().url(), m = r.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    const qs = decodeURIComponent(u.split('?')[1] || '');
    if (/\/rest\/v1\/inventory/.test(u)) {
      if (m === 'PATCH') { patches.push({ table: 'inventory', qs, body: JSON.parse(r.request().postData() || '{}') }); return J([]); }
      invQueries.push(qs);
      return J(pick(qs));
    }
    if (/\/rest\/v1\/order_items/.test(u)) {
      if (m === 'PATCH') { patches.push({ table: 'order_items', qs, body: JSON.parse(r.request().postData() || '{}') }); return J([]); }
      // 引当先の空き行（肩ロース1行・ロース1行）
      if (/inventory_id=eq\./.test(qs)) return J([]);
      return J([
        { id: 'oi1', order_id: 'o1', part_name: '肩ロース', species: 'イノシシ', inventory_id: null, weight: 1, weight_kg: 1, unit_price: 3000 },
        { id: 'oi2', order_id: 'o1', part_name: 'ロース', species: 'イノシシ', inventory_id: null, weight: 2, weight_kg: 2, unit_price: 4000 }
      ]);
    }
    if (/\/rest\/v1\/orders/.test(u)) return J([ORDER]);
    if (/\/rest\/v1\/customers/.test(u)) return J([{ id: 'c1', name: '優美＆Co.' }]);
    if (/\/rest\/v1\/individuals/.test(u)) return J([{ label_id: 'TGC-08-T272', species: 'イノシシ' }]);
    return J([]);
  });

  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(700);

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  // ── 1) 検索条件そのものを測る ──
  const f = await page.evaluate(() => ({
    key: invScanFilter('10000992'),
    keyWide: invScanFilter('１００００９９２'),
    short: invScanFilter('t272-kr'),
    full: invScanFilter('TGC-08-T272-KR'),
    legacy: invScanFilter('X-428-RO'),
    ni: normIdent('10000992'),
    niShort: normIdent('T272-KR')
  }));
  T('8桁の数字キーは scan_code で引く', f.key === 'scan_code=eq.10000992', f.key);
  T('全角の数字キーも scan_code で引く', f.keyWide === 'scan_code=eq.10000992', f.keyWide);
  T('数字キーに TGC-08- を足さない（今回の原因）', f.ni === '10000992', f.ni);
  T('短縮コードには TGC-08- を足す', f.niShort === 'TGC-08-T272-KR', f.niShort);
  T('小文字の短縮コードも引ける', /TGC-08-T272-KR/.test(decodeURIComponent(f.short)), decodeURIComponent(f.short));
  T('フル桁はそのまま引く', f.full === 'ident_code=eq.TGC-08-T272-KR', decodeURIComponent(f.full));
  T('旧ラベル X-428-RO も候補に入る', /"X-428-RO"/.test(decodeURIComponent(f.legacy)), decodeURIComponent(f.legacy));

  // ── 2) 出荷画面でバーコードを読ませる（実際に落ちた動線） ──
  await page.evaluate(() => {
    shipSelectedOrderId = 'o1';
    shipOrdersCache = { o1: { order: { id: 'o1', order_code: 'ORD-TEST01', status: '確認済' }, customer: { name: '優美＆Co.' } } };
  });

  invQueries.length = 0; patches.length = 0;
  await page.evaluate(async () => { document.getElementById('ship-scan-code').value = '10000992'; await handleShippingScan(); });
  await page.waitForTimeout(600);
  T('出荷スキャンが scan_code で引く（TGC-08-10000992 で探さない）',
    invQueries.some(q => /scan_code=eq\.10000992/.test(q)) && !invQueries.some(q => /TGC-08-10000992/.test(q)),
    invQueries[0] ? invQueries[0].slice(0, 70) : '(問合せ無し)');
  const res1 = await page.$eval('#ship-scan-result', el => el.textContent.replace(/\s+/g, ' '));
  T('肩ロースが割り当てられる', /割当完了/.test(res1) && /肩ロース/.test(res1), res1.slice(0, 80));
  T('結果は数字キーでなく識別コードで出す（人が照合できる）',
    /TGC-08-T272-KR/.test(res1) && !/割当完了: 10000992/.test(res1), res1.slice(0, 70));
  T('在庫に引当済を書く',
    patches.some(p => p.table === 'inventory' && /id=eq\.i1/.test(p.qs) && p.body.status === '引当済'),
    JSON.stringify(patches.map(p => [p.table, p.qs.slice(0, 18)])));
  T('注文の商品行に在庫を紐付ける',
    patches.some(p => p.table === 'order_items' && p.body.inventory_id === 'i1'), '');

  // 2枚目（ロース）
  invQueries.length = 0; patches.length = 0;
  await page.evaluate(async () => { document.getElementById('ship-scan-code').value = '10000922'; await handleShippingScan(); });
  await page.waitForTimeout(600);
  const res2 = await page.$eval('#ship-scan-result', el => el.textContent.replace(/\s+/g, ' '));
  T('2枚目（ロース 1.9kg）も割り当てられる', /割当完了/.test(res2) && /ロース/.test(res2), res2.slice(0, 80));

  // ── 3) 削除済みの行を指すラベルは行き止まりにしない ──
  invQueries.length = 0; patches.length = 0;
  await page.evaluate(async () => { document.getElementById('ship-scan-code').value = '10000944'; await handleShippingScan(); });
  await page.waitForTimeout(700);
  const res3 = await page.$eval('#ship-scan-result', el => el.innerHTML);
  const res3t = await page.$eval('#ship-scan-result', el => el.textContent.replace(/\s+/g, ' '));
  T('削除済みだと分かる', /削除済み/.test(res3t), res3t.slice(0, 90));
  T('同じ個体の生きている在庫を出す', /TGC-08-T271-KR-2/.test(res3), res3t.slice(0, 130));
  T('削除済みの行は選択肢に出さない', !/TGC-08-T271-KR-3<\/span>/.test(res3), '');
  T('タップで割り当てられるボタンになっている', /<button[^>]*handleShippingScan/.test(res3), '');

  // ── 4) 旧ラベル（識別コード印字）も出荷で読める ──
  invQueries.length = 0; patches.length = 0;
  await page.evaluate(async () => { document.getElementById('ship-scan-code').value = 'X-428-RO'; await handleShippingScan(); });
  await page.waitForTimeout(600);
  T('旧ラベルは打った通りの識別コードで引く',
    invQueries.some(q => /"X-428-RO"/.test(q)), invQueries[0] ? invQueries[0].slice(0, 90) : '(問合せ無し)');

  // ── 5) 見つからないときの案内が的外れにならない ──
  invQueries.length = 0;
  await page.evaluate(async () => { document.getElementById('ship-scan-code').value = '19999999'; await handleShippingScan(); });
  await page.waitForTimeout(600);
  const res5 = await page.$eval('#ship-scan-result', el => el.textContent.replace(/\s+/g, ' '));
  T('無い数字キーは「バーコード」として断る', /バーコード「19999999」/.test(res5), res5.slice(0, 90));
  T('数字キーを個体番号として探しに行かない',
    !invQueries.some(q => /individual_code\.eq\.19999999/.test(q)), invQueries.join(' | ').slice(0, 90));

  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
