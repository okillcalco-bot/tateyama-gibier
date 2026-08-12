const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/order-admin.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9060);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));

  const IMP_ID = 'imp-1';
  const PRODUCTS = [
    { id: 'p1', species: 'イノシシ', display_name: 'ロース', grade_label: '上' },
    { id: 'p2', species: 'イノシシ', display_name: 'モモ', grade_label: '並' },
  ];
  // detail: 1st call = 未確定（顧客候補あり・矛盾・商品未対応・差額）, later calls = 全確定（反映可）
  function detail(ready) {
    return {
      import: { id: IMP_ID, file_name: '2026年8月_A商店.xlsx', source: 'local',
        status: ready ? '確認済' : '顧客未照合', finalized_by: null },
      documents: [{
        id: 'doc-1', page_from: 1, invoice_number: 'INV-100',
        invoice_date: '2026-08-01', delivery_date: null,
        raw_customer_name: 'エー商店', raw_phone: '0470-11-2222', raw_postal: null,
        total_amount: 20575, lines_amount_sum: 20575, amount_diff: 0,
        match_status: ready ? '確定' : '候補あり',
        match_method: ready ? 'manual' : 'conflict', match_confidence: ready ? 1.0 : 0.5,
        match_conflict: !ready, conflict_detail: ready ? null : '照合情報が矛盾しています（顧客コード: エー商店 ／ 電話番号: ビー商店）。人が確認して確定してください',
        customer_id: ready ? 'cust-A' : 'cust-A',
        customer: { id: 'cust-A', code: 'A001', name: 'エー商店' },
        amount_diff_reason: null, amount_diff_kind: null,
        lines: [
          { id: 'l1', line_no: 1, raw_item_name: '猪ロース上', raw_species: 'イノシシ', raw_part: 'ロース', raw_grade: '上',
            weight_kg: 2.5, unit_price: 4750, amount: 11875, source_ref: 'p.1 表1 行1', confidence: 0.9,
            match_status: ready ? '確定' : '未照合', product_id: ready ? 'p1' : null,
            product: ready ? PRODUCTS[0] : null },
          { id: 'l2', line_no: 2, raw_item_name: '猪モモ', raw_species: 'イノシシ', raw_part: 'モモ', raw_grade: '並',
            weight_kg: 3, unit_price: 2900, amount: 8700, source_ref: 'p.1 表1 行2', confidence: 0.85,
            match_status: ready ? '確定' : '未照合', product_id: ready ? 'p2' : null,
            product: ready ? PRODUCTS[1] : null },
        ],
      }],
      audit: ready ? [{ action: 'customer_confirm', actor: 'テスト職員', detail: '顧客を確定: A001 エー商店', created_at: '2026-08-12T10:00:00Z' }] : [],
    };
  }

  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  await ctx.addInitScript(() => { localStorage.setItem('tg_staff_key', 'TESTKEY'); localStorage.setItem('tg_operator', 'テスト職員'); });
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  let finalizeCalled = 0, setCustomerCalled = 0, mapProductCalled = 0, detailCalls = 0;

  await p.route('**/rest/v1/**', async route => {
    const url = route.request().url();
    const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    const m = url.match(/\/rpc\/([a-z_]+)/);
    const fn = m ? m[1] : '';
    let body = {}; try { body = route.request().postDataJSON() || {}; } catch (e) {}
    if (fn === 'staff_key_ok') return j(true);
    if (fn === 'admin_invoice_products') return j(PRODUCTS);
    if (fn === 'admin_invoice_list') return j([{ id: IMP_ID, file_name: '2026年8月_A商店.xlsx', source: 'local',
      status: (setCustomerCalled && mapProductCalled) ? '確認済' : '顧客未照合', documents: 1, lines: 2,
      unmatched_customers: (setCustomerCalled ? 0 : 1), unmatched_products: (mapProductCalled ? 0 : 2) }]);
    if (fn === 'admin_invoice_detail') { detailCalls++; return j(detail(setCustomerCalled > 0 && mapProductCalled > 0)); }
    if (fn === 'admin_invoice_set_customer') { setCustomerCalled++; return j({ ok: true, status: '商品未照合' }); }
    if (fn === 'admin_invoice_map_product') { mapProductCalled++; return j({ ok: true, status: '確認済' }); }
    if (fn === 'admin_invoice_customer_search') {
      // サーバ側の絞り込みを模す: 検索語に一致する顧客だけ返す（無関係は返さない）
      const q = String(body.p_q || '');
      const all = [
        { id: 'cust-B', code: 'B001', name: 'ビー商店', kana: 'ビーショウテン', phone_tail: '2222' },
        { id: 'cust-Z', code: 'A000', name: 'ゼータ無関係商店', kana: 'ゼータムカンケイ', phone_tail: '9999' },
      ];
      const digits = q.replace(/\D/g, '');
      const hit = all.filter(c => c.name.includes(q) || c.kana.includes(q) || c.code.includes(q)
        || (digits.length >= 4 && String(c.phone_tail).includes(digits)));
      return j(hit);
    }
    if (fn === 'admin_invoice_finalize') { finalizeCalled++; return j({ ok: true, already: false, facts: 2, documents: 1 }); }
    if (fn === 'admin_invoice_run_matching') return j({ ok: true, auto: 0, candidates: 1, unmatched: 0, conflicts: 1 });
    return j([]);
  });
  await p.on('dialog', d => d.accept());

  await p.goto('http://localhost:9060/order-admin.html'); await p.waitForTimeout(700);

  // ① タブが出る・クリックで一覧
  ck('①請求書取込タブがある', await p.locator('.tab[data-tab="invoiceimport"]').count() === 1);
  await p.locator('.tab[data-tab="invoiceimport"]').click(); await p.waitForTimeout(500);
  ck('①状態フィルタが8種出る', await p.locator('#invStatusFilter .inv-sb').count() === 8);
  ck('①取込カードが出る', (await p.locator('#invImportList .inv-card').count()) === 1);
  ck('①ファイル名が出る', (await p.locator('#invImportList').innerText()).includes('A商店'));

  // ② 390pxで横スクロールなし
  const sw = await p.evaluate(() => document.documentElement.scrollWidth);
  ck('②横スクロールなし(390px)', sw <= 390, 'scrollWidth=' + sw);

  // ③ 開く → 詳細全画面
  await p.locator('#invImportList .btn-gold', { hasText: '開く' }).click(); await p.waitForTimeout(500);
  ck('③詳細が全画面で開く', await p.locator('#invDetail').evaluate(el => el.classList.contains('show')));
  const dt = await p.locator('#invDetailBody').innerText();
  ck('③伝票番号が出る', dt.includes('INV-100'));
  ck('③矛盾警告が出る', dt.includes('矛盾'), dt.slice(0, 80));
  ck('③抽出元・確度が出る', dt.includes('抽出元') && dt.includes('%'));
  ck('③金額検算(明細合計/請求書合計/差額)が出る', dt.includes('明細合計') && dt.includes('請求書合計') && dt.includes('差額'));
  ck('③商品selectが明細ごとに出る', (await p.locator('#invDetailBody select[id^="invprod-"]').count()) === 2);

  // ④ 下部固定バー: 反映ボタンは未確認だと無効
  const finBtn = p.locator('#invDetailBottom .btn-gold');
  ck('④反映ボタンが未確認時は無効', await finBtn.evaluate(el => el.disabled), '');
  ck('④下部バーに未対応件数', (await p.locator('#invDetailBottom').innerText()).includes('要対応'));

  // ⑤ タップ領域44px以上（詳細内のボタン）
  const smalls = await p.locator('#invDetailBody .inv-btn').evaluateAll(els => els.filter(e => e.getBoundingClientRect().height < 44).length);
  ck('⑤詳細ボタンのタップ領域44px以上', smalls === 0, smalls + '個が44px未満');

  // ⑥ 顧客ピッカーで確定
  await p.locator('#invDetailBody .inv-btn', { hasText: '顧客を選んで確定' }).first().click(); await p.waitForTimeout(300);
  ck('⑥顧客ピッカーが開く', await p.locator('#invCustPick').evaluate(el => el.classList.contains('show')));
  await p.locator('#invCustQ').fill('ビー'); await p.waitForTimeout(400);
  const results = await p.locator('#invCustResults').innerText();
  ck('⑥検索は該当顧客(ビー商店)を含む', results.includes('ビー商店'));
  ck('⑥検索は無関係顧客(ゼータ)を含まない', !results.includes('ゼータ'), results.replace(/\n/g, ' '));
  ck('⑥検索結果は1件', (await p.locator('#invCustResults .invpick-row').count()) === 1);
  await p.locator('#invCustResults .invpick-row').first().click(); await p.waitForTimeout(500);
  ck('⑥set_customerが呼ばれた', setCustomerCalled === 1);

  // ⑥b 担当者名が無いと状態変更しない（修正4）
  await p.evaluate(() => { localStorage.removeItem('tg_operator'); });
  await p.evaluate(() => { window.prompt = () => ''; });   // 担当者名の入力をキャンセル
  const beforeMap = mapProductCalled;
  await p.locator('.inv-line .inv-btn', { hasText: 'この商品で確定' }).first().click(); await p.waitForTimeout(200);
  ck('⑥b担当者名なしではRPCを呼ばない', mapProductCalled === beforeMap, 'called=' + (mapProductCalled - beforeMap));
  await p.evaluate(() => { localStorage.setItem('tg_operator', 'テスト職員'); });

  // ⑦ 商品を対応づけ
  await p.locator('#invprod-l1').selectOption('p1'); await p.waitForTimeout(100);
  await p.locator('.inv-line .inv-btn', { hasText: 'この商品で確定' }).first().click(); await p.waitForTimeout(500);
  ck('⑦map_productが呼ばれた', mapProductCalled === 1);

  // ⑧ 全確定後は反映可能→反映実行
  await p.waitForTimeout(300);
  const finBtn2 = p.locator('#invDetailBottom .btn-gold', { hasText: '購入実績へ反映' });
  ck('⑧全確定で反映ボタン有効', await finBtn2.evaluate(el => !el.disabled));
  await finBtn2.click(); await p.waitForTimeout(500);
  ck('⑧finalizeが呼ばれた', finalizeCalled === 1);

  ck('JSエラーなし', errs.length === 0, errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
