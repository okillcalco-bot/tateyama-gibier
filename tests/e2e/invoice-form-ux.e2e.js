// 請求書作成フォームの使いやすさ（2026-10-30 沖「請求書作成のフォームが使いづらい。大手の書類作成ソフトのUIを見て使いやすくして」）
//
//   変更前に実測した問題（架空データ・PC 1366px／スマホ 390px）
//     - スマホで左右2列のまま横にはみ出す（画面390pxに対し752px）。右の「発行元の設定」が潰れる
//     - 明細の上に「月まとめ発行」「注文から取り込む」が挟まり、明細まで 928px スクロール
//     - 明細の並べ替え・複製ができない。Enter で次の行へ進めない（行を足すたびにボタン）
//     - 「送料（クール120）」も 8%・kg のまま入る。単価が空の行が 0円のまま黙って載る
//     - 仕上がりは別ウィンドウのプレビューでしか見られない
//
//   参考にした大手の作り（freee請求書・Misoca・マネーフォワード クラウド請求書のヘルプ）
//     取引先→明細→プレビューで確認→保存 の流れ／取引先・品目を選ぶと宛名・単価が入る／金額と消費税の自動計算／
//     品目の並べ替え・行の挿入と移動／表計算からの明細の一括貼り付け／帳票の複製・変換
//
//   ここで測ること
//     1. PC: 品名欄が300px以上・横はみ出しなし・右にプレビューがあり入力が反映される
//     2. スマホ: 横はみ出しなし（明細の行も画面内）
//     3. 取引先を選ぶと台帳のどのお客さんかが出て、宛名・敬称・住所が入る
//     4. 期限のワンタッチ（当月末・翌月末・翌々月末・30日後・なし）と件名の候補（前月分・当月分）
//     5. 明細: Enter で 品名→数量→単価→次の行（最後なら行が増える）、↑↓・複製・削除
//     6. 品名に「送料」→10%・個（自分で選び直した行・保存済みの行は変えない）
//     7. 表計算から貼り付け→行ごとに明細（税率も品名から）
//     8. 単価が空の行は赤枠・件数表示・発行の確認画面に出る
//     9. 月まとめ発行と1枚作成は切り替え。集計を押せば月まとめに、注文の取り込みは開く
//    10. 書類のスナップショットに画面用の印（_taxTouched など）が混ざらない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const CUSTOMERS = [
  { id: 'c1', code: 'C0532', name: '植山', kana: 'うえやま', price_rank: 'standard', address: '東京都テスト区1-1-1', building: 'テストビル2階', honorific: '様', is_active: true, search_aliases: [] },
  { id: 'c2', code: 'C0829', name: 'モンレーヴ館山', kana: 'もんれーゔたてやま', price_rank: 'startmember', address: null, honorific: '御中', is_active: true, search_aliases: [] },
];
const PM = [{ species: 'イノシシ', part_name: 'ロース', grade: '並', price_standard: 3800 }, { species: 'イノシシ', part_name: 'バラ', grade: '並', price_standard: 3100 }];

