// 収支解析・事業計画のたね（finance-analysis.html）
//
//   きっかけ（2026-09-18）「収支関係の解析もしたい。補助金取りに行く事業計画も解析タブからアイデア出ししたい。」
//
//   ここで測ること
//     1. 会計の月次損益（city_report_inputs kind=pl）から 売上・仕入・販管費・営業損益・経常損益 を月ごとに出す
//        （検算: 7月 売上3,321,050−仕入67,101−販管費2,464,522＝789,427）
//     2. 前期の要約（kind=pl_summary）が前年同月として並ぶ
//     3. 頭数（v_individuals_all）・精肉kg（在庫の親なし行）・アプリの販売記録（受注＋出店）と同じ行に並び、1頭あたり・1kgあたりが出る
//     4. 損益分岐の頭数 = 月平均販管費 ÷ 1頭あたり売上総利益
//     5. 補助金・事業計画のたねが実測値入りで出て、骨子をコピーできる／下書きが1本にまとまる
//     6. 会計の数字が無い年度でも壊れず、画面に「まだ入っていません」と出る（サイレント失敗なし）
//     7. 管理者だけ（admin-gate）／解析タブにカードがある
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const PL = {
  '2026-04': {"売上高":3669421,"仕入髙":76451,"役員報酬":90000,"給与手当":225000,"雑給":461627,"法定福利費":46662,"旅費交通費":113524,"燃料費":106100,"荷造包装費":129756,"水道光熱費":76471,"消耗品費":97332,"雑費":124140},
  '2026-05': {"売上高":2299417,"仕入髙":96710,"役員報酬":90000,"給与手当":225000,"雑給":400750,"外注費":16995,"旅費交通費":193025,"燃料費":66244,"荷造包装費":174581,"消耗品費":176398,"雑費":143806,"雑収入":1323000},
  '2026-07': {"売上高":3321050,"仕入髙":67101,"役員報酬":90000,"給与手当":225000,"雑給":662115,"法定福利費":223560,"外注費":431913,"旅費交通費":81874,"通信費":39593,"交際費":49300,"地代家賃":35000,"保険料":16300,"水道光熱費":11353,"燃料費":88393,"消耗品費":130110,"荷造包装費":142714,"諸会費":36810,"管理諸費":22000,"書籍費":8250,"雑費":170237},
};
const PL_SUM = { '2025-04': {"売上高":1677797,"売上総利益":1643120,"経常損益":255713}, '2025-05': {"売上高":2169608,"売上総利益":1339082,"経常損益":1077948}, '2025-07': {"売上高":1474684,"売上総利益":1448180,"経常損益":-97110} };
const IND = [];
const add = (ym, n, sp) => { for (let i = 0; i < n; i++) IND.push({ capture_date: ym + '-' + String((i % 28) + 1).padStart(2, '0'), species: sp || 'イノシシ', weight: 40 }); };
add('2025-04', 55); add('2025-05', 55); add('2025-07', 92);
add('2026-04', 70); add('2026-04', 3, 'キョン'); add('2026-05', 113); add('2026-07', 142); add('2026-08', 131);
const INV = [
  { processed_at: '2026-04-10T00:00:00', weight_kg: 500, individual_id: 'TGC-08-T001', species: 'イノシシ' }, { processed_at: '2026-04-11T00:00:00', weight_kg: 640, individual_id: 'TGC-08-T002', species: 'イノシシ' },
  { processed_at: '2026-05-10T00:00:00', weight_kg: 1698, individual_id: 'TGC-08-T003', species: 'イノシシ' }, { processed_at: '2026-07-10T00:00:00', weight_kg: 2316, individual_id: 'TGC-08-T004', species: 'イノシシ' },
];
const ORDERS = [ { order_date: '2026-07-20', total_amount: 12699, status: '発送済' }, { order_date: '2026-07-21', total_amount: 99999, status: 'キャンセル' }, { order_date: '2026-08-05', total_amount: 1072465, status: '確認済' } ];
const EVENTS = [ { event_date: '2026-08-29', cash_total: 100000, cashless_total: 50000, consign_sales_ex: 45552 } ];

