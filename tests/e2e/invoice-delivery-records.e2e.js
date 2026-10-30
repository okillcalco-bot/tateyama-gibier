// 請求書作成: 取引先を選んだら、その取引先の納品記録がすぐ出る（2026-10-30 沖「エフユーアイだけじゃない。
// 新しくしてもらった請求書発行から出てこない。余計わかりづらくなってる」）
//
//   実測（本番・2026-10-30）
//     #404 で「注文から取り込む」を明細の中に畳み、期間の初期値は「今月」・請求済みは隠す、のままだった。
//     8〜10月に出荷のある顧客100件のうち45件で、取引先を選んで探しても何も出なかった
//     （43件は全部請求済みで隠れ、2件は先月以前の未請求）。さらに畳んだ欄を開いて「探す」を押さないと出なかった。
//
//   ここで測ること（架空データ）
//     1. 納品記録の欄は畳まず、取引先のすぐ下に常にある（取引先を選ぶ前は案内文）
//     2. 取引先を選ぶだけで（ボタンを押さずに）読み込む。打っている途中で何度も読まない
//     3. 初期は「すべての期間」・請求済みも表示。並びは 未請求（古い順）→ 請求済み（新しい順）
//        未請求は✓あり、請求済みは✓なし・灰色・「請求済 番号」
//     4. 「未請求をすべて選ぶ」は請求済みに✓を付けない
//     5. 取り込むと明細が入り、件名は納品の月から（9月と10月 → 2026年9月〜10月分）
//     6. 「請求済みも表示」を外すと隠れ、何件・どの請求書かは出る。期間を絞って何も無いときは「すべての期間」を案内
//     7. 取引先を続けて変えても、前の取引先の結果で上書きしない
//     8. 「明細に入れる」ボタンは一覧の上（下の固定の発行バーに隠れない）
//     9. 台帳に無い宛名にすると一覧を消して案内を出す。読込エラーは画面に出す（黙って空にしない）
//    10. スマホで横にはみ出さない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const CUSTOMERS = [
  { id: 'c1', code: 'C9001', name: 'テスト食堂', kana: 'てすとしょくどう', price_rank: 'standard', address: '東京都テスト区1-1', honorific: '様', is_active: true, search_aliases: [], notes: '' },
  { id: 'c2', code: 'C9002', name: 'サンプル商店', kana: 'さんぷるしょうてん', price_rank: 'standard', address: '千葉県テスト市2-2', honorific: '御中', is_active: true, search_aliases: [], notes: '' },
  { id: 'c3', code: 'C9003', name: 'エラー亭', kana: 'えらーてい', price_rank: 'standard', address: '千葉県テスト市3-3', honorific: '様', is_active: true, search_aliases: [], notes: '' },
];
const it = (p, kg, sub) => ({ species: 'イノシシ', part_name: p, weight_kg: kg, weight: kg, subtotal: sub, amount: sub, grade_snapshot: '並', inventory_id: null });
const ord = (id, cid, name, date, total, part, freight) => ({ id, customer_id: cid, customer_name: name, order_code: 'DIR-' + date.replace(/-/g, '') + '-' + id, order_date: date, delivery_date: date, status: '発送済', total_amount: total, memo: null,
  order_items: [it(part, 2, total)], shipments: freight ? [{ freight, size_code: 80, is_cool: true }] : [] });
const ORDERS = [
  ord('o1', 'c1', 'テスト食堂', '2026-08-08', 7600, 'ロース', 1020),
  ord('o2', 'c1', 'テスト食堂', '2026-09-12', 6200, 'バラ', 1300),
  ord('o3', 'c1', 'テスト食堂', '2026-09-26', 5000, 'モモ', 1020),
  ord('o4', 'c1', 'テスト食堂', '2026-10-15', 3800, 'ロース', 0),
  ord('o5', 'c2', 'サンプル商店', '2026-09-05', 4400, 'カタ', 0),
];
const LINKS = [{ order_id: 'o1', document_id: 'd1' }, { order_id: 'o2', document_id: 'd2' }];
const DOCS = [{ id: 'd1', status: '発行済', doc_number: 'INV-TEST-0910' }, { id: 'd2', status: '発行済', doc_number: 'INV-TEST-1020' }];

