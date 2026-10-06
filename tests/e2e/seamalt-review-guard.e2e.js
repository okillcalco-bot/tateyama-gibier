// シーモルト取込（メール注文の連携）の「要確認」注文を、画面でも確認済・出荷に進めない（2026-10-02）
//
//   きっかけ
//     ChatGPT の dot「シーモルト」からメール注文を受注へ登録できるようにする（integrations/seamalt）。
//     温度帯の記載が無い・「フレッシュ」の意味が不明・枝肉の頭数注文などは「要確認の受注」として保存する。
//     ところが出荷画面の shipSelectOrder は、受注を選んだだけで「確認済」に PATCH する作りだった。
//     要確認の注文が、開いた・選んだだけで確認済・出荷可能にならないようにする（DB側のトリガーでも拒否する）。
//
//   ここで測ること
//     出荷画面（index.html）
//       1. 要確認の注文は赤いバッジ「要確認（シーモルト取込）」が出て、「この注文に割当」が押せない
//       2. shipSelectOrder を呼んでも orders への PATCH（確認済）を送らない
//       3. 取込でない普通の受注は、従来どおり選ぶと確認済に PATCH する（回帰なし）
//       4. 連携のDB側が未適用（関数が無い 404）の環境では何も変わらない
//     受発注管理（order-admin.html）
//       5. 一覧に「要確認（取込）」バッジ。状態の変更はキャンセルしか出ない
//       6. ?order=<注文番号> で注文詳細が開き、外部注文ID・原文数量（2本）・温度帯・出典・履歴が出る
//       7. 金額が未確定の明細・合計を ¥0 と表示しない
//       8. 外部本文の HTML はそのまま文字として出る（img 要素にならない）
//       9. 「確認した項目を保存」で、選んだ温度帯とスタッフキーを付けて order_link_confirm_review を呼ぶ
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const REVIEW_ID = '11111111-1111-4111-8111-111111111111';
const NORMAL_ID = '22222222-2222-4222-8222-222222222222';
const ITEM_ID = '33333333-3333-4333-8333-333333333333';
const ORDERS = [
  { id: REVIEW_ID, order_code: 'ORD-20261002-ABC123', customer_name: 'レストランA（架空）', customer_id: 'c1', status: '受注', channel: 'メール',
    delivery_date: null, total_amount: null, created_at: '2026-10-02T01:00:00Z',
    order_items: [{ id: ITEM_ID, order_id: REVIEW_ID, species: 'イノシシ', part_name: 'ロース', requested_kg: null, weight_kg: null, unit_price: null, amount: null, subtotal: null }] },
  { id: NORMAL_ID, order_code: 'ORD-NORMAL-1', customer_name: '普通の店（架空）', customer_id: 'c2', status: '受注', channel: '電話',
    delivery_date: '2026-10-05', total_amount: 3000, created_at: '2026-10-01T01:00:00Z',
    order_items: [{ id: 'i2', order_id: NORMAL_ID, species: 'イノシシ', part_name: 'モモ', weight_kg: 1, unit_price: 3000, subtotal: 3000 }] },
];
const DETAIL = {
  external_order_id: 'O-DEMO-001', channel: 'email_pdf', issuer_account: 'orders@restaurant-a.example', review_state: 'needs_review', revision: 1, link_kind: 'created',
  items: [{ order_item_id: ITEM_ID, line_no: 1, raw_text: '<img src=x onerror="window.__xss=1">猪ロース 2本 フレッシュ希望', product_text: '猪ロース', raw_qty_text: '2本', qty: 2, unit: '本',
            normalized_kg: null, temp_zone: 'fresh', temp_text: 'フレッシュ希望', wish_text: '用意でき次第', review_items: ['fresh_meaning_unconfirmed'], confirm_state: 'needs_review' }],
  sources: [{ provider: 'gmail', account: 'center@tateyama-gibier.example', filename: 'O-DEMO-001.pdf', pages: [1], received_at: '2026-10-01T00:12:00Z', link: 'https://mail.google.com/mail/u/0/#inbox/demo', role: 'order' }],
  history: [{ tool: 'order_import_commit', outcome: 'created', at: '2026-10-02T01:00:00Z', by: '沖（テスト）', user_request: '今週の注文を登録して' }],
};

