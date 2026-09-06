// 捕獲条件分析（catch-analysis.html）：
//   月相は日付だけから計算でき、既知の新月/満月の日に合うこと。
//   捕獲0の日も含めた「日別」を組み立て、月相・天気ごとの1日あたり捕獲数・クロス集計・相関を出すこと。
//   気象APIが落ちても月相・曜日・月の分析は出て、失敗は画面に出ること（サイレント失敗を作らない）。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = []; const ck = (n, c, g) => results.push([n, c, g]);

  // ── 疑似データ ──
  // 2026-08-01〜08-20 の20日。偶数日は雨15mmで3頭、奇数日は晴れで1頭（08-07だけ0頭）。
  const FROM = '2026-08-01', TO = '2026-08-20';
  const caps = [];
  for (let d = 1; d <= 20; d++) {
    const date = `2026-08-${String(d).padStart(2, '0')}`;
    const n = d % 2 === 0 ? 3 : (d === 7 ? 0 : 1);
    for (let i = 0; i < n; i++) caps.push({ label_id: `TGC-08-T${d}${i}`, species: 'イノシシ', capture_date: date, capture_method: i === 0 ? '箱罠' : 'くくり罠', capture_city: '館山市', capture_area: '稲', weight_total: 40, sex: 'オス' });
  }
  caps.push({ label_id: 'TGC-TEST-1', species: 'イノシシ', capture_date: '2026-08-02', capture_method: '箱罠', capture_city: '館山市' }); // 除外されるべき
  caps.push({ label_id: 'TGC-08-シ001', species: 'シカ', capture_date: '2026-08-03', capture_method: 'くくり罠', capture_city: '南房総市' }); // 種類フィルタで除外

  const days = (a, b) => { const out = []; for (let t = Date.UTC(...a.split('-').map((x, i) => i === 1 ? +x - 1 : +x)); t <= Date.UTC(...b.split('-').map((x, i) => i === 1 ? +x - 1 : +x)); t += 86400000) out.push(new Date(t).toISOString().slice(0, 10)); return out; };
  const wxJson = (start, end) => {
    const ds = days(start, end);
    const daily = { time: ds, temperature_2m_max: [], temperature_2m_min: [], temperature_2m_mean: [], precipitation_sum: [], wind_speed_10m_max: [], daylight_duration: [], weather_code: [] };
    const hourly = { time: [], pressure_msl: [], relative_humidity_2m: [] };
    ds.forEach(d => {
      const day = Number(d.slice(8, 10)); const rain = day % 2 === 0;
      daily.temperature_2m_max.push(30 + (day % 3)); daily.temperature_2m_min.push(24); daily.temperature_2m_mean.push(27);
      daily.precipitation_sum.push(rain ? 15 : 0); daily.wind_speed_10m_max.push(18); daily.daylight_duration.push(13.5 * 3600); daily.weather_code.push(rain ? 61 : 1);
      for (let h = 0; h < 24; h++) { hourly.time.push(`${d}T${String(h).padStart(2, '0')}:00`); hourly.pressure_msl.push(d === '2026-08-05' ? 1000 : 1010); hourly.relative_humidity_2m.push(70); }
    });
    return { latitude: 35, longitude: 139.875, timezone: 'Asia/Tokyo', daily, hourly };
  };

  const wxCalls = [];
  const setupRoutes = async (page, { weatherFails } = {}) => {
    await page.route('**/*', rt => {
      const url = decodeURIComponent(rt.request().url());
      const J = (x, st) => rt.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(x) });
      if (url.startsWith('file:')) return rt.continue();
      if (/cdnjs|jsdelivr|fonts\./.test(url)) return rt.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
      if (/\/rest\/v1\/individuals/.test(url)) return J(caps);
      if (/open-meteo\.com/.test(url)) {
        wxCalls.push(url);
        if (weatherFails) return rt.abort('failed');
        const u = new URL(url);
        if (/archive-api/.test(url)) return J(wxJson(u.searchParams.get('start_date'), u.searchParams.get('end_date')));
        // 予報API（past_days）: 直近分を返す。テストでは今日基準で past_days 分
        const pd = Number(u.searchParams.get('past_days') || 7); const today = new Date(); const end = today.toISOString().slice(0, 10);
        const start = new Date(today.getTime() - pd * 86400000).toISOString().slice(0, 10);
        return J(wxJson(start, end));
      }
      return J([]);
    });
  };

  // ── ページ1：通常経路 ──
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await setupRoutes(page);
  await page.goto('file://' + path.resolve(__dirname, '../../catch-analysis.html'));
  await page.waitForTimeout(700);

  // 月相：既知の日で確認（2024-04-08 皆既日食＝新月、2025-03-14 皆既月食＝満月、2000-01-06 基準新月）
  const moon = await page.evaluate(() => ({ a: moonInfo('2024-04-08'), b: moonInfo('2025-03-14'), c: moonInfo('2000-01-06'), d: moonInfo('2026-09-05') }));
  ck('月相: 2024-04-08（皆既日食の日）が新月', moon.a.idx === 0 && moon.a.illum < 0.05, JSON.stringify(moon.a));
  ck('月相: 2025-03-14（皆既月食の日）が満月', moon.b.idx === 4 && moon.b.illum > 0.95, JSON.stringify(moon.b));
  ck('月相: 2000-01-06（基準新月）が新月', moon.c.idx === 0, JSON.stringify(moon.c));
  ck('月相: 名前と輝面比が返る', typeof moon.d.name === 'string' && moon.d.illum >= 0 && moon.d.illum <= 1, JSON.stringify(moon.d));

  // 初期状態：種類はイノシシ、期間はデータ範囲で自動セット
  const init = await page.evaluate(() => ({ sp: document.getElementById('fSpecies').value, from: document.getElementById('fFrom').value, to: document.getElementById('fTo').value, methods: [...document.getElementById('fMethod').options].map(o => o.value) }));
  ck('初期: 種類はイノシシ', init.sp === 'イノシシ', JSON.stringify(init));
  ck('初期: 期間はデータの範囲', init.from === FROM && init.to === TO, JSON.stringify(init));
  ck('初期: 捕獲方法の選択肢がデータから作られる', init.methods.includes('箱罠') && init.methods.includes('くくり罠'), JSON.stringify(init.methods));

  await page.evaluate(() => runAnalysis());
  await page.waitForTimeout(600);

  const st = await page.evaluate(() => ({ cls: document.getElementById('statusBar').className, text: document.getElementById('statusBar').textContent }));
  ck('気象取得が成功すればinfo表示', /info/.test(st.cls), st.text);
  ck('アーカイブAPIを呼ぶ（予報APIは期間が古いので呼ばない）', wxCalls.some(u => /archive-api/.test(u)) && !wxCalls.some(u => /api\.open-meteo\.com\/v1\/forecast/.test(u)), wxCalls.join(' | '));

  const res = await page.evaluate(() => lastResult);
  const daily = await page.evaluate(() => lastDaily);
  ck('日別: 捕獲0の日も含めて20日になる', daily.length === 20, String(daily.length));
  ck('日別: テスト個体と他種は除外され合計39頭', res.total === 39, String(res.total));
  ck('日別: 08-07は0頭', daily.find(r => r.date === '2026-08-07').captures === 0, '');
  ck('気象: 全日そろう', res.wxDays === 20, String(res.wxDays));
  const d5 = daily.find(r => r.date === '2026-08-05'), d6 = daily.find(r => r.date === '2026-08-06'), d3 = daily.find(r => r.date === '2026-08-03');
  ck('気圧: 時別24個の平均が日別になる', Math.abs(d5.pressure - 1000) < 0.01 && Math.abs(d6.pressure - 1010) < 0.01, JSON.stringify({ d5: d5.pressure, d6: d6.pressure }));
  ck('気圧変化: 前日比が出る（05は−10、06は+10）', Math.abs(d5.pressureDelta + 10) < 0.01 && Math.abs(d6.pressureDelta - 10) < 0.01, JSON.stringify({ d5: d5.pressureDelta, d6: d6.pressureDelta }));
  ck('前日の雨: 03の前日(02)は15mm', d3.precipPrev === 15, String(d3.precipPrev));
  ck('雨からの日数: 02=当日0、03=1日後', daily.find(r => r.date === '2026-08-02').daysSinceRain === 0 && d3.daysSinceRain === 1, '');
  ck('天気カテゴリ: code61→雨、code1→晴れ', d6.wxCat === '雨' && d5.wxCat === '晴れ', JSON.stringify({ d5: d5.wxCat, d6: d6.wxCat }));

  const rainCat = res.cats.find(c => c.key === 'rain');
  const gNone = rainCat.groups.find(g => /なし/.test(g.label)), gRain = rainCat.groups.find(g => /^雨/.test(g.label));
  ck('区分: 雨なしの日は0.9頭／日', gNone && gNone.days === 10 && Math.abs(gNone.mean - 0.9) < 0.001, JSON.stringify(gNone));
  ck('区分: 雨(10〜30)の日は3.0頭／日', gRain && gRain.days === 10 && Math.abs(gRain.mean - 3.0) < 0.001, JSON.stringify(gRain));
  ck('ランキング: 最小日数(5日)未満の条件は載らない', res.ranked.every(r => r.days >= 5) && res.ranked.length > 0, JSON.stringify(res.ranked.slice(0, 3)));
  ck('ランキング: 1位は雨の日（3.0頭／日・平均比>1）', res.ranked[0].mean === 3 && res.ranked[0].index > 1, JSON.stringify(res.ranked[0]));
  const corrRain = res.corr.find(c => /当日の雨/.test(c.label));
  ck('相関: 当日の雨と捕獲数は正の相関（r>0.5, n=20）', corrRain.r > 0.5 && corrRain.n === 20, JSON.stringify(corrRain));
  ck('クロス集計: 月相×雨のセルがある', Object.keys(res.cross).length > 0 && Object.values(res.cross).every(c => c.days > 0), String(Object.keys(res.cross).length));

  const ui = await page.evaluate(() => ({
    rank: document.getElementById('rankBox').innerHTML, cross: document.getElementById('crossBox').innerHTML,
    charts: document.getElementById('chartsGrid').innerHTML, dailyRows: document.querySelectorAll('#dailyBody tr').length,
    csvBtn: document.getElementById('btnCsv').disabled, kpi: document.getElementById('kpiTotal').textContent,
  }));
  ck('画面: ランキング表が描画される', /多い順/.test(ui.rank) && /雨/.test(ui.rank), '');
  ck('画面: クロス集計表が描画される', /月相 ＼ 当日の雨/.test(ui.cross) && /新月/.test(ui.cross), '');
  ck('画面: 月相・雨・気温・曜日のカードが出る', /月相/.test(ui.charts) && /当日の雨/.test(ui.charts) && /最高気温/.test(ui.charts) && /曜日/.test(ui.charts), '');
  ck('画面: 日別テーブルは20行', ui.dailyRows === 20, String(ui.dailyRows));
  ck('画面: KPIの頭数が39', ui.kpi === '39' && ui.csvBtn === false, ui.kpi);

  const csv = await page.evaluate(() => dailyCsv(lastDaily));
  const csvLines = csv.split('\n');
  ck('CSV: ヘッダ＋20行', csvLines.length === 21 && /^﻿?日付,曜日,捕獲頭数/.test(csvLines[0]), String(csvLines.length));
  ck('CSV: 08-05の行に気圧1000.0と気圧変化', csvLines.some(l => l.startsWith('2026-08-05,') && /,1000\.0,-10\.0,/.test(l)), csvLines.find(l => l.startsWith('2026-08-05,')));

  // 予報API経路：期間の終わりを今日にすると past_days 付きで呼ばれ、直近日が埋まる
  wxCalls.length = 0;
  const recent = await page.evaluate(async () => {
    const today = todayStr(); const from = addDays(today, -10);
    const r = await fetchWeather(from, today);
    return { problems: r.problems, has: !!r.wx[today] && r.wx[today].tmax != null, hasOld: !!r.wx[from] };
  });
  ck('直近: 予報API(past_days)で今日の分が埋まる', recent.has && recent.hasOld && recent.problems.length === 0 && wxCalls.some(u => /forecast\?.*past_days=/.test(u)), JSON.stringify({ recent, calls: wxCalls }));

  ck('pageerrorなし', errors.length === 0, errors.join(' / '));
  await page.close();

  // ── ページ2：気象APIが落ちる経路 ──
  const page2 = await browser.newContext().then(c => c.newPage());
  const errors2 = []; page2.on('pageerror', e => errors2.push(e.message));
  await setupRoutes(page2, { weatherFails: true });
  await page2.goto('file://' + path.resolve(__dirname, '../../catch-analysis.html'));
  await page2.waitForTimeout(700);
  await page2.evaluate(() => runAnalysis());
  await page2.waitForTimeout(600);
  const st2 = await page2.evaluate(() => ({ cls: document.getElementById('statusBar').className, text: document.getElementById('statusBar').textContent, wx: document.getElementById('kpiWx').textContent, charts: document.getElementById('chartsGrid').innerHTML, cross: document.getElementById('crossBox').textContent, total: document.getElementById('kpiTotal').textContent }));
  ck('気象失敗: 画面にエラーとして出る（握り潰さない）', /error/.test(st2.cls) && /取得できません/.test(st2.text), st2.text.slice(0, 80));
  ck('気象失敗: 気象データの揃いは0%', st2.wx === '0%', st2.wx);
  ck('気象失敗: 月相・曜日・月の分析は表示される', /月相/.test(st2.charts) && /曜日/.test(st2.charts) && /🗓 月/.test(st2.charts), '');
  ck('気象失敗: 天気の分析カードは出ない', !/当日の雨/.test(st2.charts) && /表示できません/.test(st2.cross), '');
  ck('気象失敗: 捕獲数の集計自体は行われる', st2.total === '39', st2.total);
  ck('pageerrorなし(気象失敗時)', errors2.length === 0, errors2.join(' / '));

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
