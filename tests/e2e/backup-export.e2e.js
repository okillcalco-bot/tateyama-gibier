// 業務データの一括保存（2026-11-24 伴走支援の指摘「業務テーブル単位の定期エクスポートが無い」「写真はDBバックアップの対象外」）
//
//   ここで測ること（データはすべて架空）
//     1. 押すと主な業務の表をまとめて1つのJSONに保存する（表ごとの行・写真の場所の一覧つき）
//     2. 1,000行を超える表も全部入る（ページ分けして読む・取りこぼさない）
//     3. 表ごとに DB の件数と照合し、合わない表・読めなかった表は赤で出す（黙って欠けたファイルにしない）
//     4. 捕獲者の口座・住所・電話はファイルに入れない（公開してよい列だけを読む）
//     5. 前回の保存日を出し、1週間以上あいたら知らせる
//     6. スマホの幅で横にはみ出さない／ページエラー・未処理の例外なし
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
const fs = require('fs');

const BIG = Array.from({ length: 2345 }, (_, i) => ({ id: 'inv-' + String(i).padStart(5, '0'), ident_code: 'TEST-' + i, status: '在庫' }));
const IND = [{ id: 'i1', label_id: 'TEST-001', image_url: 'https://example.invalid/p1.jpg' }, { id: 'i2', label_id: 'TEST-002', image_url: null }];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  await ctx.addInitScript(() => {
    try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); localStorage.setItem('tg_staff_key', 'TESTKEY');
      localStorage.setItem('tg_backup_last_v1', JSON.stringify({ at: new Date(Date.now() - 10 * 86400000).toISOString(), problems: 0 })); } catch (e) {}
    window.alert = () => {}; window.confirm = () => true; window.prompt = () => null;
    window.__rej = []; window.addEventListener('unhandledrejection', e => window.__rej.push(String(e.reason && e.reason.message || e.reason)));
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const seen = { huntersSelect: '' };
  await page.route('**/*', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    if (url.startsWith('file:')) return rt.continue();
    if (!/\/rest\/v1\//.test(url)) return rt.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    const table = url.split('/rest/v1/')[1].split('?')[0];
    const counting = (req.headers()['prefer'] || '').includes('count=exact');
    const J = (x, s, h) => rt.fulfill({ status: s || 200, contentType: 'application/json', headers: h || {}, body: JSON.stringify(x) });
    if (m !== 'GET') return J([]);
    const rowsOf = t => t === 'inventory' ? BIG : t === 'individuals' ? IND : t === 'hunters' ? [{ id: 'h1', name: '架空太郎' }] : t === 'orders' ? [{ id: 'o1' }, { id: 'o2' }] : [];
    if (table === 'receipts' || table === 'staff') return J({ message: 'permission denied for table ' + table }, 401);
    if (counting) {
      const n = table === 'orders' ? 3 : rowsOf(table).length;   // 注文だけ DB の件数が多い＝取りこぼし
      return J(rowsOf(table).slice(0, 1), 206, { 'content-range': `0-0/${n}`, 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Content-Range' });
    }
    if (table === 'hunters') seen.huntersSelect = (url.match(/select=([^&]*)/) || [])[1] || '';
    const lim = Number((url.match(/[?&]limit=(\d+)/) || [])[1] || 1000000), off = Number((url.match(/[?&]offset=(\d+)/) || [])[1] || 0);
    return J(rowsOf(table).slice(off, off + Math.min(lim, 1000)));   // 本番と同じく1回1000行まで
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(900);
  await page.evaluate(() => document.querySelector('[data-tab="datamgmt"]').click());
  await page.waitForTimeout(400);
  const last = await page.evaluate(() => document.getElementById('backup-last').innerText);
  T('5. 前回の保存日と「1週間以上」の知らせが出る', /10日前/.test(last) && /1週間以上/.test(last), last);

  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#backup-btn')]);
  await page.waitForTimeout(500);
  const file = await dl.path(); const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  T('1. 1つのJSONに保存する（ファイル名に日付）', /^tgc-backup-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()) && bundle.kind === 'tateyama-gibier-backup', dl.suggestedFilename());
  T('1. 表ごとの行が入る', Array.isArray(bundle.tables.individuals) && bundle.tables.individuals.length === 2 && bundle.summary.length >= 20, bundle.summary.length);
  T('1. 写真の場所の一覧が入る（写真のある個体だけ）', bundle.photos.length === 1 && bundle.photos[0].label_id === 'TEST-001', JSON.stringify(bundle.photos));
  T('2. 1,000行を超える表も全部入る（2,345行・重複なし）', bundle.tables.inventory.length === 2345 && new Set(bundle.tables.inventory.map(r => r.id)).size === 2345, bundle.tables.inventory.length);
  const st = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-backup-table]')].map(r => [r.dataset.backupTable, r.dataset.backupStatus])));
  T('3. 件数が一致した表は「一致」', st.inventory === 'ok' && st.individuals === 'ok', JSON.stringify({ inv: st.inventory, ind: st.individuals }));
  T('3. 件数が合わない表は「件数が合わない」', st.orders === 'mismatch', st.orders);
  T('3. 読めなかった表は「読めなかった」', st.staff === 'error', st.staff);
  const alert = await page.evaluate(() => (document.querySelector('#backup-result [role=alert]') || {}).innerText || '');
  T('3. 欠けがあれば赤い知らせで表の名前を出す', /2表が欠けています/.test(alert) && /注文/.test(alert) && /スタッフ/.test(alert), alert);
  T('4. 捕獲者は公開してよい列だけを読む（口座・住所・電話を求めない）', seen.huntersSelect && !/bank|account|address|phone/.test(seen.huntersSelect), seen.huntersSelect);
  const last2 = await page.evaluate(() => document.getElementById('backup-last').innerText);
  T('5. 保存すると前回の保存日が今日になり、問題の表の数も残る', /今日/.test(last2) && /2表に問題あり/.test(last2), last2);
  const over = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - innerWidth));
  T('6. スマホの幅で横にはみ出さない', over === 0, over);
  T('6. ページエラー・未処理の例外なし', errors.length === 0 && (await page.evaluate(() => window.__rej.length)) === 0, errors.concat(await page.evaluate(() => window.__rej)).join(' / '));
  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
