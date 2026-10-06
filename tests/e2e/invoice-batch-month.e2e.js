// 請求書作成: 先月分を請求先ごとに1枚ずつまとめて発行し、全員分を1つのPDF（1請求先1ページ）に（2026-10-06）
//
//   きっかけ
//     月末締めの請求書を、請求先を1件ずつ選んで「注文から取り込む」→発行、を顧客の数だけ繰り返していた。
//     「先月を選べばまとめて（顧客ごとに分けて）PDFで打ち出せるようにしたい」
//
//   ここで測ること
//     1. 先月の未請求の注文を請求先ごとに集計する（請求済みの注文・先月以外は入れない）
//     2. 仲卸業者（ノブレスオブリージュ）のタグがある注文は、お店ではなく業者あてにまとめる
//     3. 顧客につながっていない注文は集計に入れず、赤字で知らせる（黙って落とさない）
//     4. 金額0の請求先（誤送で0円など）は最初からチェックを外す。住所未登録は注意を出す
//     5. 明細の金額は注文の金額（顧客別単価）から作る。価格マスタで引き直さない
//     6. まとめて発行: 請求先ごとに書類1枚・番号は連番・注文を紐付け（二重請求防止）
//     7. 印刷画面は1つで、1請求先1ページ（改ページ）・各社の宛名が入る
//     8. 仲卸業者あての請求書には【出荷内訳】（いつ・どこへ・何を）を備考に入れる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date('2026-10-06T03:00:00Z'));
  const errors = []; page.on('pageerror', e => errors.push(e.message));

  const CUSTS = [
    { id: 'c-a', code: 'C1', name: 'A食堂', price_rank: 'standard', address: '東京都A区1-1', honorific: '御中', is_active: true },
    { id: 'c-b', code: 'C2', name: 'B商店', price_rank: 'standard', address: null, honorific: '様', is_active: true },
    { id: 'c-c', code: 'C3', name: 'Cビストロ', price_rank: 'standard', address: '東京都C区', is_active: true },
    { id: 'c-w', code: 'C0731', name: 'ノブレスオブリージュ', price_rank: 'standard', address: '東京都W区', honorific: '御中', is_active: true },
    { id: 'c-z', code: 'C9', name: 'Z誤送', price_rank: 'standard', address: '千葉県', is_active: true },
    { id: 'c-t', code: 'C10', name: 'トレタテ', price_rank: 'standard', address: '東京都T区', is_active: true },
    { id: 'c-o', code: 'C11', name: 'OTG', price_rank: 'standard', address: '東京都品川区', notes: 'トレタテ\n出荷登録の画面で登録', is_active: true },
  ];
  const it = (part, kg, price, extra) => ({ species: 'イノシシ', part_name: part, weight_kg: kg, weight: kg, unit_price: price, subtotal: Math.round(kg * price), amount: Math.round(kg * price), inventory_id: null, grade_snapshot: '並', ...(extra || {}) });
  const ORDERS = [
    { id: 'o1', order_code: 'DIR-0903', customer_id: 'c-a', customer_name: 'A食堂', order_date: '2026-09-03', delivery_date: '2026-09-03', status: '発送済', memo: null,
      order_items: [it('枝肉（全体）', 10, 1500)], shipments: [{ freight: 1300, size_code: 100, is_cool: true }] },
    { id: 'o2', order_code: 'DIR-0920', customer_id: 'c-a', customer_name: 'A食堂', order_date: '2026-09-20', delivery_date: '2026-09-20', status: '発送済', memo: null,
      order_items: [it('モモ（ソト）', 1.0, 2600), it('キョン（一頭分・ご希望）', 0, 3000, { subtotal: 0, amount: 0, weight_kg: 0, weight: 0 })], shipments: [] },
    { id: 'o3', order_code: 'DIR-0915', customer_id: 'c-b', customer_name: 'B商店', order_date: '2026-09-15', delivery_date: '2026-09-15', status: '発送済', memo: null,
      order_items: [it('カタ', 2, 2200)], shipments: [{ freight: 800, size_code: 60, is_cool: true }] },
    { id: 'o4', order_code: 'DIR-0916', customer_id: 'c-c', customer_name: 'Cビストロ', order_date: '2026-09-16', delivery_date: '2026-09-16', status: '発送済', memo: 'ノブレスオブリージュ',
      order_items: [it('内臓', 2.9, 1000)], shipments: [{ freight: 1300, size_code: 100, is_cool: true }] },
    { id: 'o5', order_code: 'DIR-0910-BILLED', customer_id: 'c-a', customer_name: 'A食堂', order_date: '2026-09-10', delivery_date: '2026-09-10', status: '発送済', memo: null,
      order_items: [it('ロース', 1, 3800)], shipments: [] },
    { id: 'o6', order_code: 'DIR-0912-NOCUST', customer_id: null, customer_name: '名無し商店', order_date: '2026-09-12', delivery_date: '2026-09-12', status: '発送済', memo: null,
      order_items: [it('ヒレ', 0.5, 3800)], shipments: [] },
    { id: 'o7', order_code: 'DIR-0928-Z', customer_id: 'c-z', customer_name: 'Z誤送', order_date: '2026-09-28', delivery_date: '2026-09-28', status: '発送済', memo: null,
      order_items: [it('スネ', 0, 1600, { subtotal: 0, amount: 0, weight_kg: 0, weight: 0 })], shipments: [] },
    { id: 'o8', order_code: 'BASE-XYZ', channel: 'BASEネットショップ', customer_id: null, customer_name: '西中 真一（BASE）', order_date: '2026-09-12', delivery_date: '2026-09-12', status: '発送済', memo: null,
      order_items: [it('スライス', 0.3, 5000)], shipments: [] },
    { id: 'o9', order_code: 'DIR-1006-OTG', customer_id: 'c-o', customer_name: 'OTG', order_date: '2026-09-25', delivery_date: '2026-09-25', status: '発送済', memo: null,
      order_items: [it('ロース', 1, 3800)], shipments: [] },
  ];
  let orderQueries = [];
  const docs = [], docItems = [], docOrders = [];
  await page.route('**/rest/v1/**', async rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = (x, st) => rt.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(x) });
    const body = () => JSON.parse(req.postData() || '[]');
    if (/\/customers\b/.test(url)) return J(CUSTS);
    if (/\/price_master\b/.test(url)) return J([{ species: 'イノシシ', part_name: '枝肉', grade: '並', price_standard: 3000 }]);
    if (/\/orders\b/.test(url) && m === 'GET') {
      orderQueries.push(url);
      const g = url.match(/order_date=gte\.([\d-]+)/), l = url.match(/order_date=lte\.([\d-]+)/);
      return J(ORDERS.filter(o => (!g || o.order_date >= g[1]) && (!l || o.order_date <= l[1])));
    }
    if (/\/document_orders\b/.test(url)) {
      if (m === 'POST') { docOrders.push(...body()); return J([], 201); }
      return J([{ order_id: 'o5', document_id: 'd-old' }]);
    }
    if (/\/document_items\b/.test(url)) { if (m === 'POST') docItems.push(...body()); return J([], 201); }
    if (/\/documents\b/.test(url)) {
      if (m === 'POST') { const h = body()[0]; const row = { id: 'd' + (docs.length + 1), ...h }; docs.push(row); return J([row], 201); }
      if (/doc_number=like/.test(url)) return J(docs.map(d => ({ doc_number: d.doc_number })));
      if (/id=in\.\(d-old\)/.test(url)) return J([{ id: 'd-old', status: '発行済', doc_type: '請求書' }]);
      return J([]);
    }
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));
  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(700);
  await page.evaluate(() => switchTab('invoice'));
  await page.waitForTimeout(150);

  const results = []; const ck = (n, c, g) => results.push([n, !!c, g == null ? '' : String(g)]);

  // 1〜4. 集計
  await page.evaluate(() => { document.getElementById('invBatchPeriod').value = 'lastMonth'; return invBatchSearch(); });
  await page.waitForTimeout(300);
  ck('先月（9/1〜9/30）の注文を取りに行く', orderQueries.some(q => /order_date=gte\.2026-09-01/.test(q) && /order_date=lte\.2026-09-30/.test(q)), orderQueries[0]);
  const groups = await page.evaluate(() => invBatchGroups.map(g => ({ name: g.cust.name, n: g.orders.length, codes: g.orders.map(o => o.order_code), total: g.total, use: g._use, warn: g.warn })));
  const G = n => groups.find(g => g.name === n) || {};
  ck('請求済みの注文は入れない（A食堂は2件）', G('A食堂').n === 2 && !G('A食堂').codes.includes('DIR-0910-BILLED'), JSON.stringify(G('A食堂')));
  ck('仲卸業者のタグがある注文は業者あて（Cビストロではなくノブレスオブリージュ）', G('ノブレスオブリージュ').n === 1 && !groups.some(g => g.name === 'Cビストロ'), JSON.stringify(groups.map(g => g.name)));
  ck('注文の備考に無くても、顧客の備考に「トレタテ」があればトレタテあてにまとめる', G('トレタテ').n === 1 && (G('トレタテ').codes || []).includes('DIR-1006-OTG') && !groups.some(g => g.name === 'OTG'), JSON.stringify(groups.map(g => g.name)));
  const resTxt = await page.$eval('#invBatchResult', el => el.innerText);
  ck('顧客につながっていない注文は赤字で知らせる', /顧客につながっていない注文が 1件/.test(resTxt) && /DIR-0912-NOCUST/.test(resTxt), resTxt.slice(0, 200));
  ck('BASEの注文（支払い済み）は対象外で、赤字の一覧にも出さない', !/BASE-XYZ/.test(resTxt) && /BASEの注文 1件は対象外/.test(resTxt), resTxt.slice(0, 200));
  ck('金額0の請求先は最初からチェックを外す', G('Z誤送').use === false && G('A食堂').use === true, JSON.stringify(G('Z誤送')));
  ck('住所未登録は注意を出す', (G('B商店').warn || []).includes('住所未登録'), JSON.stringify(G('B商店')));

  // 5. 明細（注文の金額から）
  const aLines = await page.evaluate(() => invBatchGroups.find(g => g.cust.name === 'A食堂').lines);
  const eda = aLines.find(l => /枝肉/.test(l.name));
  ck('明細は注文の金額（顧客別単価1,500円/kg）から作り、価格マスタ（3,000円）で引き直さない', eda && eda.qty === 10 && eda.price === Math.round(Math.round(15000 / 1.08) / 10), JSON.stringify(eda));
  ck('0円・0kgの依頼内容の行は載せない', !aLines.some(l => /キョン/.test(l.name)), JSON.stringify(aLines.map(l => l.name)));
  ck('送料は別行（10%・税抜そのまま）', aLines.some(l => /9\/3納品　送料（クール100）/.test(l.name) && l.price === 1300 && l.tax === 10), JSON.stringify(aLines));

  // 6〜8. まとめて発行
  await page.evaluate(() => {
    window.__opened = [];
    window.open = () => { const w = { closed: false, document: { _h: '', open() { this._h = ''; }, write(h) { this._h += h; }, close() {} }, close() { this.closed = true; } }; window.__opened.push(w); return w; };
    window.alert = m => { window.__alert = m; };
  });
  let confirmMsg = '';
  page.on('dialog', async d => { confirmMsg = d.message(); await d.accept(); });
  await page.evaluate(() => invBatchIssue()); await page.waitForTimeout(800);
  ck('確認画面に件数・合計・各請求先が出る', /請求書を 4件 まとめて発行/.test(confirmMsg) && /A食堂/.test(confirmMsg) && /B商店/.test(confirmMsg) && /ノブレスオブリージュ/.test(confirmMsg), confirmMsg.split('\n').slice(0, 2).join(' / '));
  ck('請求先ごとに書類1枚（チェックを外したZ誤送は出さない）', docs.length === 4 && !docs.some(d => d.partner_name === 'Z誤送'), JSON.stringify(docs.map(d => d.partner_name)));
  const nums = docs.map(d => d.doc_number).sort();
  ck('番号は連番（INV-202610-001〜004）', JSON.stringify(nums) === JSON.stringify(['INV-202610-001', 'INV-202610-002', 'INV-202610-003', 'INV-202610-004']), JSON.stringify(nums));
  const dA = docs.find(d => d.partner_name === 'A食堂');
  ck('A食堂の書類に注文2件を紐付け（二重請求防止）', docOrders.filter(x => x.document_id === dA.id).map(x => x.order_id).sort().join(',') === 'o1,o2', JSON.stringify(docOrders));
  ck('件名は「2026年9月分」、明細も保存', dA.subject === '2026年9月分' && docItems.some(x => x.document_id === dA.id && /枝肉/.test(x.name)), dA.subject);
  const dW = docs.find(d => d.partner_name === 'ノブレスオブリージュ');
  ck('業者あての請求書には【出荷内訳】が入る', dW && /【出荷内訳】/.test(dW.memo || '') && /Cビストロ/.test(dW.memo || ''), dW && dW.memo);
  const html = await page.evaluate(() => (window.__opened[0] || {}).document?._h || '');
  const pages = (html.match(/class="pb"/g) || []).length;
  ck('印刷画面は1つで、1請求先1ページ（改ページ）', (await page.evaluate(() => window.__opened.length)) === 1 && pages === 4 && /page-break-after:always/.test(html), pages);
  ck('印刷画面に各社の宛名と番号が入る', ['A食堂', 'B商店', 'ノブレスオブリージュ', 'INV-202610-001', 'INV-202610-003'].every(s => html.includes(s)), '');
  // 実際にA4でPDFにして、ページ数が請求先の数と同じか測る（1請求先が2ページにはみ出さないか）
  const pp = await ctx.newPage();
  await pp.setContent(html, { waitUntil: 'load' });
  const pdf = (await pp.pdf({ format: 'A4', preferCSSPageSize: true })).toString('latin1');
  const pdfPages = (pdf.match(/\/Type\s*\/Page[^s]/g) || []).length;
  ck('A4のPDFにすると4ページ（1請求先1ページ）', pdfPages === 4, pdfPages);
  ck('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
