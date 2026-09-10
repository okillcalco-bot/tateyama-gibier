// 書類発行（order-admin.html「書類発行」タブ）: 採番クエリのキャッシュ対策とエラーの可視化
//
//   きっかけ（2026-09-10）
//     PR #284でリトライを追加したにもかかわらず、ノブレスオブリージュの請求書で
//     「書類番号の採番が競合しました」が3回とも同じ番号（001のまま）で発生し続けた。
//     documentsテーブルには実際には1件も保存されておらず、真の競合ではなく
//     computeDocNumber()のGETがブラウザにキャッシュされ、まだ0件だった頃の
//     古い結果を返し続けていたことが原因と判明。また、GET自体が失敗した場合も
//     try/catchで握り潰して黙ってmax=0を採用しており、サイレント失敗になっていた。
//
//   ここで測ること
//     1. 採番のGETクエリは呼ぶたびにURLが変わる（キャッシュ回避パラメータが付く）
//     2. 採番のGET自体が失敗した場合、握り潰さず明確なアラートを出し、
//        書類は保存されない（サイレントに番号0番から採番し直したりしない）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const alerts = []; page.on('dialog', async d => { alerts.push(d.message()); await d.dismiss(); });

  const CUST_A = { id: 'cust-a', code: 'C0001', name: 'A店', address: '千葉県A市', is_active: true };
  const ORDER = {
    id: 'ord-a', customer_id: CUST_A.id, customer_name: CUST_A.name, order_code: 'ORD-A',
    order_date: '2026-09-08', delivery_date: '2026-09-08', status: '発送済', total_amount: 0,
    order_items: [{ id: 'i1', species: 'イノシシ', part_name: 'モモ', weight_kg: 2, unit_price: 3000, subtotal: 6000 }],
  };

  const docNumberGetUrls = [];
  let postCount = 0;

  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = (x, status) => rt.fulfill({ status: status || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (/\/customers\b/.test(url) && m === 'GET') return J([CUST_A]);
    if (/\/orders\b/.test(url) && /order_items/.test(url) && m === 'GET') return J([ORDER]);
    if (/\/orders\b/.test(url) && m === 'GET') return J([]);
    if (/\/documents\b/.test(url) && m === 'GET' && /doc_number=like\./.test(url)) {
      docNumberGetUrls.push(url);
      // 採番クエリ自体がエラーを返すケース（DB側の一時的な失敗などを想定）
      return J({ message: 'internal error' }, 500);
    }
    if (/\/documents\b/.test(url) && m === 'GET') return J([]); // 発行済み突き合わせ（order_id=in.）は正常応答
    if (/\/documents\b/.test(url) && m === 'POST') { postCount++; return J([{ id: 'doc-1' }], 201); }
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));

  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(600);
  await page.evaluate(() => switchTab('documents'));
  await page.waitForTimeout(300);

  const results = [];
  const ck = (name, cond, got) => results.push([name, cond, got]);

  await page.evaluate(() => { document.querySelectorAll('#docOrderList input[type=checkbox]').forEach(cb => cb.checked = true); });
  const ok = await page.evaluate(() => generateDoc('請求書'));

  ck('採番GETが失敗した場合はfalseを返す', ok === false, String(ok));
  ck('採番エラーのアラートが出る', alerts.some(a => /採番でエラーが発生/.test(a)), JSON.stringify(alerts));
  ck('採番が失敗した場合はdocumentsに保存されない', postCount === 0, String(postCount));
  ck('「採番が競合しました」の誤ったアラートは出ない（真の競合ではないため）', !alerts.some(a => /採番が競合/.test(a)), JSON.stringify(alerts));

  // 2回連続で採番GETを呼んでもURLが同一にならない（キャッシュ回避パラメータの確認）
  const u1 = await page.evaluate(() => computeDocNumber('請求書', '2026-09-08').catch(() => null));
  const u2 = await page.evaluate(() => computeDocNumber('請求書', '2026-09-08').catch(() => null));
  ck('採番GETのURLに毎回異なるキャッシュ回避パラメータが付く', docNumberGetUrls.length >= 2 && docNumberGetUrls[docNumberGetUrls.length - 1] !== docNumberGetUrls[docNumberGetUrls.length - 2], JSON.stringify(docNumberGetUrls.slice(-2)));
  ck('採番GETのURLに_tsパラメータが含まれる', docNumberGetUrls.every(u => /[?&]_ts=\d+/.test(u)), JSON.stringify(docNumberGetUrls));

  ck('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [name, ok2, got] of results) { console.log((ok2 ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 200) + ']' : '')); if (ok2) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
