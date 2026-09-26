// 請求書作成タブ（注文から取り込む）: 仲卸業者経由の顧客を検索して取り込んでも、
// 宛名が実店舗のままになっていた事故の再発防止（2026-09-26）
//
//   きっかけ
//     ルリアン宛の注文（8/20発送・キョン枝肉6.05kg／イノシシ ロース1.82kg／送料）を
//     この「請求書作成」タブから取り込んで発行したところ、請求書の宛名が「ルリアン様」の
//     まま発行されてしまい、備考（出荷内訳）も一切書かれていなかった。
//     このタブは「請求先の顧客を選んでから、その顧客の注文を検索する」作り（invPullSearch
//     はinvCustomerIdが空だと動かない）のため、注文の検索に使った実店舗の名前が
//     そのまま宛名欄に残ってしまい、仲卸業者（トレタテ・ノブレスオブリージュ）への
//     差し替えを毎回手でやらない限り、必ずこの事故が起きる構造だった。
//     「書類発行」タブ（generateDoc）には同じ趣旨の自動判定を先に入れていたが、
//     この「請求書作成」タブ（invPullApply）には無かった。
//
//   ここで測ること
//     1. ルリアン（備考にトレタテタグ付き）の注文を検索・取り込むと、宛名欄が
//        自動でトレタテに差し替わる（顧客ID・入力欄・住所・敬称すべて）
//     2. 備考欄に「【出荷内訳】8/20 ルリアン ...」が自動で入る
//     3. 仲卸業者タグの無い普通の顧客（にくひろ）は、従来どおり宛名も備考も変わらない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));

  const CUST_LURIAN = { id: 'cust-lurian', code: 'C0839', name: 'ルリアン', address: '東京都港区西麻布2-21-7', is_active: true };
  const CUST_NIKUHIRO = { id: 'cust-nikuhiro', code: 'C0591', name: 'にくひろ', address: '千葉県某市', is_active: true };
  const CUST_TORETATE = { id: 'cust-toretate', code: 'C0832', name: 'トレタテ', address: '東京都港区芝5-19-6', is_active: true };

  const ORDER_LURIAN = {
    id: 'ord-lurian', customer_id: CUST_LURIAN.id, customer_name: 'ルリアン', order_code: 'DIR-20260820-151334',
    order_date: '2026-08-20', delivery_date: '2026-08-20', status: '発送済', total_amount: 25066, memo: 'トレタテ',
    order_items: [
      { id: 'ia', inventory_id: 'inv-a', species: 'キョン', part_name: '枝肉（全体）', weight_kg: 6.05, weight: 6.05, unit_price: 3000, amount: 18150, subtotal: 18150, grade_snapshot: '並' },
      { id: 'ib', inventory_id: 'inv-b', species: 'イノシシ', part_name: 'ロース', weight_kg: 1.82, weight: 1.82, unit_price: 3800, amount: 6916, subtotal: 6916, grade_snapshot: '並' },
    ],
    shipments: [{ freight: 1914, size_code: 120, is_cool: true }],
  };
  const ORDER_NIKUHIRO = {
    id: 'ord-nikuhiro', customer_id: CUST_NIKUHIRO.id, customer_name: 'にくひろ', order_code: 'DIR-20260901-000001',
    order_date: '2026-09-01', delivery_date: '2026-09-01', status: '発送済', total_amount: 10000, memo: null,
    order_items: [
      { id: 'ic', inventory_id: 'inv-c', species: 'イノシシ', part_name: 'モモ', weight_kg: 4, weight: 4, unit_price: 2500, amount: 10000, subtotal: 10000, grade_snapshot: '並' },
    ],
  };

  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = (x) => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m !== 'GET') return J([]);
    if (/\/customers\b/.test(url)) return J([CUST_LURIAN, CUST_NIKUHIRO, CUST_TORETATE]);
    if (/\/price_master\b/.test(url)) return J([]);
    if (/\/inventory\b/.test(url)) return J([]);
    if (/\/document_orders\b/.test(url)) return J([]);
    if (/\/documents\b/.test(url)) return J([]);
    if (/\/orders\b/.test(url) && /order_items/.test(url)) {
      const custMatch = url.match(/customer_id=eq\.([^&]+)/);
      const cid = custMatch && decodeURIComponent(custMatch[1]);
      if (cid === CUST_LURIAN.id) return J([ORDER_LURIAN]);
      if (cid === CUST_NIKUHIRO.id) return J([ORDER_NIKUHIRO]);
      return J([]);
    }
    if (/\/orders\b/.test(url)) return J([]);
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));

  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(600);
  await page.evaluate(() => switchTab('invoice'));
  await page.waitForTimeout(100);

  const results = []; const ck = (n, c, g) => results.push([n, c, g]);

  // ── 1) ルリアン（トレタテ経由）の注文を検索・取り込む → 宛名がトレタテに自動で差し替わる ──
  await page.evaluate((cid) => {
    document.getElementById('invCustomerId').value = cid;
    document.getElementById('invName').value = 'ルリアン';
    document.getElementById('invAddress').value = '東京都港区西麻布2-21-7';
  }, CUST_LURIAN.id);
  await page.evaluate(() => { document.getElementById('invPullPeriod').value = 'all'; });
  await page.evaluate(() => invPullSearch());
  await page.waitForTimeout(200);
  await page.evaluate(() => invPullToggleAll(true));
  await page.evaluate(() => invPullApply());
  await page.waitForTimeout(200);

  const after1 = await page.evaluate(() => ({
    custId: document.getElementById('invCustomerId').value,
    name: document.getElementById('invName').value,
    address: document.getElementById('invAddress').value,
    memo: document.getElementById('invMemo').value,
    lines: invLines,
  }));
  ck('ルリアンの注文を検索・取り込むと宛名IDがトレタテになる', after1.custId === CUST_TORETATE.id, JSON.stringify(after1));
  ck('宛名欄（invName）もトレタテに差し替わる', after1.name === 'トレタテ', after1.name);
  ck('請求先住所もトレタテの住所に差し替わる', after1.address === CUST_TORETATE.address, after1.address);
  ck('備考に【出荷内訳】が自動で入る', after1.memo.includes('【出荷内訳】'), after1.memo);
  ck('備考に日付・顧客名・内容が入る', after1.memo.includes('8/20 ルリアン'), after1.memo);
  ck('明細自体は通常どおり取り込まれる（肉2行+送料1行）', after1.lines.length === 3, JSON.stringify(after1.lines));

  // ── 2) 普通の顧客（にくひろ・タグなし）: 宛名も備考も変わらない ──
  await page.evaluate(() => { invResetForm(); });
  await page.waitForTimeout(100);
  await page.evaluate((cid) => {
    document.getElementById('invCustomerId').value = cid;
    document.getElementById('invName').value = 'にくひろ';
    document.getElementById('invAddress').value = '千葉県某市';
  }, CUST_NIKUHIRO.id);
  await page.evaluate(() => { document.getElementById('invPullPeriod').value = 'all'; });
  await page.evaluate(() => invPullSearch());
  await page.waitForTimeout(200);
  await page.evaluate(() => invPullToggleAll(true));
  await page.evaluate(() => invPullApply());
  await page.waitForTimeout(200);

  const after2 = await page.evaluate(() => ({
    custId: document.getElementById('invCustomerId').value,
    name: document.getElementById('invName').value,
    memo: document.getElementById('invMemo').value,
  }));
  ck('タグ無しの顧客: 宛名IDは変わらない（にくひろ本人のまま）', after2.custId === CUST_NIKUHIRO.id, JSON.stringify(after2));
  ck('タグ無しの顧客: 宛名欄も変わらない', after2.name === 'にくひろ', after2.name);
  ck('タグ無しの顧客: 備考は空のまま（出荷内訳を書かない）', after2.memo === '', JSON.stringify(after2));

  ck('ページエラーなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 300) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