async function open(browser, { fy = '2026', empty = false, fail = false } = {}) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { sessionStorage.setItem('tg_role_v1', 'admin'); sessionStorage.setItem('tg_access_v1', 'ok'); });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const calls = [];
  await page.route('**/*', rt => {
    const u = decodeURIComponent(rt.request().url());
    if (u.startsWith('file:')) return rt.continue();
    if (/cdnjs|jsdelivr|fonts\./.test(u)) return rt.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    const J = x => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    calls.push(u);
    if (fail && /city_report_inputs/.test(u)) return rt.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' });
    if (/city_report_inputs/.test(u)) return J(empty ? [] : [
      ...Object.keys(PL).map(m => ({ month: m, kind: 'pl', data: PL[m], source: '千葉トラスト会計 R8.7' })),
      ...Object.keys(PL_SUM).map(m => ({ month: m, kind: 'pl_summary', data: PL_SUM[m], source: '前期列' })) ]);
    if (/v_individuals_all/.test(u)) { const sp = /species=eq\.([^&]+)/.exec(u); return J(IND.filter(r => !sp || r.species === sp[1])); }
    if (/\/inventory/.test(u)) return J(INV);
    if (/\/orders/.test(u)) return J(ORDERS);
    if (/sale_events/.test(u)) return J(EVENTS);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../finance-analysis.html') + '?fy=' + fy);
  await page.waitForTimeout(800);
  return { page, errors, calls };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = []; const ck = (n, c, g) => results.push([n, c, g]);

  const { page, errors, calls } = await open(browser);
  const m = await page.evaluate(() => model);
  const jul = m.rows.find(r => r.ym === '2026-07');
  ck('7月: 売上−仕入−販管費＝営業損益 789,427（会計の損益計算書と一致）', jul.pl.sales === 3321050 && jul.pl.cogs === 67101 && jul.pl.sga === 2464522 && jul.pl.op === 789427, JSON.stringify([jul.pl.sales, jul.pl.cogs, jul.pl.sga, jul.pl.op]));
  ck('5月: 経常損益＝営業損益＋雑収入（1,323,000）', m.rows.find(r => r.ym === '2026-05').pl.ordinary === m.rows.find(r => r.ym === '2026-05').pl.op + 1323000, '');
  ck('7月の人件費＝役員報酬＋給与手当＋雑給＋法定福利費＝1,200,675', jul.pl.labor === 90000 + 225000 + 662115 + 223560, String(jul.pl.labor));
  ck('前年同月（pl_summary）が並ぶ: 7月の前年売上 1,474,684・経常 ▲97,110', jul.prev && jul.prev.sales === 1474684 && jul.prev.ordinary === -97110, JSON.stringify(jul.prev));
  ck('頭数・精肉kg・アプリ販売記録が同じ行に: 7月 142頭・2,316kg・受注12,699（キャンセル除く）', jul.heads === 142 && jul.kgMeat === 2316 && jul.appSales === 12699, JSON.stringify([jul.heads, jul.kgMeat, jul.appSales]));
  ck('1頭あたり売上＝3,321,050÷142≒23,388円、精肉1kgあたり≒1,434円', Math.round(jul.salesPerHead) === 23388 && Math.round(jul.salesPerKg) === 1434, JSON.stringify([jul.salesPerHead, jul.salesPerKg]));
  ck('8月（会計なし）: 頭数131・出店＋受注 1,268,017 は出るが pl は null', m.rows.find(r => r.ym === '2026-08').pl === null && m.rows.find(r => r.ym === '2026-08').appSales === 1268017, '');
  const t = m.t;
  ck('累計は会計のある3か月分（4・5・7月）で揃える: 売上 9,289,888・頭数 328', t.months === 3 && t.sales === 3669421 + 2299417 + 3321050 && t.heads === 73 + 113 + 142, JSON.stringify([t.months, t.sales, t.heads]));
  const grossPerHead = (t.sales - (76451 + 96710 + 67101)) / 328, sgaMonthly = t.sga / 3;
  ck('損益分岐の頭数＝月平均販管費÷1頭あたり売上総利益', Math.abs(t.bepHeads - sgaMonthly / grossPerHead) < 1e-6 && t.bepHeads > 0, String(t.bepHeads));
  ck('前年同期間比: 売上（4・5・7月の前期合計 5,322,089）と頭数（202）', t.prevSales === 1677797 + 2169608 + 1474684 && t.prevHeads === 202 && Math.abs(t.salesYoy - (t.sales / 5322089 - 1)) < 1e-9, JSON.stringify([t.prevSales, t.prevHeads]));

  const ui = await page.evaluate(() => ({
    kSales: document.getElementById('kSales').textContent, kOp: document.getElementById('kOp').textContent, kBep: document.getElementById('kBep').textContent, kBepSub: document.getElementById('kBepSub').textContent,
    status: document.getElementById('statusBar').textContent, monthRows: document.querySelectorAll('#monthBody tr').length,
    julRow: [...document.querySelectorAll('#monthBody tr')].find(tr => /^7月/.test(tr.textContent)).textContent.replace(/\s+/g, ' '),
    acct: [...document.querySelectorAll('#acctBody tr')].map(tr => tr.children[0].textContent), acctFirst: document.querySelector('#acctBody tr').textContent.replace(/\s+/g, ' '),
    ideas: [...document.querySelectorAll('#ideaGrid .idea')].map(d => ({ key: d.dataset.key, title: d.querySelector('h3').textContent, text: d.textContent.replace(/\s+/g, ' ') })),
    plan: document.getElementById('planText').value, charts: [...document.querySelectorAll('.chart-wrap')].map(w => w.querySelector('canvas') ? 'canvas' : (w.querySelector('table') ? 'fallback' : 'empty')),
    csv: document.getElementById('btnCsv').disabled,
  }));
  ck('KPI: 売上 929万・営業損益が出る', /929万/.test(ui.kSales) && /万/.test(ui.kOp), JSON.stringify([ui.kSales, ui.kOp]));
  ck('KPI: 損益分岐の頭数と、今の月平均搬入との比較（上回っている／足りない）', /頭\/月/.test(ui.kBep) && /(上回っている|足りない)/.test(ui.kBepSub), ui.kBep + ' ' + ui.kBepSub);
  ck('状態表示に「会計の数字は 4月・5月・7月 の3か月分」', /4月・5月・7月/.test(ui.status) && /3か月分/.test(ui.status), ui.status);
  ck('月別テーブルは12か月＋累計の13行、7月の行に 142・2,316・3,321,050・789,427', ui.monthRows === 13 && /142/.test(ui.julRow) && /2,316/.test(ui.julRow) && /3,321,050/.test(ui.julRow) && /789,427/.test(ui.julRow), ui.julRow);
  ck('科目別: 累計の大きい順（先頭は雑給）で分類タグ付き', ui.acct[0] === '雑給' && /人件費/.test(ui.acctFirst), ui.acct.slice(0, 4).join(','));
  ck('グラフ4枚（CDNが無い環境では簡易バー）', ui.charts.length === 4 && ui.charts.every(c => c !== 'empty'), ui.charts.join(','));
  ck('事業計画のたねが5件以上（販路・省力化・物流・包材・体験・損益分岐）', ui.ideas.length >= 5 && ['sales', 'labor', 'logi', 'pack', 'exp', 'struct'].every(k => ui.ideas.some(i => i.key === k)), ui.ideas.map(i => i.key).join(','));
  ck('たねに実測値が入る（販路: 1頭あたり売上 28,323円）', /28,323円/.test(ui.ideas.find(i => i.key === 'sales').text), ui.ideas.find(i => i.key === 'sales').text.slice(0, 200));
  ck('制度名には「要確認」が付く', ui.ideas.every(i => /要確認/.test(i.text)), '');
  ck('下書きが1本にまとまる（現状の数字＋各たね＋要確認の注意）', /【現状】/.test(ui.plan) && /搬入 459頭/.test(ui.plan) && /9,289,888円/.test(ui.plan) && /■ 販路開拓/.test(ui.plan) && /一次情報で確認/.test(ui.plan), ui.plan.slice(0, 160));
  ck('CSVボタンが有効になる', ui.csv === false, '');

  // 骨子をコピー
  await page.evaluate(() => { window._copied = null; navigator.clipboard.writeText = t => { window._copied = t; return Promise.resolve(); }; });
  await page.click('#ideaGrid .idea[data-key="labor"] button');
  await page.waitForTimeout(100);
  const copied = await page.evaluate(() => ({ t: window._copied, msg: document.querySelector('#ideaGrid .idea[data-key="labor"] .copied').textContent }));
  ck('「骨子をコピー」で 課題→取組→数値目標→投資→制度 の文章がクリップボードに入り、コピーしましたと出る', copied.t && /【課題（実測）】/.test(copied.t) && /【数値目標】/.test(copied.t) && /【使えそうな制度（要確認）】/.test(copied.t) && copied.msg === 'コピーしました', (copied.t || '').slice(0, 120));

  // イノシシだけ
  await page.selectOption('#fSpecies', 'イノシシ'); await page.evaluate(() => runAnalysis()); await page.waitForTimeout(500);
  const boarOnly = await page.evaluate(() => model.rows.find(r => r.ym === '2026-04').heads);
  ck('「イノシシだけ」にすると4月の頭数は 73 → 70（キョン3頭を除く）', boarOnly === 70 && calls.some(u => /v_individuals_all.*species=eq\.イノシシ/.test(u)), String(boarOnly));
  ck('pageerrorなし', errors.length === 0, errors.join(' / '));
  await page.context().close();

  // 会計の数字が無い年度
  const p2 = await open(browser, { fy: '2024', empty: true });
  const ui2 = await p2.page.evaluate(() => ({ status: document.getElementById('statusBar').textContent, cls: document.getElementById('statusBar').className, kSales: document.getElementById('kSales').textContent, ideas: document.getElementById('ideaGrid').textContent }));
  ck('会計の数字が無い年度: 「まだ入っていません」と黄色で出て、KPIは —', /まだ入っていません/.test(ui2.status) && /warn/.test(ui2.cls) && /—/.test(ui2.kSales), ui2.status);
  ck('pageerrorなし（会計なし）', p2.errors.length === 0, p2.errors.join(' / '));
  await p2.page.context().close();

  // 取得失敗は画面に出る
  const p3 = await open(browser, { fail: true });
  const ui3 = await p3.page.evaluate(() => ({ status: document.getElementById('statusBar').textContent, cls: document.getElementById('statusBar').className }));
  ck('読み込み失敗は赤で画面に出る（握り潰さない）', /読み込めませんでした/.test(ui3.status) && /error/.test(ui3.cls), ui3.status);
  await p3.page.context().close();

  // 管理者でなければ管理者コードの入口
  const ctx4 = await browser.newContext(); const p4 = await ctx4.newPage();
  await p4.route('**/*', rt => rt.request().url().startsWith('file:') ? rt.continue() : rt.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p4.goto('file://' + path.resolve(__dirname, '../../finance-analysis.html')); await p4.waitForTimeout(400);
  ck('管理者でなければ管理者コードの入口が出て、データを読まない', await p4.evaluate(() => !!document.getElementById('admin-gate') && document.getElementById('kSales').textContent === '—'), '');
  await ctx4.close();

  // 解析タブにカード
  const ctx5 = await browser.newContext(); await ctx5.addInitScript(() => { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); });
  const p5 = await ctx5.newPage();
  await p5.route('**/*', rt => { const u = rt.request().url(); if (u.startsWith('file:')) return rt.continue(); if (/cdnjs|jsdelivr|fonts\./.test(u)) return rt.fulfill({ status: 200, contentType: 'application/javascript', body: '' }); return rt.fulfill({ status: 200, contentType: 'application/json', body: '[]' }); });
  await p5.goto('file://' + path.resolve(__dirname, '../../index.html') + '?tab=analysis'); await p5.waitForTimeout(900);
  const card = await p5.evaluate(() => { const a = document.querySelector('#an-cards a[href="finance-analysis.html"]'); return a ? a.textContent : null; });
  ck('解析タブに「収支解析・事業計画のたね」のカード', card && /収支解析/.test(card) && /事業計画/.test(card), card || 'なし');
  await ctx5.close();

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
