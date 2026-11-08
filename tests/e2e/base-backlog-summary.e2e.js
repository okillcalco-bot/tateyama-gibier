// BASEの未発送注文の集計（スタッフ共有用）と、出荷タブのBASE一覧の上限撤廃（2026-11-08 沖「溜まってる注文を集計、そのままスタッフへ共有」）
//
//   きっかけ
//     出荷タブのBASE一覧は「新しい20件だけ見る → 15件 → 表示8件」で黙って切っていた。溜まると古い注文が見えない。
//     また、溜まった注文で何を用意すればよいか（スライス2mm 何パック等）をスタッフに伝える手段が無かった。
//
//   ここで測ること（注文・購入者はすべて架空）
//     1. 出荷タブの一覧: 未発送が9件あれば9件とも出す（8件で切らない）・古い順・アプリで処理済み/BASEで発送済みは出さない
//     2. 集計: 件数・商品ごとの合計個数・重さ（300g×12＝3.6kg）が正しい
//     3. 集計: 革製品は合計に入れず件数だけ書く・明細を取れなかった注文も落とさず書く
//     4. 集計: 注文ごとの一覧は古い順・都道府県と姓だけ（住所・電話・メール・名は入れない）・備考と希望日は出す
//     5. 「コピー」で集計の文字がそのままクリップボードへ入る
//     6. 今日やること（ダッシュボード）のBASE件数も同じ数え方
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const T0 = 1762200000; // 架空の基準時刻
const mk = (k, i, st) => ({ unique_key: k, ordered: T0 + i * 3600, total: '6000', last_name: 'L' + k, first_name: 'F' + k, dispatch_status: st || 'ordered' });
// 新しい順で返す（BASEのAPIと同じ）
const LIST = [
  mk('K12', 12, 'dispatched'), mk('K11', 11), mk('K10', 10), mk('K09', 9), mk('K08', 8), mk('K07', 7),
  mk('K06', 6), mk('K05', 5), mk('K04', 4), mk('K03', 3), mk('K02', 2), mk('K01', 1), mk('K00', 0),
].sort((a, b) => b.ordered - a.ordered);
const S2 = 'イノシシ肉スライス2mm 300g', S5 = 'イノシシ肉スライス5mm 300g', KOMA = 'イノシシ肉小間切れ 250g', LEATHER = 'イノシシ革のキーホルダー';
const DETAIL = {
  K00: [[S2, 2]], K01: [[S2, 4]], K02: [[S5, 2], [KOMA, 2]], K03: [[S2, 4]], K04: [[S5, 2], [S2, 2]],
  K05: [[LEATHER, 1]],                 // 革製品だけ → 一覧・集計とも出さない
  K06: [[S2, 1], [LEATHER, 2]],        // 革製品まじり → 肉だけ合計、革は件数だけ
  K07: null,                           // 明細を取れない
  K08: [[KOMA, 1]], K09: [[S5, 1]], K10: [[S2, 1]],
  K11: [[S5, 1]],                      // アプリで処理済み（orders に BASE-K11 がある）
};
const order = k => ({ order: Object.assign(mk(k, Number(k.slice(1))), {
  prefecture: '架空県', address: '架空市1-2-3', tel: '000-0000-0000', mail_address: 'x@example.invalid',
  remark: k === 'K02' ? '不在時は置き配で' : '', delivery_date: k === 'K03' ? '2025-11-10' : null, delivery_time_zone: k === 'K03' ? '14-16' : null,
  order_items: (DETAIL[k] || []).map(([t, n], j) => ({ item_id: k + j, title: t, amount: n, price: '1500', status: 'ordered' })),
}) });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext();
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let listLimit = null;
  await page.route('**/*', route => {
    const u = decodeURIComponent(route.request().url()), m = route.request().method();
    if (u.startsWith('file:')) return route.continue();
    if (!/\/rest\/v1\//.test(u)) return route.fulfill({ status: 200, body: '' });
    const J = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/rpc\/base_orders/.test(u)) { try { listLimit = JSON.parse(route.request().postData() || '{}').p_limit; } catch (e) {} return J({ orders: LIST }); }
    if (/\/rpc\/base_order_detail/.test(u)) {
      const k = JSON.parse(route.request().postData() || '{}').p_key;
      if (DETAIL[k] === null) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' });
      return J(order(k));
    }
    if (/\/rpc\//.test(u)) return J(null);
    if (m === 'GET' && /\/orders\?order_code=in/.test(u)) return J([{ order_code: 'BASE-K11' }]);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(600);
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

  // 1. 出荷タブの一覧
  const cards = await page.evaluate(async () => {
    await loadBaseOrders();
    return [...document.querySelectorAll('#base-orders .order-card .order-code')].map(e => e.textContent);
  });
  const keysShown = cards.map(c => (c.match(/K\d\d/) || [])[0]);
  T('1. 未発送の注文を全部出す（10件・8件で切らない）', cards.length === 10, `${cards.length}件 ${keysShown.join(',')}`);
  T('1. 古い順に並ぶ', keysShown.join(',') === 'K00,K01,K02,K03,K04,K06,K07,K08,K09,K10', keysShown.join(','));
  T('1. アプリで処理済み（K11）・BASEで発送済み（K12）・革製品だけ（K05）は出さない', !keysShown.includes('K11') && !keysShown.includes('K12') && !keysShown.includes('K05'), keysShown.join(','));
  T('1. BASEの注文一覧は50件まで見る', listLimit === 50, String(listLimit));

  // 2〜4. 集計
  const text = await page.evaluate(async () => { await baseBacklogSummary(); return document.getElementById('base-summary-text').value; });
  const lines = text.split('\n');
  T('2. 件数（革製品だけの注文を除く10件）', /【BASE 未発送 10件】/.test(lines[0]), lines[0]);
  T('2. スライス2mm 300g × 14（計4.2kg）', text.includes('・イノシシ肉スライス2mm 300g × 14（計4.2kg）'), text);
  T('2. スライス5mm 300g × 5（計1.5kg）', text.includes('・イノシシ肉スライス5mm 300g × 5（計1.5kg）'), '');
  T('2. 小間切れ 250g × 3（計0.75kg）', text.includes('・イノシシ肉小間切れ 250g × 3（計0.75kg）'), '');
  T('3. 革製品は合計に入れず件数だけ（K06の2点）', !/キーホルダー ×/.test(text) && text.includes('※革製品 2点は管轄外'), '');
  T('3. 明細を取れなかった注文も書く', text.includes('⚠ 1件は明細を取得できませんでした') && /（明細を取得できず）：BASEで確認（K07）/.test(text), '');
  const orderLines = lines.filter(l => /^\d+\. /.test(l));
  T('4. 注文ごとの一覧は古い順（10行・K00が先頭）', orderLines.length === 10 && /…K00）$/.test(orderLines[0]) && /…K10）$/.test(orderLines[9]), orderLines.map(l => l.slice(-5)).join(' '));
  T('4. 都道府県と姓だけ（住所・電話・メール・名は入れない）', /架空県 LK00様/.test(text) && !/架空市|000-0000-0000|example\.invalid|FK00/.test(text), orderLines[0]);
  T('4. 備考と希望日時を出す', /備考: 不在時は置き配で/.test(text) && /希望: 2025-11-10 14-16/.test(text), '');
  T('4. 商品名は「イノシシ肉」を省いて短く', /：スライス2mm 300g×2（…K00）/.test(orderLines[0]), orderLines[0]);

  // 5. コピー
  const copied = await page.evaluate(async () => { let got = null; try { navigator.clipboard.writeText = async t => { got = t; }; } catch (e) {} await baseSummaryCopy(); return got; });
  T('5. コピーで集計の文字がそのまま入る', copied === text, copied ? copied.slice(0, 40) : 'null');

  // 6. 今日やること
  const todo = await page.evaluate(async () => { try { await loadTodayTodos(); } catch (e) {} return document.body.innerText.match(/(\d+)[^\n]{0,4}🛒 BASEの注文|🛒 BASEの注文（発送処理へ）[^\n]*/) ? document.body.innerHTML.match(/🛒 BASEの注文（発送処理へ）/) !== null : false; });
  T('6. 今日やることにBASEの注文が出る（同じ数え方の関数を使う）', todo, String(todo));

  T('ページエラーなし', errors.length === 0, errors.join(' / '));
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 300) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
