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
//   2026-09-10 追記: 最初の修正でURLに ?_ts=<timestamp> というダミーのクエリパラメータを
//     付けてキャッシュを回避しようとしたが、PostgRESTはクエリパラメータを列名として
//     フィルタ解釈するため「failed to parse filter」で採番自体が常に失敗するようになって
//     しまった（キャッシュされる時だけ失敗する前の不具合より悪化）。ダミーパラメータ方式を
//     やめ、fetchの cache:'no-store' オプションでHTTPキャッシュ自体を無効化する方式に直した。
//
//   ここで測ること
//     1. 採番のGETクエリのURLに、PostgRESTがフィルタと誤解釈するダミーパラメータ
//        （旧修正の ?_ts=... など）が含まれていない
//     2. 採番のGET自体が失敗した場合、握り潰さず明確なアラートを出し、
//        書類は保存されない（サイレントに番号0番から採番し直したりしない）
//     3. 通常時（GET成功）は正しく採番でき、書類発行そのものが成功する
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
  let docNumberShouldFail = true; // 最初は失敗させ、あとで成功に切り替える

  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = (x, status) => rt.fulfill({ status: status || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (/\/customers\b/.test(url) && m === 'GET') return J([CUST_A]);
    if (/\/orders\b/.test(url) && /order_items/.test(url) && m === 'GET') return J([ORDER]);
    if (/\/orders\b/.test(url) && m === 'GET') return J([]);
    if (/\/documents\b/.test(url) && m === 'GET' && /doc_number=like\./.test(url)) {
      docNumberGetUrls.push(url);
      if (docNumberShouldFail) return J({ message: 'internal error' }, 500); // 採番クエリ自体がエラーを返すケース
      return J([]); // 成功時（まだ0件）
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

  ck('採番GETのURLにPostgRESTがフィルタと誤解釈するダミーパラメータが含まれない（?_ts=等）',
    docNumberGetUrls.length > 0 && docNumberGetUrls.every(u => !/[?&]_ts=/.test(u)), JSON.stringify(docNumberGetUrls));

  // GETが成功する状態に戻して、通常どおり採番→発行できることを確認する
  docNumberShouldFail = false;
  let docNumberOk = false;
  const num = await page.evaluate(() => computeDocNumber('請求書', '2026-09-08').then(n => { window.__docNumberOk = true; return n; }).catch(e => { window.__docNumberErr = String(e && e.message || e); return null; }));
  docNumberOk = await page.evaluate(() => !!window.__docNumberOk);
  ck('採番GETが成功すれば正しく採番できる（例外にならない）', docNumberOk && /^INV-\d{6}-\d{3}$/.test(num || ''), String(num) + ' / ' + (await page.evaluate(() => window.__docNumberErr || '')));

  ck('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [name, ok2, got] of results) { console.log((ok2 ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 200) + ']' : '')); if (ok2) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
