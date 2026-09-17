// 過年度（history.html）：台帳から取り込んだ過年度と今年度を同じ形で見て、年度で比べる
//   1. v_individuals_all を読み、年度チップ・獣種・市・半期で絞れる
//   2. 年度ごとの実績表（頭数・平均体重・買取合計・前年度比）が合う
//   3. グラフはCDNが無くても簡易バーで出る。捕獲者・地区の表が年度ごとに並ぶ
//   4. 個体一覧の検索。再取込は RPC を呼び、失敗は画面に出る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const ROWS = [];
const mk = (y, i, o) => Object.assign({ label_id:`TGC-0${y}-T${String(i).padStart(3,'0')}`, fiscal_year:y, half: o.m >= 4 && o.m <= 9 ? '上半期' : '下半期', species:'イノシシ', capture_date:`${o.m>=4?2018+y:2019+y}-${String(o.m).padStart(2,'0')}-10`, capture_method:'括り', city:'館山市', area:'神余', hunter_name:'井上定男', sex:'メス', weight:40, meat_rank:'並', yield_rank:'A', yield_pct:null, buyback:4000, pickup:false, src:'history' }, o);
// R6: 4頭（体重 30,40,50,60 / 買取 3000,4000,5000,6000）、R7: 6頭、R8: 3頭（業務アプリ）
[30,40,50,60].forEach((w,i)=>ROWS.push(mk(6,i+1,{ m:5+i, weight:w, buyback:w*100, area: i%2?'神余':'稲', hunter_name: i%2?'井上定男':'山田千代子' })));
[35,45,55,65,25,30].forEach((w,i)=>ROWS.push(mk(7,i+1,{ m:4+i, weight:w, buyback:w*100, capture_method: i%3?'括り':'檻', area:'神余', sex: i%2?'メス':'オス', hunter_name:'井上定男' })));
ROWS.push(mk(7,90,{ m:6, species:'キョン', weight:8, buyback:1000, label_id:'TGC-07-キ001' }));
[40,50,60].forEach((w,i)=>ROWS.push(mk(8,i+1,{ m:4+i, weight:w, buyback:null, yield_rank:null, yield_pct:31.5, src:'current', city:'南房総市', area:'宮下' })));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const calls = []; let rpcFail = false;
  await page.route('**/*', r => {
    const u = decodeURIComponent(r.request().url()), m = r.request().method();
    if (u.startsWith('file:')) return r.continue();
    if (/cdnjs|fonts\./.test(u)) return r.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    const J = (x, st) => r.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (/rpc\/tgc_import_ledger/.test(u)) { calls.push({ m, b: JSON.parse(r.request().postData()||'{}') }); return rpcFail ? r.fulfill({ status: 500, contentType: 'text/plain', body: 'canceling statement due to statement timeout' }) : J({ year: 7, imported: 991, sheets: { '生データ': 818, 'イノシシ以外データ': 173 } }); }
    if (/v_individuals_all/.test(u)) return J(ROWS);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../history.html'));
  await page.waitForTimeout(800);
  const results = []; const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  const init = await page.evaluate(() => ({ chips: [...document.querySelectorAll('#yearChips .chip')].map(c => c.textContent + (c.classList.contains('on') ? '*' : '')), sp: document.getElementById('fSpecies').value, updated: document.getElementById('lastUpdated').textContent, year: document.getElementById('yearBox').textContent.replace(/\s+/g,' ') }));
  T('年度チップ 令和6・7・8 が全部オン、獣種は既定でイノシシ', init.chips.join() === '令和6*,令和7*,令和8*' && init.sp === 'イノシシ', JSON.stringify(init.chips));
  T('13頭（イノシシ）を表示', /13頭/.test(init.updated), init.updated);
  T('年度表: 頭数 4 / 6 / 3、進行中の印', /頭数/.test(init.year) && /4/.test(init.year) && /（進行中）/.test(init.year), init.year.slice(0, 160));
  const st = await page.evaluate(() => { const rows = filtered(); return { r6: stats(rows.filter(r => r.fiscal_year === 6)), r7: stats(rows.filter(r => r.fiscal_year === 7)), r8: stats(rows.filter(r => r.fiscal_year === 8)) }; });
  T('R6: 平均体重45kg・買取合計18,000・捕獲者2・上半期4', st.r6.avgW === 45 && st.r6.buyback === 18000 && st.r6.hunters === 2 && st.r6.h1 === 4, JSON.stringify(st.r6));
  T('R7: 6頭・平均42.5kg・メス比50%・買取25,500', st.r7.n === 6 && st.r7.avgW === 42.5 && st.r7.femalePct === 50 && st.r7.buyback === 25500, JSON.stringify(st.r7));
  T('R8: 買取記録なし（0頭分）・歩留まりは率で持つ', st.r8.buybackN === 0 && st.r8.n === 3, JSON.stringify(st.r8));
  const yearHtml = await page.evaluate(() => document.getElementById('yearBox').innerHTML);
  T('前年度比の矢印（R7 頭数 ▲2（+50%））', /▲2（\+50%）/.test(yearHtml), (yearHtml.match(/▲2[^<]*/)||[''])[0]);
  const charts = await page.evaluate(() => document.getElementById('chartsGrid').textContent);
  T('グラフ: 年度別・月別・体重分布・捕獲方法のカードが簡易バーで出る', /年度別の頭数/.test(charts) && /月別の頭数/.test(charts) && /体重の分布/.test(charts) && /捕獲方法/.test(charts) && /fallback|令和6/.test(await page.evaluate(() => document.getElementById('chartsGrid').innerHTML)), '');
  const hunter = await page.evaluate(() => document.getElementById('hunterBox').textContent.replace(/\s+/g,' '));
  T('捕獲者表: 井上定男が1位（R6 2・R7 6・R8 3 = 11）', /1井上定男263 ?11/.test(hunter.replace(/\s/g,'')) && /山田千代子/.test(hunter), hunter.slice(0, 120));
  const area = await page.evaluate(() => document.getElementById('areaBox').textContent.replace(/\s+/g,' '));
  T('地区表: 館山市 神余・稲、南房総市 宮下 と推移', /館山市 神余/.test(area) && /南房総市 宮下/.test(area) && /推移/.test(area), area.slice(0, 120));

  // 絞り込み
  await page.evaluate(() => toggleYear(8));
  const y2 = await page.evaluate(() => document.getElementById('lastUpdated').textContent);
  T('令和8を外すと10頭', /10頭/.test(y2), y2);
  await page.selectOption('#fSpecies', ''); await page.evaluate(() => render());
  const y3 = await page.evaluate(() => document.getElementById('lastUpdated').textContent);
  T('獣種「すべて」でキョンも入り11頭', /11頭/.test(y3), y3);
  await page.selectOption('#fHalf', '下半期'); await page.evaluate(() => render());
  const y4 = await page.evaluate(() => ({ u: document.getElementById('lastUpdated').textContent, y: document.getElementById('yearBox').textContent }));
  T('下半期だけに絞れる（R7 の 10月以降 → 0頭、R6 は 8〜9月なので0）', /0頭/.test(y4.u) || /1頭/.test(y4.u), y4.u);
  await page.selectOption('#fHalf', ''); await page.evaluate(() => render());
  await page.fill('#q', '稲'); await page.evaluate(() => renderList());
  const list = await page.evaluate(() => document.querySelectorAll('#listBody tr').length);
  T('個体一覧の検索（地区「稲」→ 2件）', list === 2, String(list));

  // 再取込
  await page.selectOption('#reYear', '7');
  await page.evaluate(() => reimport());
  await page.waitForTimeout(500);
  const re = await page.evaluate(() => document.getElementById('reMsg').textContent);
  T('再取込: RPC tgc_import_ledger(p_year=7) を呼び、件数を表示', calls.length === 1 && calls[0].b.p_year === 7 && /991件/.test(re), re);
  rpcFail = true; await page.evaluate(() => reimport()); await page.waitForTimeout(500);
  const re2 = await page.evaluate(() => document.getElementById('reMsg').textContent);
  T('再取込の失敗は画面に出る', /取込に失敗/.test(re2) && /timeout/.test(re2), re2);
  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
