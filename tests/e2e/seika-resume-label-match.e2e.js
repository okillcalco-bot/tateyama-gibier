// 精肉: 前日の続きを再開しても、刷ったラベルと在庫の番号が必ず一致する（2026-11-09）
//
//   事故（2026-11-09 TGC-08-シ019、10/21 シ015 も同じ）
//     前日（11/6）に精肉した個体の続きを、保存されていた作業（セッション）から再開して登録した。
//     使用済みの番号をDBから読めないまま（失敗は try/catch で黙って握り潰していた）前日と同じ番号で
//     ラベルを先に刷り、保存では番号が重なって -2 にずれた。「ラベル再印刷を押して」の警告だけでは
//     刷り直されず、10パックすべてラベルと在庫が食い違った。出荷のスキャンで「登録されていない」になった。
//       ラベル  TGC-08-SHI019-RO   / 10007155
//       在庫    TGC-08-SHI019-RO-2 / 10007156
//
//   ここで測ること（個体・番号はすべて架空）。ラベルは実際に作られたHTMLから番号を読む。
//     A1. 再開でDBが読めない: 失敗を画面に出す。登録済み一覧の番号は使用済みとして避ける。
//         ラベルは保存より先に刷らず、保存した番号で刷る → ラベルと在庫が一致
//     A2. 再開でDBが読めず、一覧にも番号が無い（重なる）: 保存で番号がずれても、ラベルはずれた後の番号で1枚だけ
//     B.  DBが読めた: 先に刷る（従来どおり）。番号は在庫と一致
//     C.  先に刷った後に、別の端末が同じ番号を使っていて番号がずれた: 正しい番号のラベルを自動で刷り直す
//     D.  登録済みパックの刷り直し（🖨）: 在庫の番号・8桁で刷る。消費期限は処理日から1年（刷り直した日からではない）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const LABEL = 'TGC-08-シ999';
const PREV = [   // 前日（11/6）の登録。RO は出荷済み、HI は在庫
  { individual_id: LABEL, ident_code: 'TGC-08-SHI999-RO', part_name: 'ロース', weight: 0.88, lot_code: 'SHI999-RO-20261106-001', scan_code: '10000050', status: '出荷済', grade: '並', processed_at: '2026-11-06T06:35:09Z', created_at: '2026-11-06T06:35:09Z', deleted_at: null },
  { individual_id: LABEL, ident_code: 'TGC-08-SHI999-HI', part_name: 'ヒレ', weight: 0.13, lot_code: 'SHI999-HI-20261106-001', scan_code: '10000051', status: '在庫', grade: '並', processed_at: '2026-11-06T06:32:07Z', created_at: '2026-11-06T06:32:07Z', deleted_at: null },
];

