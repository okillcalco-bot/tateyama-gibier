// 放射能検査台帳（capture-report.html）: イノシシ以外の捕獲票を期間で一覧・共有
//
//   きっかけ（2026-09-10）
//     「イノシシ以外の票は期間を選ぶと、情報が一覧で確認できるようにして欲しい。
//     そのリンクを市役所へ送れば、市役所が簡単に市へ提出された捕獲票と
//     整合を取ることができるように」という要望。
//     既存の種別フィルタは value="その他" が実データのどの種別とも一致せず
//     機能していなかった（実データはシカ/アライグマ/ハクビシン等の具体名）。
//     「イノシシ以外（全種）」を追加してneqで絞り込めるようにし、
//     絞り込み条件（期間・種別）をURLに埋め込んだ共有リンクを作れるようにした。
//
//   ここで測ること
//     1. 種別フィルタに「イノシシ以外（全種）」がある
//     2. それを選んで検索すると、イノシシを除いた種別だけのクエリになる
//     3. 共有リンクのURLに期間・種別の条件が入る
//     4. そのURLで開くと、フィルタが自動的に条件通りプリフィルされる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

// このサンドボックスはcdn.jsdelivr.netへ出られないため、実際のsupabase-jsは読み込めない。
// ページのコードはsupabase.createClient(...).from(t).select().eq()等をチェーンしてから
// 最後に await するだけなので、同じチェーンAPIで実物と同じREST URL（field=eq.value等）を
// 組み立ててfetchする最小限のスタブに差し替える。page.routeで見るのは結局そのURLなので
// ページ側のクエリ組み立てロジックはそのまま検証できる。
async function stubSupabase(ctx) {
  await ctx.addInitScript(() => {
    window.supabase = {
      createClient: (url, key) => ({
        from: (table) => {
          const parts = [];
          const builder = {
            select: () => builder,
            order: (col, opts) => { parts.push('order=' + col + '.' + ((opts && opts.ascending === false) ? 'desc' : 'asc')); return builder; },
            gte: (col, v) => { parts.push(col + '=gte.' + encodeURIComponent(v)); return builder; },
            lte: (col, v) => { parts.push(col + '=lte.' + encodeURIComponent(v)); return builder; },
            eq: (col, v) => { parts.push(col + '=eq.' + encodeURIComponent(v)); return builder; },
            neq: (col, v) => { parts.push(col + '=neq.' + encodeURIComponent(v)); return builder; },
            or: (expr) => { parts.push('or=(' + expr + ')'); return builder; },
            limit: async (n) => {
              parts.push('limit=' + n);
              const res = await fetch(url + '/rest/v1/' + table + '?select=*&' + parts.join('&'), { headers: { apikey: key, Authorization: 'Bearer ' + key } });
              if (!res.ok) return { data: null, error: { message: 'HTTP ' + res.status } };
              return { data: await res.json(), error: null };
            },
          };
          return builder;
        },
      }),
    };
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx1 = await browser.newContext();
  await stubSupabase(ctx1);
  const page = await ctx1.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { await d.dismiss(); });

  const RECORDS = [
    { id: 'i1', serial_number: 1, label_id: 'TGC-08-T001', capture_date: '2026-08-01', species: 'イノシシ', origin: '館山市', capture_city: '館山市', weight_total: 40, hunter_name: '猟師A', quality: '良', recorder: '記録者A' },
    { id: 'i2', serial_number: 2, label_id: 'TGC-08-S001', capture_date: '2026-08-02', species: 'シカ', origin: '館山市', capture_city: '館山市', weight_total: 30, hunter_name: '猟師B', quality: '良', recorder: '記録者B' },
    { id: 'i3', serial_number: 3, label_id: 'TGC-08-A001', capture_date: '2026-08-03', species: 'アライグマ', origin: '南房総市', capture_city: '南房総市', weight_total: 5, hunter_name: '猟師C', quality: '良', recorder: '記録者C' },
  ];

  const requestedUrls = [];
  await page.route('**/rest/v1/individuals**', rt => {
    requestedUrls.push(decodeURIComponent(rt.request().url()));
    const url = decodeURIComponent(rt.request().url());
    let data = RECORDS;
    if (/species=neq\.イノシシ/.test(url)) data = RECORDS.filter(r => r.species !== 'イノシシ');
    else if (/species=eq\.([^&]+)/.test(url)) {
      const m = url.match(/species=eq\.([^&]+)/);
      data = RECORDS.filter(r => r.species === m[1]);
    }
    rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  await page.goto('file://' + path.resolve(__dirname, '../../capture-report.html'));
  await page.waitForTimeout(600);

  // 1) 「イノシシ以外（全種）」の選択肢がある
  const opts = await page.$$eval('#speciesFilter option', els => els.map(e => e.value));
  T('「イノシシ以外（全種）」の選択肢がある', opts.includes('__not_boar__'), JSON.stringify(opts));

  // 2) 選んで検索するとneqクエリになり、シカ・アライグマだけ表示される
  requestedUrls.length = 0;
  await page.selectOption('#speciesFilter', '__not_boar__');
  await page.click('button:has-text("🔍 検索")');
  await page.waitForTimeout(300);
  T('neq(イノシシ)のクエリが飛ぶ', requestedUrls.some(u => /species=neq\.イノシシ/.test(u)), requestedUrls.join(' / '));
  const bodyText = await page.$eval('#tableContainer', el => el.textContent);
  T('イノシシ以外の2件だけ表示される', bodyText.includes('シカ') && bodyText.includes('アライグマ') && !bodyText.includes('イノシシ'), bodyText.replace(/\s+/g, ' ').slice(0, 200));

  // 3) 共有リンクに期間・種別が入る
  await page.fill('#dateFrom', '2026-08-01');
  await page.fill('#dateTo', '2026-08-31');
  const shareUrl = await page.evaluate(() => buildShareUrl());
  T('共有リンクに期間が入る', shareUrl.includes('from=2026-08-01') && shareUrl.includes('to=2026-08-31'), shareUrl);
  T('共有リンクに種別(イノシシ以外)が入る', shareUrl.includes('species=__not_boar__'), shareUrl);

  // 4) そのURLで開くとフィルタが自動でプリフィルされる
  const ctx2 = await browser.newContext();
  await stubSupabase(ctx2);
  const page2 = await ctx2.newPage();
  await page2.route('**/rest/v1/individuals**', rt => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(RECORDS.filter(r => r.species !== 'イノシシ')) }));
  await page2.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));
  await page2.goto('file://' + path.resolve(__dirname, '../../capture-report.html') + '?from=2026-08-01&to=2026-08-31&species=__not_boar__');
  await page2.waitForTimeout(500);
  const preset = await page2.evaluate(() => ({
    from: document.getElementById('dateFrom').value,
    to: document.getElementById('dateTo').value,
    species: document.getElementById('speciesFilter').value,
  }));
  T('リンクを開くと期間がプリフィルされる', preset.from === '2026-08-01' && preset.to === '2026-08-31', JSON.stringify(preset));
  T('リンクを開くと種別がプリフィルされる', preset.species === '__not_boar__', JSON.stringify(preset));
  const preloadedText = await page2.$eval('#tableContainer', el => el.textContent);
  T('リンクを開いた時点で既に絞り込み後の一覧が出ている', preloadedText.includes('シカ') && !preloadedText.includes('TGC-08-T001'), preloadedText.replace(/\s+/g, ' ').slice(0, 200));
  await page2.close();

  T('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
