// 市役所向け 様式2ダウンロードページ（yoshiki2.html）
// ①合言葉ゲート ②イノシシ以外を期間で取得→一覧 ③1個体=1枚の様式2を描画 ④除外トグル
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/yoshiki2.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9093);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));

  const REC = [
    { label_id: 'TGC-08-キ055', serial_number: 55, species: 'キョン', capture_date: '2026-09-02', capture_time: '09:35',
      weather: '晴', capture_city: '南房総市', capture_area: '和田町黒岩', hunter_name: '加藤茂', hunter_health_ok: true,
      hunter_health_issues: '', capture_method: 'くくり罠', trap_part: '右前足', finishing_method: 'ナイフ', hit_location: '',
      capture_anomalies: '', organ_anomalies: '', sex: 'メス', weight_total: '7.1', age_estimate: null, bleed_time: '09:45',
      gutting: '無', cooling_method: null, transport_start: '10:05', receive_time: '10:43', quality: '良', recorder: '今泉貴雄',
      butcher_staff: null, memo: '', special_notes: null, stomach_note: null },
    { label_id: 'TGC-08-ア017', serial_number: 17, species: 'アライグマ', capture_date: '2026-09-05', capture_time: '06:30',
      weather: '曇', capture_city: '館山市', capture_area: '洲宮', hunter_name: '川口哲雄', hunter_health_ok: true,
      hunter_health_issues: '', capture_method: '箱罠', trap_part: null, finishing_method: '電気', hit_location: '',
      capture_anomalies: '脱毛', organ_anomalies: '', sex: 'オス', weight_total: '4.1', age_estimate: 2, bleed_time: '07:40',
      gutting: '無', cooling_method: null, transport_start: '08:00', receive_time: '08:19', quality: '良', recorder: '沖浩志',
      butcher_staff: null, memo: 'テスト備考', special_notes: null, stomach_note: null },
    // 除外されるべき：テストデータ・仮登録（番号未確定）
    { label_id: 'TGC-TEST-02', serial_number: null, species: 'シカ', capture_date: '2026-09-04', capture_time: '08:00',
      hunter_name: 'テスト捕獲者', capture_city: '南房総市', capture_area: '和田町黒岩', species_dummy: 1 },
    { label_id: '仮-MRW1ZV1D', serial_number: null, species: 'シカ', capture_date: '2026-09-06', capture_time: '10:00',
      hunter_name: '沖浩志', capture_city: '館山市', capture_area: '江田' },
  ];

  const ctx = await b.newContext({ viewport: { width: 1000, height: 900 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  // Supabase REST をモック
  let lastQuery = '';
  await p.route('**/rest/v1/individuals**', route => {
    lastQuery = decodeURIComponent(route.request().url());
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(REC) });
  });

  // --- ① ゲート（合言葉なし） ---
  await p.goto('http://localhost:9093/yoshiki2.html'); await p.waitForTimeout(300);
  const gate = await p.evaluate(() => ({
    gateShown: document.getElementById('gate').style.display === 'block',
    appHidden: document.getElementById('app').style.display !== 'block',
  }));
  ck('合言葉なしはゲート表示・本体非表示', gate.gateShown && gate.appHidden, JSON.stringify(gate));

  // 誤った合言葉
  await p.goto('http://localhost:9093/yoshiki2.html?k=wrong'); await p.waitForTimeout(300);
  const gate2 = await p.evaluate(() => document.getElementById('gate').style.display === 'block');
  ck('誤った合言葉もゲート表示', gate2);

  // --- ② 正しい合言葉 → 本体・自動読み込み ---
  await p.goto('http://localhost:9093/yoshiki2.html?k=918fwmnzbi'); await p.waitForTimeout(600);
  const app = await p.evaluate(() => ({
    appShown: document.getElementById('app').style.display === 'block',
    count: document.getElementById('count').textContent,
    listLen: document.querySelectorAll('#list li').length,
    sheetLen: document.querySelectorAll('#sheets .sheet').length,
    toolsShown: document.getElementById('tools').style.display !== 'none',
  }));
  ck('正しい合言葉で本体表示', app.appShown);
  ck('該当2頭の件数表示', app.count.includes('2'), app.count);
  ck('一覧2行', app.listLen === 2, String(app.listLen));
  ck('様式2が2枚', app.sheetLen === 2, String(app.sheetLen));
  ck('印刷ツールバー表示', app.toolsShown);

  // 取得クエリが「イノシシ以外」で期間指定
  ck('クエリがspecies!=イノシシ', /species=neq\.イノシシ/.test(lastQuery), lastQuery.slice(0, 200));
  ck('クエリが期間gte/lte', /capture_date=gte\./.test(lastQuery) && /capture_date=lte\./.test(lastQuery), lastQuery.slice(0, 200));
  ck('クエリでTEST・仮を除外', /label_id=not\.like\.TGC-TEST/.test(lastQuery) && /label_id=not\.like\.(仮|%E4)/.test(lastQuery), lastQuery.slice(0, 400));

  // テスト・仮登録・番号未確定は一覧にも様式2にも出さない（クライアント側の安全網）
  const allText = await p.evaluate(() => document.getElementById('sheets').textContent + '||' + document.getElementById('list').textContent);
  ck('テストデータを表示しない', !allText.includes('テスト捕獲者') && !allText.includes('TGC-TEST'), allText.slice(0, 80));
  ck('仮登録を表示しない', !allText.includes('仮-'), allText.slice(0, 80));

  // --- ③ 様式2の中身 ---
  const sheet0 = await p.evaluate(() => document.querySelectorAll('#sheets .sheet')[0].textContent);
  ck('タイトル 捕獲個体管理台帳', sheet0.includes('捕獲個体管理台帳'));
  ck('キョンが その他 に入る', sheet0.includes('キョン'));
  ck('個体管理番号 TGC-08-キ055', sheet0.includes('TGC-08-キ055'));
  ck('捕獲者 加藤茂', sheet0.includes('加藤茂'));
  ck('体重 7.1', sheet0.includes('7.1'));
  ck('放血時刻の表記', sheet0.includes('放血時刻'));
  ck('異常確認11項目', sheet0.includes('足取りがおぼつかないもの') && sheet0.includes('その他、外見上明らかな異常が見られるもの'));
  // 選択マーク（.sel）が付いていること
  const sel0 = await p.evaluate(() => [...document.querySelectorAll('#sheets .sheet')[0].querySelectorAll('.sel')].map(s => s.textContent));
  ck('メスが選択', sel0.includes('メス'), sel0.join(','));
  ck('くくりわなが選択', sel0.includes('くくりわな'), sel0.join(','));
  ck('南房総市が選択', sel0.includes('南房総市'), sel0.join(','));
  ck('放血 有 が選択', sel0.includes('有'), sel0.join(','));

  // 2枚目：脱毛の異常 → ☑ が1つ、箱罠→はこわな、電気止めさし
  const sheet1sel = await p.evaluate(() => {
    const s = document.querySelectorAll('#sheets .sheet')[1];
    return { checks: (s.textContent.match(/☑/g) || []).length, txt: s.textContent };
  });
  ck('脱毛あり個体で☑が1つ', sheet1sel.checks === 1, String(sheet1sel.checks));
  ck('箱罠→はこわな選択', [...(await p.evaluate(() => [...document.querySelectorAll('#sheets .sheet')[1].querySelectorAll('.sel')].map(s => s.textContent)))].includes('はこわな'));

  // --- ④ 除外トグル ---
  const excl = await p.evaluate(() => {
    const cb = document.querySelector('.exq'); cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true }));
    return document.querySelectorAll('#sheets .sheet')[0].classList.contains('excluded');
  });
  ck('除外トグルで excluded クラス', excl);

  ck('JSエラーなし', errs.length === 0, errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