async function run({ installed }) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); localStorage.setItem('tg_staff_key', 'test-staff-key'); } catch (e) {} });
  const log = { patches: [], rpcs: [] };
  await ctx.route('**/*', rt => {
    const req = rt.request(); const u = decodeURIComponent(req.url()); const m = req.method();
    if (u.startsWith('file:')) return rt.continue();
    const J = (x, status = 200) => rt.fulfill({ status, contentType: 'application/json', body: JSON.stringify(x) });
    if (/jsdelivr|cdn/.test(u)) return rt.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    const rpc = /\/rest\/v1\/rpc\/([a-z_]+)/.exec(u);
    if (rpc) {
      log.rpcs.push({ fn: rpc[1], body: req.postData(), staffKey: req.headers()['x-staff-key'] || null });
      if (/^order_link_/.test(rpc[1]) && !installed) return J({ code: 'PGRST202', message: 'Could not find the function' }, 404);
      if (rpc[1] === 'order_link_review_states') return J([{ order_id: REVIEW_ID, review_state: 'needs_review', external_order_id: 'O-DEMO-001', unresolved: ['fresh_meaning_unconfirmed'] }]);
      if (rpc[1] === 'order_link_order_detail') return J(DETAIL);
      if (rpc[1] === 'order_link_confirm_review') return J({ review_state: 'confirmed', revision: 2, remaining: 0 });
      return J(null);
    }
    if (m === 'PATCH' && /\/rest\/v1\/orders/.test(u)) { log.patches.push(u); return J([]); }
    if (/\/rest\/v1\/orders\?/.test(u) && /order_items/.test(u)) return J(ORDERS);
    if (/\/rest\/v1\/orders\?/.test(u) && /status=in\.\(受注,確認済\)/.test(u)) return J(ORDERS.map(({ order_items, ...o }) => o));
    if (/\/rest\/v1\/order_items\?/.test(u)) { const id = /order_id=eq\.([0-9a-f-]+)/.exec(u)?.[1]; return J((ORDERS.find(o => o.id === id) || {}).order_items || []); }
    return J([]);
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  return { browser, ctx, page, log, errors, dialogs };
}

(async () => {
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

  // ── 出荷画面（index.html）──
  {
    const { browser, page, log, errors } = await run({ installed: true });
    await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
    await page.waitForTimeout(700);
    await page.evaluate(() => loadShipping());
    await page.waitForTimeout(800);
    const card = await page.$eval(`#order-${REVIEW_ID}`, el => el.textContent);
    T('出荷画面: 要確認の注文に赤いバッジ', /要確認（シーモルト取込）/.test(card), card.slice(0, 120));
    T('出荷画面: 要確認の注文は「この注文に割当」が押せない', await page.$eval(`#order-${REVIEW_ID} button[onclick^="shipSelectOrder"]`, b => b.disabled), '');
    await page.evaluate(id => shipSelectOrder(id), REVIEW_ID);
    await page.waitForTimeout(300);
    T('出荷画面: 要確認の注文を選んでも確認済への PATCH を送らない', log.patches.length === 0, log.patches.join(' '));
    T('出荷画面: 要確認なので割当先にならない', (await page.evaluate(() => shipSelectedOrderId)) !== REVIEW_ID, '');
    await page.evaluate(id => shipSelectOrder(id), NORMAL_ID);
    await page.waitForTimeout(300);
    T('出荷画面: 普通の受注は従来どおり選ぶと確認済に PATCH（回帰なし）', log.patches.length === 1 && log.patches[0].includes(NORMAL_ID), log.patches.join(' '));
    T('出荷画面: pageerror なし', errors.length === 0, errors.join(' / '));
    await browser.close();
  }
  {
    const { browser, page, log, errors } = await run({ installed: false });
    await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
    await page.waitForTimeout(700);
    await page.evaluate(() => loadShipping());
    await page.waitForTimeout(800);
    const card = await page.$eval(`#order-${REVIEW_ID}`, el => el.textContent);
    T('連携のDB側が未適用（関数なし）: バッジは出ず従来どおり・エラーも出さない', !/要確認（シーモルト/.test(card) && errors.length === 0
      && !(await page.evaluate(() => document.body.innerText)).includes('読み込めませんでした'), '');
    await browser.close();
  }

  // ── 受発注管理（order-admin.html）──
  {
    const { browser, page, log, errors, dialogs } = await run({ installed: true });
    await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html') + '?order=ORD-20261002-ABC123');
    await page.waitForTimeout(1200);
    const modal = await page.$eval('#odContent', el => el.innerText).catch(() => '');
    T('?order=<注文番号> で注文詳細が開く', /ORD-20261002-ABC123/.test(await page.$eval('#odTitle', el => el.textContent)), '');
    T('詳細: 外部注文ID・原文数量（2本）・温度帯・希望条件・出典・履歴', /O-DEMO-001/.test(modal) && /2本/.test(modal) && /フレッシュ/.test(modal)
      && /用意でき次第/.test(modal) && /O-DEMO-001\.pdf/.test(modal) && /沖（テスト）/.test(modal), modal.slice(0, 300));
    T('詳細: 金額未確定を ¥0 と出さない', /未確定/.test(modal) && !/合計: ¥0/.test(modal), (modal.match(/合計[^\n]*/) || [''])[0]);
    T('詳細: 要確認のうちは「確認済にする」ボタンを出さない', !(await page.$$eval('#odContent button', bs => bs.some(b => /確認済にする/.test(b.textContent)))), '');
    T('詳細: 外部本文の HTML は文字として出る（img 要素にならない・実行されない）', (await page.$$('#odLink img')).length === 0 && /<img src=x/.test(modal)
      && !(await page.evaluate(() => window.__xss)), '');
    const detailCall = log.rpcs.find(r => r.fn === 'order_link_order_detail');
    T('詳細の取込欄はスタッフキーのヘッダ付きで読む', detailCall && detailCall.staffKey === 'test-staff-key', JSON.stringify(detailCall));
    await page.selectOption(`#odLink .ol-tz[data-item="${ITEM_ID}"]`, 'chilled');
    await page.check(`#odLink .ol-ok[data-item="${ITEM_ID}"]`);
    await page.fill('#olBy', '吉田（テスト）');
    await page.click('#odLink button:has-text("確認した項目を保存")');
    await page.waitForTimeout(600);
    const conf = log.rpcs.find(r => r.fn === 'order_link_confirm_review');
    const body = conf ? JSON.parse(conf.body) : {};
    T('確認: 選んだ温度帯・担当者・版をスタッフキー付きで送る', conf && conf.staffKey === 'test-staff-key' && body.p_by === '吉田（テスト）' && body.p_expected_revision === 1
      && body.p_resolutions[0].temp_zone === 'chilled' && body.p_resolutions[0].confirmed === true && body.p_order_id === REVIEW_ID, conf && conf.body);
    T('確認: 結果が画面に出る', dialogs.some(d => /すべて確認しました/.test(d)), dialogs.join(' / '));
    await page.evaluate(() => { closeModal('orderDetailModal'); switchTab('orders'); });
    await page.waitForTimeout(200);
    const row = await page.$$eval('#ordersBody tr', trs => trs.map(t => ({ code: t.cells[0].textContent, status: t.cells[5].textContent, opts: [...t.querySelectorAll('select option')].map(o => o.value).filter(Boolean) })));
    const r1 = row.find(r => r.code === 'ORD-20261002-ABC123'), r2 = row.find(r => r.code === 'ORD-NORMAL-1');
    T('一覧: 要確認の注文に「要確認（取込）」バッジ', r1 && /要確認（取込）/.test(r1.status), r1 && r1.status);
    T('一覧: 要確認の注文の状態変更はキャンセルだけ', r1 && JSON.stringify(r1.opts) === '["キャンセル"]', r1 && JSON.stringify(r1.opts));
    T('一覧: 普通の注文は従来どおり全ての状態を選べる', r2 && r2.opts.length === 5 && !/取込/.test(r2.status), r2 && JSON.stringify(r2.opts));
    T('受発注管理: pageerror なし', errors.length === 0, errors.join(' / '));
    await browser.close();
  }

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (!ok && got ? '  [' + got.slice(0, 300) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