async function openPage(browser, vw, vh) {
  const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, timezoneId: 'Asia/Tokyo' });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date('2026-10-30T03:00:00Z'));
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });
  await page.route('**/rest/v1/**', route => {
    const u = route.request().url(), m = route.request().method();
    const J = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (m !== 'GET') return J([]);
    if (/\/customers/.test(u)) return J(CUSTOMERS);
    if (/\/price_master/.test(u)) return J(PM);
    if (/\/app_settings/.test(u)) return J([{ value: { issuer_name: '合同会社アルコ', issuer_sub: '館山ジビエセンター', postal: '294-0025', address: '千葉県館山市', tel: '070', reg_number: 'T704', bank: '千葉銀行 館山支店 普通 1234567' } }]);
    return J([]);
  });
  await page.addInitScript(() => { try { localStorage.setItem('tg_staff_key', 'TESTKEY'); } catch (e) {} });
  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(600);
  await page.evaluate(() => switchTab('invoice'));
  await page.waitForTimeout(500);
  return { ctx, page, errors, dialogs };
}
const row = (page, i) => page.locator(`#invLinesBox .inv-line[data-i="${i}"]`);
async function typeIn(loc, v) { await loc.fill(v); await loc.dispatchEvent('input'); }

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const out = []; const ck = (n, c, e) => out.push([n, !!c, e == null ? '' : String(e)]);

  // ── PC ──
  const { ctx, page, errors, dialogs } = await openPage(browser, 1366, 900);

  // 3. 取引先
  await typeIn(page.locator('#invCustomerInput'), 'C0532 植山');
  const cust = await page.evaluate(() => ({ id: invGv('invCustomerId'), name: invGv('invName'), hon: invGv('invHonorific'), addr: invGv('invAddress'), hint: document.getElementById('invCustomerHint').textContent, ok: document.getElementById('invCustomerHint').classList.contains('ok') }));
  ck('取引先: 台帳のお客さんが出て（コード・価格ランク）、宛名・敬称・住所が入る', cust.id === 'c1' && cust.name === '植山' && cust.hon === '様' && /テスト区/.test(cust.addr) && /C0532/.test(cust.hint) && /標準/.test(cust.hint) && cust.ok, JSON.stringify(cust));
  await typeIn(page.locator('#invCustomerInput'), '台帳に無い店');
  const free = await page.evaluate(() => ({ id: invGv('invCustomerId'), hint: document.getElementById('invCustomerHint').textContent }));
  ck('取引先: 台帳に無い宛名は、取り込みできない旨をその場で出す', free.id === '' && /台帳に無い/.test(free.hint), JSON.stringify(free));
  await typeIn(page.locator('#invCustomerInput'), 'C0532 植山');

  // 4. 期限・件名
  await page.fill('#invDate', '2026-10-30'); await page.dispatchEvent('#invDate', 'change');
  const dues = {};
  for (const k of ['eom', 'eonm', 'eon2m', 'plus30', 'none']) { await page.click(`[data-due-preset="${k}"]`); dues[k] = await page.inputValue('#invDue'); }
  ck('期限のワンタッチ: 当月末10/31・翌月末11/30・翌々月末12/31・30日後11/29・なし（空）', dues.eom === '2026-10-31' && dues.eonm === '2026-11-30' && dues.eon2m === '2026-12-31' && dues.plus30 === '2026-11-29' && dues.none === '', JSON.stringify(dues));
  await page.click('[data-due-preset="eonm"]');
  const chips = await page.$$eval('#invSubjectChips button', bs => bs.map(b => b.textContent));
  await page.click('#invSubjectChips button >> nth=0');
  ck('件名の候補: 前月分・当月分が出て、押すと件名に入る', JSON.stringify(chips) === JSON.stringify(['2026年9月分', '2026年10月分']) && (await page.inputValue('#invSubject')) === '2026年9月分', JSON.stringify(chips));

  // 5. Enter の流れ（品名→数量→単価→次の行。最後の行なら増える）
  await typeIn(row(page, 0).locator('[data-f=name]'), 'イノシシ ロース');   // 価格マスタの品目→単価3,800・数量へ
  const afterPick = await page.evaluate(() => ({ price: invLines[0].price, focus: document.activeElement && document.activeElement.dataset.f }));
  ck('品目を選ぶと単価（標準3,800円）が入り、数量欄へ進む', Number(afterPick.price) === 3800 && afterPick.focus === 'qty', JSON.stringify(afterPick));
  await page.keyboard.type('2.35'); await page.keyboard.press('Enter');
  const f1 = await page.evaluate(() => document.activeElement.dataset.f);
  await page.keyboard.press('Enter');
  const n1 = await page.locator('#invLinesBox .inv-line').count();
  const f2 = await page.evaluate(() => ({ f: document.activeElement.dataset.f, i: document.activeElement.closest('.inv-line') && document.activeElement.closest('.inv-line').dataset.i }));
  ck('Enter: 数量→単価→（最後の行なので）行が増えて次の行の品名へ', f1 === 'price' && n1 === 2 && f2.f === 'name' && f2.i === '1', JSON.stringify({ f1, n1, f2 }));

  // 6. 送料→10%・個
  await page.keyboard.type('送料（クール120）'); await row(page, 1).locator('[data-f=name]').dispatchEvent('input');
  const fr = await page.evaluate(() => ({ tax: invLines[1].tax, unit: invLines[1].unit, sel: document.querySelector('#invLinesBox .inv-line[data-i="1"] [data-f=tax]').value }));
  ck('品名に「送料」→ 税率10%・単位「個」に自動で変わる（選択欄も）', fr.tax === 10 && fr.unit === '個' && fr.sel === '10', JSON.stringify(fr));
  await typeIn(row(page, 1).locator('[data-f=name]'), 'イノシシ バラ');
  const back = await page.evaluate(() => ({ tax: invLines[1].tax, unit: invLines[1].unit }));
  ck('「送料」を消すと（自動で変えた行だけ）8%・kg に戻る', back.tax === 8 && back.unit === 'kg', JSON.stringify(back));
  await typeIn(row(page, 1).locator('[data-f=name]'), '送料（クール120）');
  await row(page, 1).locator('[data-f=tax]').selectOption('8');
  await typeIn(row(page, 1).locator('[data-f=name]'), '送料（クール120・2個口）');
  ck('自分で税率を選び直した行は、品名を変えても税率を変えない', await page.evaluate(() => invLines[1].tax) === 8, '');
  await row(page, 1).locator('[data-f=tax]').selectOption('10');
  await typeIn(row(page, 1).locator('[data-f=qty]'), '1'); await typeIn(row(page, 1).locator('[data-f=price]'), '1740');

  // 5b. ↑↓・複製・削除
  await row(page, 1).locator('[data-act=up]').click();
  const order1 = await page.evaluate(() => invLines.map(l => l.name));
  await row(page, 0).locator('[data-act=down]').click();
  await row(page, 0).locator('[data-act=dup]').click();
  const order2 = await page.evaluate(() => invLines.map(l => l.name + ':' + l.qty));
  ck('↑ で行が上へ（送料が1行目に）', order1[0].startsWith('送料') && order1[1] === 'イノシシ ロース', JSON.stringify(order1));
  ck('↓ で戻し、⧉ で同じ行がすぐ下に複製される', JSON.stringify(order2) === JSON.stringify(['イノシシ ロース:2.35', 'イノシシ ロース:2.35', '送料（クール120・2個口）:1']), JSON.stringify(order2));
  ck('1行目の↑・最後の行の↓は押せない', await row(page, 0).locator('[data-act=up]').isDisabled() && await row(page, 2).locator('[data-act=down]').isDisabled(), '');
  await row(page, 1).locator('[data-act=del]').click();
  ck('× で行が消える', await page.evaluate(() => invLines.length) === 2, '');

  // 7. 表計算から貼り付け
  await page.click('text=+ 明細を追加');
  await page.evaluate(() => {
    const el = document.querySelector('#invLinesBox .inv-line[data-i="2"] [data-f=name]');
    const dt = new DataTransfer(); dt.setData('text/plain', 'イノシシ バラ\t1.8\tkg\t3,100\nシカ モモ\t3.08\tkg\t2407\t8%\n加工賃（スライス）\t1\t式\t2000\n');
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const pasted = await page.evaluate(() => invLines.slice(2).map(l => [l.name, l.qty, l.unit, l.price, l.tax]));
  ck('表計算の3行を貼り付け→空の行に置き換わって3行（数字のカンマも読む・加工賃は10%）',
    JSON.stringify(pasted) === JSON.stringify([['イノシシ バラ', 1.8, 'kg', 3100, 8], ['シカ モモ', 3.08, 'kg', 2407, 8], ['加工賃（スライス）', 1, '式', 2000, 10]]), JSON.stringify(pasted));
  ck('貼り付けた件数を明細の下に出す', /3行を貼り付けました/.test(await page.textContent('#invPasteMsg')), await page.textContent('#invPasteMsg'));

  // 8. 単価が空の行
  await page.click('text=+ 明細を追加');
  const last = await page.evaluate(() => invLines.length - 1);
  await typeIn(row(page, last).locator('[data-f=name]'), 'イノシシ ネック'); await typeIn(row(page, last).locator('[data-f=qty]'), '0.8');
  const warn = await page.evaluate(n => ({ cls: document.querySelector(`#invLinesBox .inv-line[data-i="${n}"]`).classList.contains('warn'), txt: document.getElementById('invLineWarn').textContent, shown: document.getElementById('invLineWarn').style.display !== 'none' }), last);
  ck('単価が空の行は赤枠になり、何行目かを明細の下に出す', warn.cls && warn.shown && new RegExp(`${last + 1}行目`).test(warn.txt), JSON.stringify(warn));
  await page.evaluate(() => invIssue());
  await page.waitForTimeout(200);
  ck('発行の確認画面の先頭に「単価が空の行」が出る（止めはしない）', dialogs.some(d => /単価が空の行があります/.test(d) && /請求書を発行します/.test(d)), JSON.stringify(dialogs.slice(-1)));

  // 1. PC の実寸とプレビュー
  await page.waitForTimeout(500);
  const pc = await page.evaluate(() => {
    const nameW = Math.min(...[...document.querySelectorAll('#invLinesBox [data-f=name]')].map(e => e.getBoundingClientRect().width));
    const f = document.getElementById('invLivePreview');
    return { nameW: Math.round(nameW), docW: document.documentElement.scrollWidth, vw: innerWidth, srcdoc: f ? f.srcdoc : '', total: document.getElementById('invTotal').textContent, bar: document.getElementById('invBarTotal').textContent,
      sticky: getComputedStyle(document.querySelector('.inv-actionbar')).position, frameW: document.getElementById('invPreviewFrame').getBoundingClientRect().width };
  });
  ck('PC: 品名欄は300px以上（以前は狭い列で品名が切れた）・横はみ出しなし', pc.nameW >= 300 && pc.docW <= pc.vw, JSON.stringify({ nameW: pc.nameW, docW: pc.docW }));
  ck('PC: 右のプレビューに宛名・件名・明細・合計（税込）が入力どおりに出る', /植山/.test(pc.srcdoc) && /2026年9月分/.test(pc.srcdoc) && /送料（クール120・2個口）/.test(pc.srcdoc) && pc.srcdoc.includes(pc.total) && !/class="noprint"[^>]*style="display/.test(pc.srcdoc), pc.total);
  ck('PC: 保存・発行のボタン列は画面下に固定（sticky）で、合計も出る', pc.sticky === 'sticky' && pc.bar === pc.total, JSON.stringify({ sticky: pc.sticky, bar: pc.bar }));

  // 10. スナップショットが汚れない
  const snapKeys = await page.evaluate(() => [...new Set(invCollect().lines.flatMap(l => Object.keys(l)))].sort());
  ck('書類のスナップショットは name/qty/unit/price/tax/amount だけ（画面用の印が混ざらない）', JSON.stringify(snapKeys) === JSON.stringify(['amount', 'name', 'price', 'qty', 'tax', 'unit']), JSON.stringify(snapKeys));

  // 6b. 保存済みの書類を開いた行は自動で税率を変えない
  await page.evaluate(() => invFillFormFrom({ snapshot: { type: '請求書', name: 'X', lines: [{ name: 'ロース', qty: 1, unit: 'kg', price: 100, tax: 8, amount: 100 }] } }, true));
  await typeIn(row(page, 0).locator('[data-f=name]'), 'ロース（送料込み）');
  ck('保存済みの書類から開いた行は、品名に「送料」を足しても8%のまま', await page.evaluate(() => invLines[0].tax) === 8, '');

  // 9. 月まとめと1枚作成の切り替え・取り込みは開く
  const vis = () => page.evaluate(() => ({ batch: getComputedStyle(document.getElementById('invBatchPanel')).display !== 'none', single: getComputedStyle(document.getElementById('invSinglePanel')).display !== 'none' }));
  const v0 = await vis();
  await page.evaluate(() => invBatchSearch()); await page.waitForTimeout(200);
  const v1 = await vis();
  await page.click('#invModeTabs button[data-mode="single"]');
  const v2 = await vis();
  ck('最初は1枚作成。「請求先ごとに集計」で月まとめに切り替わり、タブで戻れる', v0.single && !v0.batch && v1.batch && !v1.single && v2.single && !v2.batch, JSON.stringify({ v0, v1, v2 }));
  // 2026-10-30 変更: 畳むと納品記録が見つからない（沖「新しくした請求書作成から出てこない」）→ 取引先の下に常に出す
  //   詳しくは invoice-delivery-records.e2e.js
  ck('納品記録の欄は畳まず、取引先（2）のすぐ下・日付（3）より上にある', await page.evaluate(() => { const b = document.getElementById('invPullBox'), s3 = document.getElementById('invDate'); return b.tagName !== 'DETAILS' && b.getBoundingClientRect().height > 0 && b.getBoundingClientRect().top < s3.getBoundingClientRect().top; }), '');
  ck('PC: JSエラーなし', errors.length === 0, errors.join(' / '));
  await ctx.close();

  // ── スマホ ──
  const ph = await openPage(browser, 390, 844);
  await typeIn(ph.page.locator('#invCustomerInput'), 'C0532 植山');
  await typeIn(row(ph.page, 0).locator('[data-f=name]'), 'イノシシ ロース（特選スライス・薄切り 2mm）');
  await typeIn(row(ph.page, 0).locator('[data-f=qty]'), '2.35'); await typeIn(row(ph.page, 0).locator('[data-f=price]'), '3800');
  const sp = await ph.page.evaluate(() => {
    const r = document.querySelector('#invLinesBox .inv-line').getBoundingClientRect();
    const right = Math.max(...[...document.querySelectorAll('#invLinesBox .inv-line *')].map(e => e.getBoundingClientRect().right));
    return { docW: document.documentElement.scrollWidth, vw: innerWidth, lineRight: Math.round(right), lineH: Math.round(r.height) };
  });
  ck('スマホ: 横はみ出しなし（以前は390pxの画面に752px）・明細の部品も画面の中', sp.docW <= sp.vw && sp.lineRight <= sp.vw, JSON.stringify(sp));
  ck('スマホ: 明細1行は3段に収まる（品名／数量・単位・単価／税率・金額・操作）', sp.lineH <= 170, JSON.stringify(sp));
  ck('スマホ: JSエラーなし', ph.errors.length === 0, ph.errors.join(' / '));
  await ph.ctx.close();

  await browser.close();
  out.forEach(([n, ok, e]) => console.log(`${ok ? 'PASS' : 'FAIL'} : ${n}${e ? '  [' + e.slice(0, 300) + ']' : ''}`));
  console.log(`\n${out.filter(x => x[1]).length}/${out.length} passed`);
  process.exit(out.every(x => x[1]) ? 0 : 1);
})();
