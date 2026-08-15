// 捕獲票: 捕獲者ファースト＋「いつもの」候補・個体番号非表示・搬入一覧の当日通し番号
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/capture-form.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9080);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));

  // 加藤茂の過去データ: 神余(くくり罠/ナイフ) 多め、箱罠/銃 少数
  const HIST = [];
  for (let i = 0; i < 6; i++) HIST.push({ capture_city: '館山市', capture_area: '神余', capture_method: 'くくり罠', finishing_method: 'ナイフ' });
  HIST.push({ capture_city: '南房総市', capture_area: '和田町黒岩', capture_method: '箱罠', finishing_method: '銃' });
  HIST.push({ capture_city: '南房総市', capture_area: '和田町黒岩', capture_method: 'くくり罠', finishing_method: 'ナイフ' });

  const LIST = [
    { id: 'a', label_id: 'TGC-08-T272', serial_number: 458, species: 'イノシシ', capture_date: '2026-08-14', hunter_name: '加藤茂', created_at: '2026-08-14T00:05:00Z', receive_time: '09:00', weight_total: 34, quality: '良' },
    { id: 'b', label_id: 'TGC-08-シ012', species: 'シカ', capture_date: '2026-08-14', hunter_name: '白石秀一', created_at: '2026-08-14T00:02:00Z', receive_time: '08:30', weight_total: 21, quality: '可' },
    { id: 'c', label_id: 'TGC-08-M170', serial_number: 459, species: 'イノシシ', capture_date: '2026-08-14', hunter_name: '沖浩志', created_at: '2026-08-14T00:09:00Z', receive_time: '10:00', weight_total: 40, quality: '良' },
  ];
  await p.route('**/rest/v1/**', async route => {
    const url = decodeURIComponent(route.request().url()); const m = route.request().method();
    const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    if (url.includes('/area_master')) return j([{ city: '館山市', district: '豊房', oaza: '神余' }, { city: '南房総市', district: '和田', oaza: '和田町黒岩' }]);
    if (url.includes('/app_settings')) return j([{ value: { serial_start: 458, label_start_T: 272, label_start_M: 170 } }]);
    if (url.includes('/individuals') && m === 'GET') {
      if (url.includes('hunter_name=eq.')) return j(HIST);          // loadUsual
      if (url.includes('capture_date=eq.')) return j(LIST);         // loadList
      return j([]);                                                 // 採番系
    }
    return j([]);
  });
  await p.goto('http://localhost:9080/capture-form.html'); await p.waitForTimeout(500);

  // 1) 個体番号の行は非表示
  ck('個体番号の行は非表示', await p.evaluate(() => document.getElementById('serialRow').style.display === 'none'));

  // 2) 捕獲者名が最初のセクション、健康状態・止めさし方法も上部
  const order = await p.evaluate(() => {
    const heads = [...document.querySelectorAll('#panel-form .section-head')].map(h => h.textContent.trim());
    const firstSec = document.getElementById('hunterName').closest('.section');
    const firstHead = firstSec.querySelector('.section-head').textContent.trim();
    return {
      firstHead,
      healthInFirst: !!firstSec.querySelector('[data-field="hunter_health"]'),
      finishInFirst: !!firstSec.querySelector('[data-field="finishing_method"]'),
      finisherInFirst: !!firstSec.querySelector('#finisherName'),
      heads,
    };
  });
  ck('捕獲者名が最初のセクション', order.firstHead.includes('捕獲者'), order.firstHead);
  ck('健康状態が上部セクションにある', order.healthInFirst);
  ck('止めさし方法が上部セクションにある', order.finishInFirst);
  ck('止め刺し者が上部セクションにある', order.finisherInFirst);

  // 3) 捕獲者名を選ぶと「いつもの」候補が出て最頻を自動入力
  await p.evaluate(() => { const el = document.getElementById('hunterName'); el.value = '加藤茂'; onHunterPicked(); });
  await p.waitForTimeout(600);
  const usual = await p.evaluate(() => ({
    panelShown: document.getElementById('usualPanel').style.display !== 'none',
    areas: [...document.querySelectorAll('#usualAreas .usual-chip')].map(c => c.dataset.val),
    methods: [...document.querySelectorAll('#usualMethods .usual-chip')].map(c => c.dataset.val),
    finish: [...document.querySelectorAll('#usualFinish .usual-chip')].map(c => c.dataset.val),
    autoArea: document.getElementById('captureArea').value,
    autoMethod: state.capture_method,
    autoFinish: state.finishing_method,
  }));
  ck('いつもの候補パネルが出る', usual.panelShown, JSON.stringify(usual));
  ck('捕獲場所チップ先頭が最頻(神余)', usual.areas[0] === '館山市 神余', JSON.stringify(usual.areas));
  ck('捕獲方法チップ先頭が最頻(くくり罠)', usual.methods[0] === 'くくり罠', JSON.stringify(usual.methods));
  ck('止めさし方法チップ先頭が最頻(ナイフ)', usual.finish[0] === 'ナイフ', JSON.stringify(usual.finish));
  ck('最頻の捕獲場所を自動入力(神余)', usual.autoArea === '神余', usual.autoArea);
  ck('最頻の捕獲方法を自動入力(くくり罠)', usual.autoMethod === 'くくり罠', usual.autoMethod);
  ck('最頻の止めさし方法を自動入力(ナイフ)', usual.autoFinish === 'ナイフ', usual.autoFinish);

  // 4) チップをタップすると別の候補に切替（箱罠→捕獲方法が箱罠に）
  const tapped = await p.evaluate(() => {
    const chips = [...document.querySelectorAll('#usualMethods .usual-chip')];
    const hako = chips.find(c => c.dataset.val === '箱罠'); if (hako) hako.click();
    return { method: state.capture_method, activeChip: document.querySelector('#usualMethods .usual-chip.active')?.dataset.val };
  });
  ck('チップタップで捕獲方法を切替(箱罠)', tapped.method === '箱罠' && tapped.activeChip === '箱罠', JSON.stringify(tapped));

  // 4b) いつものが使えるとき、後ろの選択トグル（捕獲方法・止めさし方法）は畳まれる
  const collapsed = await p.evaluate(() => ({
    method: document.getElementById('methodRow').style.display === 'none',
    finish: document.getElementById('finishRow').style.display === 'none',
  }));
  ck('いつもの時: 捕獲方法トグルは畳む', collapsed.method, JSON.stringify(collapsed));
  ck('いつもの時: 止めさし方法トグルは畳む', collapsed.finish, JSON.stringify(collapsed));
  // 「別の方法を選ぶ」で開く
  const opened = await p.evaluate(() => {
    pickNewMethod(); pickNewFinish();
    return {
      method: document.getElementById('methodRow').style.display !== 'none',
      finish: document.getElementById('finishRow').style.display !== 'none',
    };
  });
  ck('別の方法: 捕獲方法トグルが開く', opened.method, JSON.stringify(opened));
  ck('別の方法: 止めさし方法トグルが開く', opened.finish, JSON.stringify(opened));

  // 5) 搬入一覧の当日通し番号（到着=created_at順、種別関係なし）
  await p.evaluate(() => document.querySelector('[data-tab="list"]').click());
  await p.waitForTimeout(400);
  const nums = await p.evaluate(() => {
    // カードは receive_time.desc（LISTの並び）だが、当日番号は created_at 昇順
    const cards = [...document.querySelectorAll('#cardList .card')];
    return cards.map(c => ({ no: c.querySelector('.day-no').textContent, label: c.querySelector('.card-label').textContent }));
  });
  // created_at: b(00:02)=1, a(00:05)=2, c(00:09)=3
  const byLabel = {}; nums.forEach(n => { byLabel[n.label.replace(/^#\d+\s*/, '')] = n.no; });
  ck('当日番号: シ012=1(最先着)', byLabel['TGC-08-シ012'] === '1', JSON.stringify(nums));
  ck('当日番号: T272=2', byLabel['TGC-08-T272'] === '2', JSON.stringify(nums));
  ck('当日番号: M170=3', byLabel['TGC-08-M170'] === '3', JSON.stringify(nums));
  ck('当日番号は種別関係なし（シカもイノシシも連番）', new Set(Object.values(byLabel)).size === 3);

  ck('JSエラーなし', errs.length === 0, errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