async function boot(browser, { failLoad = false, sessionIdents = true } = {}) {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Tokyo' });
  const sessParts = PREV.map(p => Object.assign({ part_name: p.part_name, weight_kg: p.weight, lot_code: p.lot_code }, sessionIdents ? { ident_code: p.ident_code } : {}));
  await ctx.addInitScript(([LABEL, sessParts]) => {
    try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {}
    localStorage.setItem('tgc_pm_state_v1', JSON.stringify({ held: [], savedAt: Date.now() - 2 * 86400000,
      sessions: { '架空作業者': { individual: { label_id: LABEL, species: 'シカ', weight_total: 36 }, completedParts: sessParts, selectedPart: null, boneIn: false, grade: '並', retail: false, priceMaster: [] } } }));
  }, [LABEL, sessParts]);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const dialogs = []; page.on('dialog', async d => { dialogs.push(d.message()); await d.accept(); });
  const db = { rows: PREV.map(r => Object.assign({}, r)), seq: 10000100, failLoad, posts: 0 };
  await page.route('**/*', r => {
    const req = r.request(); const u = req.url(); const m = req.method(); const dec = decodeURIComponent(u);
    if (u.startsWith('file:')) return r.continue();
    if (/jsdelivr|cdn/.test(u)) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    const J = (b, st) => r.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/rpc\/tgc_reserve_scan_codes/.test(u)) { const n = 20; const out = []; for (let i = 0; i < n; i++) out.push(String(db.seq++)); return J(out); }
    if (/\/rest\/v1\/inventory/.test(u)) {
      if (m === 'POST') {
        db.posts++;
        const b = JSON.parse(req.postData() || '{}');
        if (db.rows.some(x => x.ident_code === b.ident_code)) return J({ code: '23505', message: 'duplicate key value violates unique constraint "inventory_ident_code_key"' }, 409);
        const row = Object.assign({ deleted_at: null, status: '在庫', processed_at: new Date().toISOString(), created_at: new Date().toISOString() }, b);
        if (!row.scan_code) row.scan_code = String(db.seq++);   // DBトリガ相当
        db.rows.push(row);
        return J([row], 201);
      }
      const ic = (dec.match(/ident_code=eq\.([^&]+)/) || [])[1];
      if (ic) return J(db.rows.filter(x => x.ident_code === ic && !x.deleted_at).slice(0, 1));
      const ind = (dec.match(/individual_id=eq\.([^&]+)/) || [])[1];
      if (ind) { if (db.failLoad && /lot_code/.test(dec)) return J({ message: 'network error' }, 503); return J(db.rows.filter(x => x.individual_id === ind)); }
      return J([]);
    }
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    window.__ev = []; window.__toasts = [];
    const origSb = window.sb;
    window.sb = async function (method, table, body, q) {
      if (method === 'POST' && table === 'inventory' && body) window.__ev.push('POST:' + body.ident_code);
      return origSb.apply(this, arguments);
    };
    window.pmPrintLabelHtml = html => {   // 実際に作られたラベルHTMLから番号を読む（印刷はしない）
      const ident = (html.match(/TGC-08-SHI999-[A-Z0-9]+(?:-\d+)?/) || [])[0] || '';
      const scan = (html.match(/\b(1\d{7})\b/) || [])[1] || '';
      const exp = (html.match(/消費期限\s*([0-9/]+)/) || [])[1] || '';
      window.__ev.push('LABEL:' + ident + ':' + scan + ':' + exp);
    };
    const origToast = window.toast;
    window.toast = (msg, type) => { window.__toasts.push((type || '') + ':' + msg); try { origToast(msg, type); } catch (e) {} };
  });
  // 保存されていた作業を再開する（現場と同じ経路）
  await page.evaluate(async () => {
    openProcessingMode(); await new Promise(r => setTimeout(r, 200));
    const card = document.querySelector('.pm-session-card');
    if (card) card.click();
    await new Promise(r => setTimeout(r, 500));
    await pmEnsureScanCodes(10);   // 現場では8桁キーが手元にある状態（11/9 もラベルを先に刷っていた）
    pmSelectedPart = PM_PARTS.find(p => p.part_name === 'ロース');
  });
  return { ctx, page, errors, dialogs, db };
}
const labels = ev => ev.filter(e => e.startsWith('LABEL:')).map(e => { const [, ident, scan, exp] = e.split(':'); return { ident, scan, exp }; });

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

  // ── A1 ──
  {
    const { ctx, page, errors, db } = await boot(browser, { failLoad: true, sessionIdents: true });
    const toasts = await page.evaluate(() => window.__toasts.slice());
    T('A1. 再開でDBが読めないことを画面に出す（黙らない）', toasts.some(t => /^error:/.test(t) && /番号を読めませんでした/.test(t)), toasts.join(' / '));
    await page.evaluate(() => pmRequestRegister(1.01)); await page.waitForTimeout(600);
    const ev = await page.evaluate(() => window.__ev.slice());
    const live = db.rows.find(r => r.weight === 1.01);
    const L = labels(ev);
    T('A1. 登録済み一覧の番号（RO）は避けて RO-2 で保存', live && live.ident_code === 'TGC-08-SHI999-RO-2', live && live.ident_code);
    T('A1. 番号の重なりは起きていない（POST 1回）', db.posts === 1, db.posts);
    T('A1. ラベルは保存より先に刷らない', ev.indexOf('POST:TGC-08-SHI999-RO-2') >= 0 && ev.findIndex(e => e.startsWith('LABEL:')) > ev.indexOf('POST:TGC-08-SHI999-RO-2'), ev.join(' | '));
    T('A1. ラベル1枚・番号と8桁が在庫と一致', L.length === 1 && live && L[0].ident === live.ident_code && L[0].scan === live.scan_code, JSON.stringify(L) + ' / ' + (live && live.scan_code));
    T('A1. pageerrorなし', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }
  // ── A2 ──
  {
    const { ctx, page, errors, dialogs, db } = await boot(browser, { failLoad: true, sessionIdents: false });
    await page.evaluate(() => pmRequestRegister(1.01)); await page.waitForTimeout(700);
    const ev = await page.evaluate(() => window.__ev.slice());
    const live = db.rows.find(r => r.weight === 1.01);
    const L = labels(ev);
    T('A2. 番号が重なっても在庫には入る（RO-2）', live && live.ident_code === 'TGC-08-SHI999-RO-2', live && live.ident_code);
    T('A2. ラベルは1枚だけ・ずれた後の番号と8桁', L.length === 1 && live && L[0].ident === live.ident_code && L[0].scan === live.scan_code, JSON.stringify(L) + ' / ' + (live && live.scan_code));
    T('A2. 番号が変わったことを知らせる', dialogs.some(d => /識別コードが/.test(d) && /変わった後の番号/.test(d)), dialogs.join(' / ').slice(0, 160));
    T('A2. pageerrorなし', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }
  // ── B ──
  {
    const { ctx, page, errors, db } = await boot(browser, { failLoad: false });
    const toasts = await page.evaluate(() => window.__toasts.slice());
    T('B. DBが読めたときは警告を出さない', !toasts.some(t => /番号を読めませんでした/.test(t)), toasts.join(' / '));
    await page.evaluate(() => pmRequestRegister(1.01)); await page.waitForTimeout(600);
    const ev = await page.evaluate(() => window.__ev.slice());
    const live = db.rows.find(r => r.weight === 1.01);
    const L = labels(ev);
    T('B. 先に刷る（従来どおり速い）', ev.findIndex(e => e.startsWith('LABEL:')) >= 0 && ev.findIndex(e => e.startsWith('LABEL:')) < ev.findIndex(e => e.startsWith('POST:')), ev.join(' | '));
    T('B. ラベル1枚・番号と8桁が在庫と一致（RO-2）', L.length === 1 && live && live.ident_code === 'TGC-08-SHI999-RO-2' && L[0].ident === live.ident_code && L[0].scan === live.scan_code, JSON.stringify(L) + ' / ' + (live && live.ident_code + ' ' + live.scan_code));
    T('B. pageerrorなし', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }
  // ── C ──
  {
    const { ctx, page, errors, dialogs, db } = await boot(browser, { failLoad: false });
    // 読み込んだ後に、別の端末が RO-2 を使った（この画面は知らない）
    db.rows.push({ individual_id: LABEL, ident_code: 'TGC-08-SHI999-RO-2', part_name: 'ロース', weight: 0.95, scan_code: '10000099', status: '在庫', deleted_at: null });
    await page.evaluate(() => pmRequestRegister(1.01)); await page.waitForTimeout(700);
    const ev = await page.evaluate(() => window.__ev.slice());
    const live = db.rows.find(r => r.weight === 1.01);
    const L = labels(ev);
    T('C. 在庫は RO-3 で入る', live && live.ident_code === 'TGC-08-SHI999-RO-3', live && live.ident_code);
    T('C. 正しい番号のラベルを自動で刷り直す（2枚目が在庫と一致）', L.length === 2 && live && L[1].ident === live.ident_code && L[1].scan === live.scan_code, JSON.stringify(L) + ' / ' + (live && live.scan_code));
    T('C. 古いラベルを捨てるよう知らせる', dialogs.some(d => /古い番号/.test(d) && /捨て/.test(d) && /刷り直しました/.test(d)), dialogs.join(' / ').slice(0, 200));
    T('C. pageerrorなし', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }
  // ── D ──
  {
    const { ctx, page, errors, dialogs, db } = await boot(browser, { failLoad: false });
    const r = await page.evaluate(async () => {
      window.__ev = [];
      const i = pmCompletedParts.findIndex(c => c.ident_code === 'TGC-08-SHI999-HI');
      const btn = !!document.querySelector(`#pmCompletedGrid button[onclick="pmReprintCompleted(${i})"]`);
      if (typeof pmReprintCompleted === 'function') await pmReprintCompleted(i);
      return { i, btn, ev: window.__ev.slice() };
    });
    const L = labels(r.ev);
    T('D. 登録済み一覧に刷り直しボタンがある', r.btn, JSON.stringify(r));
    T('D. 在庫の番号・8桁で刷る', L.length === 1 && L[0].ident === 'TGC-08-SHI999-HI' && L[0].scan === '10000051', JSON.stringify(L));
    T('D. 消費期限は処理日（2026/11/6）から1年＝2027/11/6', L.length === 1 && L[0].exp === '2027/11/6', JSON.stringify(L));
    T('D. 刷る前に番号と期限の基準を確かめる', dialogs.some(d => /刷り直します/.test(d) && /10000051/.test(d) && /2026\/11\/6/.test(d)), dialogs.join(' / ').slice(0, 200));
    T('D. pageerrorなし', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 300) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