async function openPage(browser, vw, vh) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date('2026-10-30T03:00:00Z'));
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  const st = { pulls: [], slowC1: 0 };
  await page.route('**/rest/v1/**', async route => {
    const u = new URL(route.request().url()); const t = u.pathname.split('/').pop();
    const J = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (route.request().method() !== 'GET') return J([]);
    if (t === 'customers') return J(CUSTOMERS);
    if (t === 'orders') {
      const cid = (u.searchParams.get('customer_id') || '').replace(/^eq\./, '');
      if (!cid) return J([]);   // 画面の読み込み時（全注文）は空でよい
      st.pulls.push(cid);
      if (cid === 'c3') return route.fulfill({ status: 500, body: 'boom' });
      if (cid === 'c1' && st.slowC1) await new Promise(r => setTimeout(r, st.slowC1));
      let rows = ORDERS.filter(o => o.customer_id === cid);
      for (const d of u.searchParams.getAll('order_date')) { const [op, v] = d.split('.'); rows = rows.filter(o => op === 'gte' ? o.order_date >= v : o.order_date <= v); }
      return J(rows);
    }
    if (t === 'document_orders') { const ids = (u.searchParams.get('order_id') || '').replace(/^in\.\(|\)$/g, '').split(','); return J(LINKS.filter(l => ids.includes(l.order_id))); }
    if (t === 'documents') { const ids = (u.searchParams.get('id') || '').replace(/^in\.\(|\)$/g, '').split(','); return J(DOCS.filter(d => ids.includes(d.id))); }
    return J([]);
  });
  await page.addInitScript(() => { try { localStorage.setItem('tg_staff_key', 'TESTKEY'); } catch (e) {} });
  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(600);
  await page.evaluate(() => switchTab('invoice'));
  await page.waitForTimeout(300);
  return { ctx, page, errors, st };
}
async function typeIn(page, v) { await page.fill('#invCustomerInput', v); await page.dispatchEvent('#invCustomerInput', 'input'); }
const rows = page => page.$$eval('#invPullList label', ls => ls.map(l => ({ text: l.innerText.replace(/\s+/g, ' '), checked: l.querySelector('input').checked, dim: l.style.opacity !== '' })));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const out = []; const ck = (n, c, e) => out.push([n, !!c, e == null ? '' : String(e)]);
  const { ctx, page, errors, st } = await openPage(browser, 1366, 900);

  // 1. 選ぶ前
  const pre = await page.evaluate(() => { const b = document.getElementById('invPullBox'); const r = b.getBoundingClientRect();
    return { tag: b.tagName, h: r.height, top: r.top, custTop: document.getElementById('invCustomerInput').getBoundingClientRect().top, dateTop: document.getElementById('invDate').getBoundingClientRect().top, msg: document.getElementById('invPullResult').textContent,
      period: document.getElementById('invPullPeriod').value, showBilled: document.getElementById('invPullShowBilled').checked }; });
  ck('納品記録の欄は畳まず、取引先の下・日付より上にあり、選ぶ前は案内文', pre.tag !== 'DETAILS' && pre.h > 0 && pre.top > pre.custTop && pre.top < pre.dateTop && /取引先を台帳から選ぶと/.test(pre.msg), JSON.stringify(pre));
  ck('初期は「すべての期間」・「請求済みも表示」', pre.period === 'all' && pre.showBilled, JSON.stringify(pre));

  // 2. 選ぶだけで読む・打っている途中で何度も読まない
  await page.fill('#invCustomerInput', 'テ'); await page.dispatchEvent('#invCustomerInput', 'input');
  await page.fill('#invCustomerInput', 'テスト'); await page.dispatchEvent('#invCustomerInput', 'input');
  await typeIn(page, 'C9001 テスト食堂');
  await page.waitForTimeout(800);
  ck('取引先を選ぶだけで納品記録を読む（ボタン不要）・途中の入力で何度も読まない（1回）', st.pulls.filter(c => c === 'c1').length === 1, JSON.stringify(st.pulls));

  // 3. 並び・✓・請求済みの表示
  const r1 = await rows(page);
  const msg1 = await page.textContent('#invPullResult');
  ck('並びは 未請求（古い順）→ 請求済み（新しい順）', r1.length === 4 && /2026-09-26/.test(r1[0].text) && /2026-10-15/.test(r1[1].text) && /2026-09-12/.test(r1[2].text) && /2026-08-08/.test(r1[3].text), JSON.stringify(r1.map(r => r.text.slice(0, 12))));
  ck('未請求は✓あり、請求済みは✓なし・灰色・「請求済 番号」', r1.length === 4 && r1[0].checked && r1[1].checked && !r1[2].checked && !r1[3].checked && r1[2].dim && r1[3].dim && /請求済 INV-TEST-1020/.test(r1[2].text) && /請求済 INV-TEST-0910/.test(r1[3].text), JSON.stringify(r1));
  ck('件数の表示: 未請求2件（合計8,800円）・請求済み2件（番号）', /未請求 2件/.test(msg1) && /8,800/.test(msg1) && /請求済み 2件/.test(msg1) && /INV-TEST-0910/.test(msg1) && /INV-TEST-1020/.test(msg1), msg1);

  // 8. ボタンの位置
  const pos = await page.evaluate(() => ({ act: document.getElementById('invPullActions').getBoundingClientRect().top, list: document.getElementById('invPullList').getBoundingClientRect().top, shown: getComputedStyle(document.getElementById('invPullActions')).display !== 'none' }));
  ck('「明細に入れる」ボタンは一覧の上（画面下の固定バーに隠れない）', pos.shown && pos.act < pos.list, JSON.stringify(pos));

  // 4. 未請求をすべて選ぶ
  if (pos.shown) { await page.click('#invPullActions >> text=選択解除'); await page.click('#invPullActions >> text=未請求をすべて選ぶ'); }
  const r2 = await rows(page);
  ck('「未請求をすべて選ぶ」は請求済みに✓を付けない', r2.length === 4 && r2[0].checked && r2[1].checked && !r2[2].checked && !r2[3].checked, JSON.stringify(r2.map(r => r.checked)));

  // 5. 取り込み
  if (pos.shown) { await page.click('#invPullActions >> text=✓を付けた納品を明細に入れる'); await page.waitForTimeout(300); }
  const ap = await page.evaluate(() => ({ lines: invLines.map(l => l.name), sub: document.getElementById('invSubject').value }));
  ck('取り込むと明細に2件分（9/26 モモ・送料、10/15 ロース）が入る', ap.lines.some(n => /9\/26.*モモ/.test(n)) && ap.lines.some(n => /10\/15.*ロース/.test(n)) && ap.lines.some(n => /9\/26.*送料/.test(n)), JSON.stringify(ap.lines));
  ck('件名は取り込んだ納品の月から（2026年9月〜10月分）', ap.sub === '2026年9月〜10月分', ap.sub);

  // 6. 請求済みを隠す・期間を絞る
  await page.uncheck('#invPullShowBilled'); await page.waitForTimeout(400);
  const r3 = await rows(page); const msg3 = await page.textContent('#invPullResult');
  ck('「請求済みも表示」を外すと請求済みは隠れ、件数と番号は出る', r3.length === 2 && /請求済み 2件/.test(msg3) && /非表示/.test(msg3), msg3);
  await page.check('#invPullShowBilled');
  await page.selectOption('#invPullPeriod', 'thisMonth'); await page.waitForTimeout(400);
  const r4 = await rows(page);
  ck('期間を「今月」にすると10月の分だけ', r4.length === 1 && /2026-10-15/.test(r4[0].text), JSON.stringify(r4.map(r => r.text.slice(0, 12))));
  await typeIn(page, 'C9002 サンプル商店'); await page.waitForTimeout(700);
  const msg5 = await page.textContent('#invPullResult');
  ck('期間を絞って何も無いときは「すべての期間」を案内（9月の納品があることに気づける）', /納品記録（発送済みの注文）はありません/.test(msg5) && /すべての期間/.test(msg5), msg5);
  await page.selectOption('#invPullPeriod', 'all'); await page.waitForTimeout(400);
  ck('「すべての期間」に戻すとその取引先の9月の納品が出る', (await rows(page)).length === 1, '');

  // 7. 続けて取引先を変える（前の取引先の遅い結果で上書きしない）
  st.slowC1 = 900;
  await typeIn(page, 'C9001 テスト食堂'); await page.waitForTimeout(400);
  await typeIn(page, 'C9002 サンプル商店'); await page.waitForTimeout(1500);
  const r6 = await rows(page);
  ck('取引先を続けて変えても、前の取引先（遅い応答）の結果で上書きしない', r6.length === 1 && /2026-09-05/.test(r6[0].text) && await page.evaluate(() => invPullOrders.every(o => o.customer_id === 'c2')), JSON.stringify(r6.map(r => r.text.slice(0, 12))));
  st.slowC1 = 0;

  // 7b. 保存済みの書類（下書き・複製）を開くと、その書類の取引先の納品記録に読み直す
  await typeIn(page, 'C9001 テスト食堂'); await page.waitForTimeout(700);
  await page.evaluate(() => invFillFormFrom({ customer_id: 'c2', snapshot: { type: '請求書', name: 'サンプル商店', customer_id: 'c2', lines: [] } }, true));
  await page.waitForTimeout(700);
  ck('保存済みの書類を開くと、その取引先の納品記録に読み直す（前の取引先の一覧を残さない）', await page.evaluate(() => invPullOrders.length > 0 && invPullOrders.every(o => o.customer_id === 'c2')), JSON.stringify(await page.evaluate(() => invPullOrders.map(o => o.customer_id))));

  // 9. 台帳に無い宛名・読込エラー
  await typeIn(page, '台帳に無いお店'); await page.waitForTimeout(500);
  ck('台帳に無い宛名にすると一覧を消して案内を出す', (await rows(page)).length === 0 && /台帳に無い宛名では出せません/.test(await page.textContent('#invPullResult')), await page.textContent('#invPullResult'));
  await typeIn(page, 'C9003 エラー亭'); await page.waitForTimeout(700);
  ck('読込エラーは画面に出す（黙って空にしない）', /納品記録を読み込めませんでした/.test(await page.textContent('#invPullResult')), await page.textContent('#invPullResult'));
  ck('PC: JSエラーなし', errors.length === 0, errors.join(' / '));
  await ctx.close();

  // 10. スマホ
  const ph = await openPage(browser, 390, 844);
  await typeIn(ph.page, 'C9001 テスト食堂'); await ph.page.waitForTimeout(800);
  const sp = await ph.page.evaluate(() => { const b = document.getElementById('invPullBox').getBoundingClientRect();
    return { docW: document.documentElement.scrollWidth, vw: innerWidth, boxRight: Math.round(b.right), rows: document.querySelectorAll('#invPullList label').length,
      ctlRight: Math.round(Math.max(...[...document.querySelectorAll('#invPullBox .inv-pull-ctl *, #invPullActions button')].map(e => e.getBoundingClientRect().right))) }; });
  ck('スマホ: 横はみ出しなし・納品記録の欄と操作も画面の中・4件出る', sp.docW <= sp.vw && sp.boxRight <= sp.vw && sp.ctlRight <= sp.vw && sp.rows === 4, JSON.stringify(sp));
  ck('スマホ: JSエラーなし', ph.errors.length === 0, ph.errors.join(' / '));
  await ph.ctx.close();

  await browser.close();
  out.forEach(([n, ok, e]) => console.log(`${ok ? 'PASS' : 'FAIL'} : ${n}${ok || !e ? '' : '  [' + e.slice(0, 300) + ']'}`));
  console.log(`\n${out.filter(x => x[1]).length}/${out.length} passed`);
  process.exit(out.every(x => x[1]) ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
