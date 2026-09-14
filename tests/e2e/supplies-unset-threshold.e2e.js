// 資材在庫: 発注点が未設定の品目は「要発注」にしない・分類ごとに並ぶ・保存時の空欄は未設定(null)
//
//   きっかけ（2026-09-14）
//     品名だけ18品目（ポリ袋・真空袋・段ボール・手袋など）を先に登録した。在庫数も発注点も未入力(null)のため
//     Number(null) <= Number(null) → 0 <= 0 が真になり、全品目が「要発注」・ダッシュボードと
//     ナビのバッジも18件になる。発注点が無い品目は警告しないのが正しい。
//
//   ここで測ること
//     1. 発注点 null の品目は要発注バッジ・警告に出ない。発注点があり在庫がそれ以下の品目だけ出る
//     2. 一覧は分類→品名の順で問い合わせる
//     3. 新規登録で在庫数・発注点を空欄にすると null で保存される（0ではない）
//     4. ナビのバッジ・ダッシュボードの「資材が発注点割れ」も同じ判定
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const posts = []; const reqs = [];
  const ROWS = [
    { id: 's1', name: 'ポリ袋20号', category: '包材', unit: '枚', stock_qty: null, min_qty: null },
    { id: 's2', name: '真空袋BN2233', category: '包材', unit: '枚', stock_qty: 0, min_qty: null },
    { id: 's3', name: '段ボール80', category: '梱包', unit: '枚', stock_qty: 5, min_qty: 10 },
    { id: 's4', name: 'ビニール手袋M', category: '衛生用品', unit: '枚', stock_qty: 300, min_qty: 100 },
  ];
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/rest\/v1\/supplies/.test(u)) {
      reqs.push(decodeURIComponent(u.split('?')[1] || ''));
      if (r.request().method() === 'POST') { posts.push(JSON.parse(r.request().postData())); return J([{ id: 's5' }]); }
      return J(ROWS);
    }
    return J([]);
  });

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  await page.goto('file://' + path.resolve(__dirname, '../../index.html') + '?tab=supplies');
  await page.waitForTimeout(900);

  const rows = await page.$$eval('#supplies-body tr', trs => trs.map(tr => ({ name: tr.children[0].textContent.trim(), low: /要発注/.test(tr.children[0].textContent) })));
  T('4品目が並ぶ', rows.length === 4, JSON.stringify(rows));
  T('発注点が未設定（null）の品目は要発注にならない（在庫0でも）', rows.filter(r => /ポリ袋|真空袋/.test(r.name)).every(r => !r.low), JSON.stringify(rows.filter(r => /ポリ袋|真空袋/.test(r.name))));
  T('発注点があり在庫がそれ以下の品目だけ要発注', rows.find(r => /段ボール80/.test(r.name)).low && !rows.find(r => /手袋M/.test(r.name)).low, '');
  const warn = await page.$eval('#supply-warn', el => ({ shown: el.style.display !== 'none', text: el.textContent }));
  T('警告は「発注が必要: 1品目 — 段ボール80」', warn.shown && /1品目/.test(warn.text) && /段ボール80/.test(warn.text) && !/ポリ袋/.test(warn.text), warn.text);
  T('一覧は分類→品名の順で問い合わせる', reqs.some(q => /order=category\.asc\.nullslast,name\.asc/.test(q)), reqs[0]);
  T('ナビのバッジも同じ判定（1件）', (await page.evaluate(() => { const b = document.getElementById('nav-badge-supplies'); return b ? b.textContent.trim() : ''; })) === '1', await page.evaluate(() => document.getElementById('nav-badge-supplies')?.textContent));

  // 新規登録: 在庫数・発注点を空欄で保存 → null
  await page.evaluate(() => supplyOpenNew());
  await page.fill('#sup-f-name', 'ギフトボックス80');
  await page.fill('#sup-f-category', '梱包');
  await page.fill('#sup-f-unit', '個');
  await page.evaluate(() => supplySave());
  await page.waitForTimeout(400);
  T('空欄の在庫数・発注点は null で保存（0にしない）', posts.length === 1 && posts[0].name === 'ギフトボックス80' && posts[0].stock_qty === null && posts[0].min_qty === null, JSON.stringify(posts[0] || {}));

  T('pageerrorなし', errors.length === 0, errors.join(' / '));
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
