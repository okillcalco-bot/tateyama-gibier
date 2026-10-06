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

const invOthers = (h, me) => !['A食堂', 'B商店', 'トレタテ', 'ノブレスオブリージュ'].filter(n => n !== me).some(n => h.includes('<div class="name">' + n));
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ timezoneId: 'Asia/Tokyo', acceptDownloads: true });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date('2026-10-06T03:00:00Z'));
  const errors = []; page.on('pageerror', e => errors.push(e.message));

  const CUSTS = [
    { id: 'c-a', code: 'C1', name: 'A食堂', price_rank: 'standard', address: '〒123-4567 東京都A区1-1', building: 'Aビル2F', honorific: '御中', is_active: true, billing_method: 'paper' },
    { id: 'c-b', code: 'C2', name: 'B商店', price_rank: 'standard', address: null, honorific: '様', is_active: true, billing_method: 'paper' },
    { id: 'c-k', code: 'C12', name: 'K現金', price_rank: 'standard', address: '館山市', is_active: true, billing_method: 'cash' },
    { id: 'c-c', code: 'C3', name: 'Cビストロ', price_rank: 'standard', address: '東京都C区', is_active: true },
    { id: 'c-w', code: 'C0731', name: 'ノブレスオブリージュ', price_rank: 'standard', address: '東京都W区', honorific: '御中', is_active: true },
    { id: 'c-z', code: 'C9', name: 'Z誤送', price_rank: 'standard', address: '千葉県', is_active: true },
    { id: 'c-u', code: 'C0532', name: '植山', price_rank: 'standard', address: '東京都港区', notes: '依頼主コード:tgc\nエフユーアイジャパン', is_active: true },
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
    { id: 'o10', order_code: 'DIR-0918-NOPRICE', customer_id: 'c-b', customer_name: 'B商店', order_date: '2026-09-18', delivery_date: '2026-09-18', status: '発送済', memo: null,
      order_items: [it('ネック', 1.5, 0, { id: 'it-np', unit_price: null, subtotal: null, amount: null })], shipments: [] },
    { id: 'o11', order_code: 'DIR-0919-CASH', customer_id: 'c-k', customer_name: 'K現金', order_date: '2026-09-19', delivery_date: '2026-09-19', status: '発送済', memo: null,
      order_items: [it('ミンチ用', 2, 1600)], shipments: [] },
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
  const patches = [];
  await page.route('**/rest/v1/**', async rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    if (m === 'PATCH') { patches.push({ url, body: JSON.parse(req.postData() || '{}') }); }
    if (m === 'GET' && /\/order_items\?order_id=eq\.o10/.test(url)) return rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ subtotal: 1800 }]) });
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
      return J([{ order_id: 'o5', document_id: 'd-old' }, ...docOrders]);
    }
    if (/\/document_items\b/.test(url)) { if (m === 'POST') docItems.push(...body()); return J([], 201); }
    if (/\/documents\b/.test(url)) {
      if (m === 'POST') { const h = body()[0]; const row = { id: 'd' + (docs.length + 1), ...h }; docs.push(row); return J([row], 201); }
      if (/doc_number=like/.test(url)) return J(docs.map(d => ({ doc_number: d.doc_number })));
      const ids = (url.match(/id=in\.\(([^)]*)\)/) || [])[1];
      if (ids) return J([{ id: 'd-old', status: '発行済', doc_type: '請求書', doc_number: 'INV-202609-099', customer_id: 'c-a', total_amount: 4104, snapshot: null }, ...docs].filter(d => ids.split(',').includes(d.id)));
      return J([]);
    }
    return J([]);
  });
  // 個別PDF（ZIP）用のライブラリ（本番は cdn.jsdelivr.net から読み込む）。テストではローカルの同じ版を返す
  const LIBDIR = process.env.INV_PDF_LIBDIR || path.join(__dirname, '../../node_modules');
  const libs = { 'html2canvas@1.4.1': 'html2canvas/dist/html2canvas.min.js', 'jspdf@2.5.1': 'jspdf/dist/jspdf.umd.min.js', 'jszip@3.10.1': 'jszip/dist/jszip.min.js' };
  await page.route('https://cdn.jsdelivr.net/npm/**', rt => {
    const k = Object.keys(libs).find(x => rt.request().url().includes(x));
    try { return rt.fulfill({ contentType: 'application/javascript', body: require('fs').readFileSync(path.join(LIBDIR, libs[k])) }); }
    catch (e) { return rt.fulfill({ status: 404, body: 'not found' }); }
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
  ck('運営会社あて（植山→エフユーアイジャパン）も顧客の備考で請求先にまとめる', await page.evaluate(() => wholesalerTagOf({ memo: null, customer_id: 'c-u' })) === 'エフユーアイジャパン', '');
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

  // 10. 請求書の送り方
  ck('請求なし（現金）の請求先は最初からチェックを外す', G('K現金').use === false && G('K現金').total > 0, JSON.stringify(G('K現金')));
  const methodTxt = await page.$eval('#invBatchList', el => el.innerText);
  ck('一覧に送り方の札が出る（紙で郵送・請求なし・未設定）', /📮 紙で郵送/.test(methodTxt) && /💴 請求なし（現金）/.test(methodTxt) && /送り方未設定/.test(methodTxt), '');
  // 宛名ラベル（紙で郵送・チェック済みの請求先だけ）
  await page.evaluate(() => { window.__lbl = null; window.open = () => { const w = { document: { _h: '', open() {}, write(h) { this._h += h; }, close() {} }, close() {} }; window.__lbl = w; return w; }; window.prompt = () => '2';   /* 使いかけのシート: 2枚目から（1枚目は空き） */ window.alert = m => { window.__alert = m; }; });
  await page.evaluate(() => invBatchLabels());
  const lbl = await page.evaluate(() => window.__lbl ? window.__lbl.document._h : '');
  ck('宛名ラベルは「紙で郵送」の請求先だけ（A食堂・B商店。現金・未設定は出さない）', /A食堂　御中/.test(lbl) && /B商店　様/.test(lbl) && !/K現金/.test(lbl) && !/ノブレスオブリージュ/.test(lbl), '');
  ck('郵便番号と住所を分けて載せ、建物名も付ける', /〒123-4567/.test(lbl) && /東京都A区1-1 Aビル2F/.test(lbl), '');
  ck('住所の無い請求先は「住所未登録」と出して知らせる', /住所未登録/.test(lbl) && /B商店/.test(await page.evaluate(() => window.__alert || '')), '');
  // 実寸: KML-506（A4・70×33.9mm・3列×8段・上余白12.9mm）に合っているか測る
  const lp = await ctx.newPage();
  await lp.setContent(lbl.replace(/<script>[\s\S]*?<\/script>/, ''), { waitUntil: 'load' });
  const geo = await lp.evaluate(() => { const px = 96 / 25.4; const ls = [...document.querySelectorAll('.lbl')].map(e => e.getBoundingClientRect()); return { n: ls.length, top: +(ls[0].top / px).toFixed(1), w: +(ls[0].width / px).toFixed(1), h: +(ls[0].height / px).toFixed(1), x3: +(ls[2].left / px).toFixed(1), y2: +(ls[1].top / px).toFixed(1) }; });
  ck('ラベルの実寸がKML-506どおり（上12.9mm・幅70mm・高さ33.9mm・3列目の左端140mm）', geo.top === 12.9 && geo.w === 70 && geo.h === 33.9 && geo.x3 === 140, JSON.stringify(geo));
  const lpdf = (await lp.pdf({ preferCSSPageSize: true })).toString('latin1');
  ck('宛名ラベルはA4 1枚に収まる', (lpdf.match(/\/Type\s*\/Page[^s]/g) || []).length === 1, '');
  // 顧客マスタで送り方を選んで保存できる
  await page.evaluate(() => { openEditCustomer('c-c'); document.getElementById('cfBillingMethod').value = 'pdf'; return saveCustomer(); });
  await page.waitForTimeout(300);
  const pSave = patches.find(x => /customers\?id=eq\.c-c/.test(x.url));
  ck('顧客マスタで請求書の送り方を選んで保存できる', pSave && pSave.body.billing_method === 'pdf', JSON.stringify(pSave && pSave.body.billing_method));

  // 9. 注意を押すと入力できる
  ck('B商店に「単価未入力の明細あり」が出る', (G('B商店').warn || []).includes('単価未入力の明細あり'), JSON.stringify(G('B商店')));
  const bIdx = groups.findIndex(g => g.name === 'B商店');
  await page.evaluate(i => document.querySelectorAll('#invBatchList label')[i].querySelector('button.inv-fix-btn').click(), bIdx);
  await page.waitForTimeout(150);
  const custModal = await page.evaluate(() => ({ open: document.getElementById('custModal')?.classList.contains('show'), name: document.getElementById('cfName')?.value }));
  ck('「住所未登録」を押すと、その顧客の編集画面が開く（チェックは切り替わらない）', custModal.open && custModal.name === 'B商店' && (await page.evaluate(i => invBatchGroups[i]._use, bIdx)) === true, JSON.stringify(custModal));
  await page.evaluate(() => closeModal('custModal'));
  await page.evaluate(i => [...document.querySelectorAll('#invBatchList label')[i].querySelectorAll('button.inv-fix-btn')].find(b => /単価/.test(b.textContent)).click(), bIdx);
  await page.waitForTimeout(150);
  const fixTxt = await page.$eval('#invFixContent', el => el.innerText.replace(/\s+/g, ' '));
  ck('「単価未入力の明細あり」を押すと、その明細の単価入力が開く', /ネック/.test(fixTxt) && /DIR-0918-NOPRICE/.test(fixTxt) && await page.evaluate(() => document.getElementById('invFixModal').classList.contains('show')), fixTxt.slice(0, 160));
  await page.evaluate(() => { const el = document.querySelector('#invFixContent .inv-fix-price'); el.value = '1200'; el.dispatchEvent(new Event('input')); document.getElementById('invFixSave').click(); });
  await page.waitForTimeout(500);
  const pIt = patches.find(x => /order_items\?id=eq\.it-np/.test(x.url)), pOr = patches.find(x => /orders\?id=eq\.o10/.test(x.url));
  ck('保存すると単価・金額（1.5kg×1,200円=1,800円）と注文の合計を書き、集計し直す', pIt && pIt.body.unit_price === 1200 && pIt.body.subtotal === 1800 && pOr && pOr.body.total_amount === 1800 && !(await page.evaluate(() => document.getElementById('invFixModal').classList.contains('show'))), JSON.stringify([pIt && pIt.body, pOr && pOr.body]));
  await page.evaluate(() => document.querySelector('#invBatchResult button.inv-fix-btn').click());
  await page.waitForTimeout(150);
  await page.evaluate(() => { document.getElementById('invFixCust').value = 'C1 A食堂'; document.getElementById('invFixCustSave').click(); });
  await page.waitForTimeout(400);
  const pCu = patches.find(x => /orders\?id=eq\.o6/.test(x.url));
  ck('顧客につながっていない注文を押すと顧客を選べ、つなぐと注文に顧客を書く', pCu && pCu.body.customer_id === 'c-a', JSON.stringify(pCu && pCu.body));
  await page.waitForTimeout(300);

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
  // 11. 1社ずつPDF
  const issued = await page.$eval('#invBatchIssued', el => el.innerText.replace(/\s+/g, ' '));
  const nBtn = await page.$$eval('#invBatchIssued .inv-issued-pdf', bs => bs.length);
  ck('発行後に「発行した請求書」の一覧が出て、1社ずつ「📄 PDF」ボタンがある', /2026年9月分の発行済み請求書 4件/.test(issued) && nBtn === 4 && /INV-202610-001/.test(issued), issued.slice(0, 160));
  await page.evaluate(() => { window.__one = []; window.open = () => { const w = { document: { _h: '', open() {}, write(h) { this._h += h; }, close() {} }, close() {} }; window.__one.push(w); return w; }; });
  const firstName = await page.evaluate(() => invBatchIssued[0].p.name);
  await page.evaluate(() => document.querySelector('#invBatchIssued .inv-issued-pdf').click());
  const one = await page.evaluate(() => window.__one[0] ? window.__one[0].document._h : '');
  const sheetsInOne = (one.match(/<div class="sheet">/g) || []).length;
  const title = (one.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
  ck('「📄 PDF」で、その請求先1社だけの請求書が開く', sheetsInOne === 1 && one.includes(firstName) && invOthers(one, firstName), title);
  ck('PDFのファイル名は「請求書_発行日_宛名_番号」', new RegExp('^請求書_20261006_' + firstName + '_INV-202610-00[1-4]$').test(title), title);
  const op = await ctx.newPage(); await op.setContent(one, { waitUntil: 'load' });
  const onePdf = (await op.pdf({ format: 'A4', preferCSSPageSize: true })).toString('latin1');
  ck('1社分のPDFはA4 1ページ', (onePdf.match(/\/Type\s*\/Page[^s]/g) || []).length === 1, '');
  // 13. 集計し直しても、発行済みの請求書は何度でもPDF・印刷できる（発行し直さない）
  await page.evaluate(() => invBatchSearch()); await page.waitForTimeout(400);
  const again = await page.$eval('#invBatchIssued', el => el.innerText.replace(/\s+/g, ' '));
  const regroups = await page.evaluate(() => invBatchGroups.map(g => g.cust.name));
  ck('集計し直しても「発行済み請求書」の一覧が残り、PDFボタンが押せる', /2026年9月分の発行済み請求書 4件/.test(again) && (await page.$$eval('#invBatchIssued .inv-issued-pdf', b => b.length)) === 4, again.slice(0, 120));
  ck('発行済みの注文は選ぶ一覧には出ない（二重に発行しない）', !regroups.includes('A食堂') && !regroups.includes('ノブレスオブリージュ'), JSON.stringify(regroups));
  ck('発行し直さない（書類は4枚のまま）', docs.length === 4, docs.length);

  // 12. 全員分を個別PDFで（ZIP）
  const hasLibs = require('fs').existsSync(path.join(LIBDIR, 'jszip/dist/jszip.min.js'));
  if (hasLibs) {
    await page.evaluate(() => { const c = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) window.__dlName = this.download; return c.call(this); }; });
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.evaluate(() => invBatchIssuedZip())]);
    const dlName = await page.evaluate(() => window.__dlName || '');
    const buf = require('fs').readFileSync(await dl.path());
    const JSZip = require(path.join(LIBDIR, 'jszip'));
    const z = await JSZip.loadAsync(buf);
    const names = Object.keys(z.files);
    const pdfs = await Promise.all(names.map(n => z.files[n].async('nodebuffer')));
    if (process.env.INV_PDF_DUMP) pdfs.forEach((b, k) => require('fs').writeFileSync(path.join(process.env.INV_PDF_DUMP, `inv${k}.pdf`), b));
    ck('「全員分を個別PDFで」で、1社1ファイルのPDFがZIPで落ちる（4件）', /^請求書_2026年9月分_個別PDF_4件\.zip$/.test(dlName) && names.length === 4 && names.every(n => /^請求書_20261006_.+_INV-202610-00[1-4]\.pdf$/.test(n)), JSON.stringify([dlName, names]));
    ck('各PDFは1ページで、中身（請求書の画像）が入っている', pdfs.every(b => b.slice(0, 4).toString() === '%PDF' && (b.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length === 1 && b.length > 30000), JSON.stringify(pdfs.map(b => b.length)));
    ck('作成後に完了を知らせる', /4件の個別PDFをZIPでダウンロードしました/.test(await page.$eval('#invIssuedZipMsg', el => el.textContent)), '');
  } else {
    ck('個別PDF（ZIP）のテスト用ライブラリが無い（INV_PDF_LIBDIR を指定して実行）', false, LIBDIR);
  }
  ck('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
