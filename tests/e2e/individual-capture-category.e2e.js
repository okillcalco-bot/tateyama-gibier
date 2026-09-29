// 個体の「捕獲区分」: 駆除外（個人宅など）の個体を、駆除の番号・市役所提出から分ける（2026-09-28）
//
//   きっかけ
//     アライグマは駆除の個体を登録・市役所へ報告しているが、個人宅で捕獲された個体（駆除ではない）を
//     食用で出荷したい。同じ登録に混ぜると、駆除の頭数・番号列（市役所の紙台帳と一致させている
//     TGC-08-ア001〜）に紛れてしまう。
//
//   ここで測ること
//     1. 個体登録で「駆除外」＋アライグマを選ぶと、別の番号列 TGC-08-アコNNN を案内する
//     2. 保存すると capture_category='駆除外' が送られる（駆除は null）
//     3. 駆除外なのに駆除の番号（ア025）で保存しようとすると警告が出る
//     4. 個体一覧に「駆除外」の印が出る
//     5. 市役所用票作成の検索候補に駆除外が出ない
//     6. 捕獲票一覧（capture-report）で駆除外を除き、除いた件数を画面に出す
//     7. 様式2（yoshiki2）に駆除外を出さない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');

const PRIVATE = { id: 'p1', label_id: 'TGC-08-アコ001', serial_number: null, species: 'アライグマ', capture_category: '駆除外', capture_date: '2026-09-22', sex: 'メス', weight_total: 4.0, capture_city: '館山市', hunter_name: null };
const CULL = { id: 'c1', label_id: 'TGC-08-ア024', serial_number: 24, species: 'アライグマ', capture_category: null, capture_date: '2026-09-20', sex: 'オス', weight_total: 5.0, capture_city: '館山市', capture_area: '洲宮', hunter_name: '川口哲雄' };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);
  const errors = [];

  // ── index.html: 個体登録フォーム ──
  {
    const page = await browser.newContext().then(c => c.newPage());
    page.on('pageerror', e => errors.push('index: ' + e.message));
    let posted = null; const gets = [];
    await page.route('**/rest/v1/**', rt => {
      const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
      const J = x => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
      if (m === 'POST' && /\/individuals/.test(url)) { try { posted = JSON.parse(req.postData() || '{}'); } catch (e) {} return J([{}]); }
      if (m === 'GET' && /\/individuals/.test(url)) {
        gets.push(url);
        if (/label_id=like\.TGC-08-アコ/.test(url)) return J([]);
        if (/order=capture_date\.desc,serial_number\.desc&limit=15/.test(url)) return J([CULL, PRIVATE]);
        return J([]);
      }
      return J([]);
    });
    await page.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
    await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
    await page.waitForTimeout(700);

    // 1) 駆除外＋アライグマ → アコ001 を案内
    await page.evaluate(() => { indOpenNew(); });
    await page.waitForTimeout(200);
    await page.selectOption('#ind-f-species', 'アライグマ');
    await page.selectOption('#ind-f-capture_category', '駆除外');
    await page.waitForTimeout(300);
    const hint = await page.$eval('#ind-next-hint', el => el.innerText);
    T('駆除外＋アライグマで TGC-08-アコ001 を案内', hint.includes('TGC-08-アコ001'), hint);
    T('駆除外の番号は駆除の番号列（ア）を検索しない', gets.some(u => /like\.TGC-08-アコ/.test(u)), gets.join(' / ').slice(0, 300));
    await page.click('#ind-next-hint button');
    const lid = await page.$eval('#ind-f-label_id', el => el.value);
    const ser = await page.$eval('#ind-f-serial_number', el => el.value);
    T('ボタンで番号が入り、通し番号は空のまま', lid === 'TGC-08-アコ001' && ser === '', lid + ' / serial=' + ser);

    // 2) 保存 → capture_category='駆除外'
    const confirms = [];
    await page.evaluate(() => { window.__c = []; window.confirm = m => { window.__c.push(m); return true; }; window.alert = m => window.__c.push('ALERT:' + m); });
    await page.fill('#ind-f-capture_date', '2026-09-22');
    await page.selectOption('#ind-f-sex', 'メス');
    await page.fill('#ind-f-weight_total', '4.0');
    await page.evaluate(() => indSave());
    await page.waitForTimeout(400);
    const c1 = await page.evaluate(() => window.__c.join('\n'));
    T('保存すると capture_category=駆除外 が送られる', posted && (Array.isArray(posted) ? posted[0] : posted).capture_category === '駆除外', JSON.stringify(posted).slice(0, 200));
    T('正しい番号なら番号の警告は出ない', !/駆除外なのに/.test(c1), c1.slice(0, 200));

    // 3) 駆除外なのに駆除の番号 → 警告
    posted = null;
    await page.evaluate(() => { indOpenNew(); window.__c = []; window.confirm = m => { window.__c.push(m); return false; }; });
    await page.waitForTimeout(150);
    await page.selectOption('#ind-f-species', 'アライグマ');
    await page.selectOption('#ind-f-capture_category', '駆除外');
    await page.fill('#ind-f-label_id', 'TGC-08-ア025');
    await page.evaluate(() => indSave());
    await page.waitForTimeout(300);
    const c2 = await page.evaluate(() => window.__c.join('\n'));
    T('駆除外なのに駆除の番号だと警告が出る', /駆除外なのに駆除の番号/.test(c2), c2.slice(0, 200));
    T('警告でキャンセルすると保存しない', posted === null, JSON.stringify(posted));

    // 駆除の個体は null を送る（従来どおり）
    posted = null;
    await page.evaluate(() => { indOpenNew(); window.confirm = () => true; });
    await page.waitForTimeout(150);
    await page.selectOption('#ind-f-species', 'アライグマ');
    await page.fill('#ind-f-label_id', 'TGC-08-ア025');
    await page.evaluate(() => indSave());
    await page.waitForTimeout(300);
    const pb = posted && (Array.isArray(posted) ? posted[0] : posted);
    T('駆除の個体は capture_category=null（従来どおり）', pb && pb.capture_category === null, JSON.stringify(pb || null).slice(0, 200));

    // 4) 一覧の印
    const cells = await page.evaluate(([a, b]) => {
      indAllData = [a, b]; indSortCol = 'label_id'; indSortAsc = true; indRender();
      return [...document.querySelectorAll('#ind-body tr')].map(tr => tr.innerText.replace(/\s+/g, ' '));
    }, [PRIVATE, CULL]);
    T('一覧で駆除外の個体に「駆除外」の印', cells.some(t => t.includes('アコ001') && t.includes('駆除外')), cells.join(' | ').slice(0, 300));
    T('駆除の個体には印が付かない', cells.some(t => t.includes('ア024') && !t.includes('駆除外')), cells.join(' | ').slice(0, 300));

    // 5) 市役所用票作成の候補
    await page.evaluate(() => { document.getElementById('cc-search').value = ''; return cityCapSearch(); });
    await page.waitForTimeout(300);
    const cand = await page.evaluate(() => cityCapResults.map(r => r.label_id));
    T('市役所用票作成の候補に駆除外が出ない', cand.includes('TGC-08-ア024') && !cand.includes('TGC-08-アコ001'), JSON.stringify(cand));
  }

  // ── capture-report.html ──
  {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => {
      window.supabase = { createClient: (url, key) => ({ from: (table) => {
        const parts = []; const b = {
          select: () => b, order: () => b, gte: () => b, lte: () => b, eq: () => b, neq: () => b, or: () => b,
          limit: async () => { const r = await fetch(url + '/rest/v1/' + table + '?select=*'); return { data: await r.json(), error: null }; } };
        return b; } }) };
    });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('capture-report: ' + e.message));
    await page.route('**/rest/v1/individuals**', rt => rt.fulfill({ contentType: 'application/json', body: JSON.stringify([CULL, PRIVATE]) }));
    await page.goto('file://' + path.resolve(__dirname, '../../capture-report.html'));
    await page.waitForTimeout(500);
    await page.evaluate(() => loadData());
    await page.waitForTimeout(300);
    const body = await page.$eval('#tableContainer', el => el.textContent);
    const status = await page.evaluate(() => document.body.innerText);
    T('捕獲票一覧に駆除の個体は出る', body.includes('ア024'), body.replace(/\s+/g, ' ').slice(0, 200));
    T('捕獲票一覧に駆除外の個体は出ない', !body.includes('アコ001'), body.replace(/\s+/g, ' ').slice(0, 200));
    T('除いた件数と番号を画面に出す（黙って消さない）', /駆除外 1件/.test(status) && status.includes('TGC-08-アコ001'), (status.match(/✅[^\n]*/) || [''])[0]);
  }

  // ── yoshiki2.html ──
  {
    const root = path.resolve(__dirname, '../..');
    const srv = http.createServer((q, r) => {
      let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/yoshiki2.html';
      r.setHeader('content-type', 'text/html; charset=utf-8');
      try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
    }).listen(9095);
    const page = await browser.newContext().then(c => c.newPage());
    page.on('pageerror', e => errors.push('yoshiki2: ' + e.message));
    let q = '';
    await page.route('**/rest/v1/individuals**', rt => { q = decodeURIComponent(rt.request().url()); rt.fulfill({ contentType: 'application/json', body: JSON.stringify([CULL, PRIVATE]) }); });
    await page.goto('http://localhost:9095/yoshiki2.html?k=918fwmnzbi');
    await page.waitForTimeout(700);
    const list = await page.$eval('#list', el => el.textContent);
    T('様式2に駆除の個体は出る', list.includes('ア024'), list.slice(0, 200));
    T('様式2に駆除外の個体は出ない', !list.includes('アコ001'), list.slice(0, 200));
    T('様式2の取得に capture_category を含める', /capture_category/.test(q), q.slice(0, 200));
    srv.close();
  }

  T('ページエラーなし', errors.length === 0, errors.join(' / '));
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
