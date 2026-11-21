// 搬入一覧: 番号と並びを「搬入（受入）時刻」の順にする（2026-11-21 今泉さん「搬入時刻ではなく、登録順でソートしているようです」）
//
//   実測（本番 11/21）: 一覧の並びは受入時刻の降順だが、左の番号は登録時刻（created_at）で振っていた。
//     M246 は 09:13 に登録して受入時刻を 10:09 に直した個体で、一覧の一番上なのに番号は 1。並びが 1,5,4,3,2 になっていた。
//
//   ここで測ること（個体はすべて架空）
//     1. 番号は受入時刻の早い順（登録時刻ではない）。一覧は新しい搬入が上で、番号が上から N…1 と連続する
//     2. 受入時刻は文字列でなく時刻で比べる（"9:05" は "10:09" より前）。全角・「時」・4桁も読む
//     3. 受入時刻が無い個体は登録時刻で並ぶ／同じ時刻は登録時刻→通し番号の順
//     4. 前日に獲れて今日搬入した個体も、受入時刻どおりの位置に入る
//     5. ページエラーなし
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');

const today = (() => { const d = new Date(Date.now() + 9 * 3600000); return d.toISOString().slice(0, 10); })();
const yest = (() => { const d = new Date(Date.now() + 9 * 3600000 - 86400000); return d.toISOString().slice(0, 10); })();
const at = hm => new Date(`${today}T${hm}:00+09:00`).toISOString();
const R = (id, label, serial, receive, created, extra) => Object.assign({ id, label_id: label, serial_number: serial, species: 'イノシシ', capture_date: today, capture_time: '06:00', receive_time: receive, created_at: at(created), hunter_name: '架空太郎', weight_total: 30, quality: '良' }, extra || {});
// 本番 11/21 と同じ形: 先に登録して受入時刻を後から直した個体（z6）が登録は一番早い
const ROWS = [
  R('z6', 'TGC-08-M906', 906, '10:09', '09:13'),
  R('z2', 'TGC-08-M902', 902, '9:54', '09:55'),        // 先頭ゼロなし（文字で比べると 10時台より後になる）
  R('z3', 'TGC-08-M903', 903, '０９：５８', '09:58'),   // 全角
  R('z4', 'TGC-08-M904', 904, '10時00', '10:01'),
  R('z5', 'TGC-08-M905', 905, '1004', '10:05'),         // 4桁
  R('z1', 'TGC-08-T901', 901, '08:40', '10:20', { capture_date: yest }),   // 前日に獲れて今日搬入・登録は遅い
  R('z7', 'TGC-08-T907', 907, null, '10:30'),           // 受入時刻なし → 登録時刻 10:30
  R('z8', 'TGC-08-T908', 908, '10:09', '10:12'),        // z6 と同じ受入時刻 → 登録の遅いこちらが後
];
const EXPECT = ['TGC-08-T901', 'TGC-08-M902', 'TGC-08-M903', 'TGC-08-M904', 'TGC-08-M905', 'TGC-08-M906', 'TGC-08-T908', 'TGC-08-T907'];

(async () => {
  const root = path.resolve(__dirname, '../..');
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/capture-form.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9093);
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/rest/v1/**', rt => {
    const url = decodeURIComponent(rt.request().url());
    const J = x => rt.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    if (url.includes('/individuals') && rt.request().method() === 'GET' && url.includes('capture_date.eq.')) {
      // 本番と同じく、DB は受入時刻の「文字列」降順で返す（並びをページ側で直していることを測る）
      return J(ROWS.slice().sort((a, b) => String(b.receive_time || '') < String(a.receive_time || '') ? -1 : 1));
    }
    return J([]);
  });
  await page.goto('http://localhost:9093/capture-form.html'); await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector('[data-tab="list"]').click());
  await page.waitForTimeout(500);
  const cards = await page.evaluate(() => [...document.querySelectorAll('#cardList .card')].map(c => ({ no: c.querySelector('.day-no').textContent.trim(), label: (c.querySelector('.card-label').textContent.match(/TGC-08-[A-Z]\d+/) || [''])[0] })));
  const byNo = cards.slice().sort((a, b) => a.no - b.no).map(c => c.label);
  T('1. 番号は受入時刻の早い順（登録時刻ではない）', JSON.stringify(byNo) === JSON.stringify(EXPECT), JSON.stringify(byNo));
  T('1. 先に登録して受入時刻を直した個体は 1番にならない（本番 M246 の形）', cards.find(c => c.label === 'TGC-08-M906').no === '6', JSON.stringify(cards.find(c => c.label === 'TGC-08-M906')));
  T('1. 一覧は新しい搬入が上で、番号が上から 8…1 と連続する', cards.map(c => c.no).join() === '8,7,6,5,4,3,2,1', cards.map(c => c.no).join());
  T('2. "9:54"・全角・「時」・4桁の受入時刻を時刻として比べる', byNo.slice(1, 5).join() === 'TGC-08-M902,TGC-08-M903,TGC-08-M904,TGC-08-M905', byNo.slice(1, 5).join());
  T('3. 受入時刻が無い個体は登録時刻（10:30）の位置／同じ受入時刻は登録の早い順', byNo[7] === 'TGC-08-T907' && byNo.indexOf('TGC-08-M906') < byNo.indexOf('TGC-08-T908'), byNo.slice(5).join());
  T('4. 前日に獲れて今日搬入した個体も受入時刻どおり（08:40 なので 1番）', byNo[0] === 'TGC-08-T901', byNo[0]);
  const mins = await page.evaluate(() => ['9:05', '09:05', '0905', '９：０５', '9時05', '', null, '25:00', 'あ'].map(receiveMinutes));
  T('2. 受入時刻の読み取り（読めないものは null）', JSON.stringify(mins) === JSON.stringify([545, 545, 545, 545, 545, null, null, null, null]), JSON.stringify(mins));
  T('5. ページエラーなし', errors.length === 0, errors.join(' / '));
  await browser.close(); srv.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 240) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
