// 捕獲者台帳の個人情報（郵便番号・住所・電話・口座・支払先番号）をブラウザ用の鍵で読まない（2026-11-08）
//
//   きっかけ
//     hunters は RLS が using(true) のままで、公開サイトに埋め込まれた鍵だけで 236名分の口座番号・住所・電話を
//     読め、書き換えもできた（2026-07-26 に計画した「第2段階」が未実施）。
//     個人情報はスタッフキーの端末だけ staff_hunters_private / staff_hunter_private_save で読み書きし、
//     表を直接読むときは公開してよい列だけを明示する（列の権限を外した後も画面が動くように）。
//
//   ここで測ること（捕獲者はすべて架空）
//     0. 全画面のソース: hunters の読み出しに ?select=* や個人情報の列が無い・書き込みは select= で返す列を絞る
//     1. 業務アプリの台帳: 表の読み出しに個人情報の列が無い。スタッフキーありなら関数で読んで表示する
//     2. スタッフキーなし: 「非表示」と出す（「未登録」と誤表示しない）・個人情報の欄は入力できない・関数は呼ばない
//     3. 保存: 公開項目は表へ（個人情報を送らない・select=id）、個人情報は関数へ。関数が失敗したら知らせて画面を閉じない
//     4. 公式様式（捕獲者台帳）: 住所・連絡先を読めないときは空欄で作らずエラー
//     5. 買取画面・捕獲票: 表から口座・住所・電話を読まず、スタッフキーの端末だけ関数で足す
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');

const SENSITIVE = ['postal_code', 'address', 'phone', 'bank_name', 'bank_branch', 'account_type', 'account_number', 'account_holder', 'account_furigana', 'payee_no'];

(async () => {
  const root = path.resolve(__dirname, '../..');
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

  // ── 0. ソースの検査 ──
  const files = fs.readdirSync(root).filter(f => f.endsWith('.html'));
  const bad = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(root, f), 'utf8').split('\n');
    lines.forEach((l, i) => {
      if (!/sb\(\s*(['"](GET|POST|PATCH|DELETE)['"]\s*,\s*)?['"]hunters['"]/.test(l)) return;
      const sel = (l.match(/select=([^&'"`]*)/) || [])[1];
      if (/select=\*/.test(l)) bad.push(`${f}:${i + 1} select=*`);
      if (sel && SENSITIVE.some(c => sel.split(',').includes(c))) bad.push(`${f}:${i + 1} 個人情報の列 ${sel}`);
      if (/['"](POST|PATCH)['"]\s*,\s*['"]hunters['"]/.test(l) && !/select=/.test(l)) bad.push(`${f}:${i + 1} 書き込みに select= なし`);
      if (/['"]GET['"]\s*,\s*['"]hunters['"]/.test(l) && !/select=/.test(l)) bad.push(`${f}:${i + 1} 読み出しに select= なし`);
    });
  }
  T('0. どの画面も hunters を ?select=* や個人情報の列で読まない・書き込みは返す列を絞る', bad.length === 0, bad.join(' / '));

  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9094);
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });

  const H = [
    { id: 'h1', name: '架空 太郎', furigana: 'カクウ タロウ', city: '館山市', trap_area: '架空地区', memo: '', registry_number: '1', has_gun: true },
    { id: 'h2', name: '架空 花子', furigana: 'カクウ ハナコ', city: '南房総市', trap_area: '', memo: '', registry_number: '2', has_gun: false },
  ];
  const P = [
    { id: 'h1', postal_code: '0000000', address: '架空県架空市1-1', phone: '000-0000-0001', bank_name: '架空銀行', bank_branch: '本店', account_type: '普通', account_number: '0000001', account_holder: 'カクウ タロウ', account_furigana: 'カクウ タロウ', payee_no: 1 },
    { id: 'h2', postal_code: null, address: null, phone: '000-0000-0002', bank_name: null, bank_branch: null, account_type: null, account_number: null, account_holder: null, account_furigana: null, payee_no: null },
  ];
  const net = { hunterGets: [], writes: [], rpcRead: 0, rpcSave: [], saveFail: false };
  const route = async (rt) => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const j = (x, s) => rt.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(x) });
    const hasKey = !!req.headers()['x-staff-key'];
    if (url.includes('/rpc/staff_hunters_private')) {
      net.rpcRead++;
      if (!hasKey) return j({ code: '42501', message: 'STAFF_KEY_REQUIRED: 口座・住所・電話はスタッフキーを入れた端末でだけ表示できます' }, 401);
      const body = req.postDataJSON() || {}; const ids = body.p_ids;
      return j(ids ? P.filter(p => ids.includes(p.id)) : P);
    }
    if (url.includes('/rpc/staff_hunter_private_save')) {
      net.rpcSave.push({ key: hasKey, body: req.postDataJSON() });
      if (net.saveFail) return j({ message: 'boom' }, 500);
      return rt.fulfill({ status: 204, body: '' });
    }
    if (url.includes('/rest/v1/hunters')) {
      if (m === 'GET') {
        net.hunterGets.push(url);
        const nm = (url.match(/name=eq\.([^&]+)/) || [])[1];
        return j(nm ? H.filter(h => h.name === nm).map(h => ({ id: h.id })) : H.map(h => Object.assign({}, h)));
      }
      net.writes.push({ m, url, body: req.postDataJSON() });
      return j(m === 'POST' ? [{ id: 'h9' }] : [{ id: 'h1' }]);
    }
    return j([]);
  };
  const sentSensitive = () => net.hunterGets.filter(u => { const s = (u.match(/select=([^&]*)/) || [])[1] || '*'; return s === '*' || SENSITIVE.some(c => s.split(',').includes(c)); });

  // ── 1〜4. 業務アプリ ──
  const ctx = await b.newContext(); const p = await ctx.newPage();
  const errors = []; p.on('pageerror', e => errors.push('index: ' + e.message));
  await p.route('**/rest/v1/**', route);
  await p.goto('http://localhost:9094/index.html'); await p.waitForTimeout(400);
  await p.evaluate(() => {
    window.__alerts = []; window.alert = m => window.__alerts.push(String(m));
    window.confirm = () => true; window.print = () => {}; window.open = () => null;
    window.__toasts = []; const o = window.toast; window.toast = (m, k) => { window.__toasts.push([m, k]); try { o(m, k); } catch (e) {} };
    sessionStorage.setItem('tg_role_v1', 'admin');
  });
  const setKey = on => p.evaluate(on => { if (on) localStorage.setItem('tg_staff_key', 'test-key'); else { localStorage.removeItem('tg_staff_key'); sessionStorage.removeItem('tg_staff_key'); } }, on);

  await setKey(true);
  const withKey = await p.evaluate(async () => { await loadHunters(); return { html: document.getElementById('hunters-body').innerHTML, stats: document.getElementById('hunters-stats').textContent, ok: huntersPrivateOk }; });
  T('1. 台帳の読み出しに個人情報の列・select=* が無い', sentSensitive().length === 0 && net.hunterGets.length > 0, net.hunterGets.join(' | '));
  T('1. スタッフキーありなら関数で読んで電話・口座を表示', withKey.ok && /000-0000-0001/.test(withKey.html) && /架空銀行/.test(withKey.html) && !/非表示/.test(withKey.stats), withKey.stats);

  // 3. 保存（キーあり）: 公開項目は表へ、個人情報は関数へ
  net.writes = []; net.rpcSave = [];
  const saved = await p.evaluate(async () => {
    hunterEdit('h1');
    document.getElementById('hun-f-phone').value = '000-1111-2222';
    document.getElementById('hun-f-memo').value = 'メモ更新';
    const dis = document.getElementById('hun-f-phone').disabled;
    await hunterSave();
    return { dis, open: document.getElementById('hunterModal').style.display };
  });
  const pw = net.writes.find(w => w.m === 'PATCH');
  T('3. 公開項目は表へ PATCH（個人情報を送らない・select=id）', pw && /id=eq\.h1/.test(pw.url) && /select=id/.test(pw.url) && pw.body.memo === 'メモ更新' && !SENSITIVE.some(c => c in pw.body), pw ? pw.url + ' ' + JSON.stringify(pw.body) : 'なし');
  T('3. 個人情報は staff_hunter_private_save へ（スタッフキー付き）', net.rpcSave.length === 1 && net.rpcSave[0].key && net.rpcSave[0].body.p_id === 'h1' && net.rpcSave[0].body.p.phone === '000-1111-2222', JSON.stringify(net.rpcSave));
  T('3. キーありの端末では個人情報の欄を入力できる・保存後は閉じる', saved.dis === false && saved.open === 'none', JSON.stringify(saved));
  // 新規登録（キーあり）: POST ?select=id で返った番号で関数を呼ぶ
  net.writes = []; net.rpcSave = [];
  await p.evaluate(async () => { hunterOpenNew(); document.getElementById('hun-f-name').value = '架空 次郎'; document.getElementById('hun-f-phone').value = '000-3333-4444'; await hunterSave(); });
  const pp = net.writes.find(w => w.m === 'POST');
  T('3. 新規登録は POST ?select=id（個人情報なし）→ 返った番号で関数', pp && /select=id/.test(pp.url) && !SENSITIVE.some(c => c in pp.body) && net.rpcSave.length === 1 && net.rpcSave[0].body.p_id === 'h9' && net.rpcSave[0].body.p.phone === '000-3333-4444', JSON.stringify([pp && pp.url, net.rpcSave]));
  // 関数が失敗したら知らせて閉じない
  net.saveFail = true; net.rpcSave = [];
  const fail = await p.evaluate(async () => { window.__alerts = []; hunterEdit('h1'); document.getElementById('hun-f-phone').value = '000-5555-6666'; await hunterSave(); return { alerts: window.__alerts, open: document.getElementById('hunterModal').style.display }; });
  net.saveFail = false;
  await p.waitForTimeout(400);   // 失敗時に投げた台帳の読み直しが終わるのを待つ（次の「キーなし」の数え方に混ざらないように）
  T('3. 個人情報の保存に失敗したら知らせる・画面を閉じない', fail.open === 'block' && fail.alerts.some(a => /口座・住所・電話を保存できませんでした/.test(a)), JSON.stringify(fail));
  await p.evaluate(() => { document.getElementById('hunterModal').style.display = 'none'; });

  // 2. スタッフキーなし
  await setKey(false); net.rpcRead = 0; net.writes = []; net.rpcSave = [];
  const noKey = await p.evaluate(async () => { await loadHunters(); return { html: document.getElementById('hunters-body').innerHTML, stats: document.getElementById('hunters-stats').textContent, ok: huntersPrivateOk }; });
  T('2. キーなし: 電話・口座は「非表示」（「未登録」と誤表示しない）', !noKey.ok && /非表示/.test(noKey.html) && !/未登録<\/span>/.test(noKey.html) && !/000-0000-0001/.test(noKey.html), noKey.html.slice(0, 200));
  T('2. キーなし: 理由を台帳の上に出す', /口座・住所・電話は表示していません/.test(noKey.stats) && /スタッフキー/.test(noKey.stats), noKey.stats);
  T('2. キーなし: 関数を呼ばない', net.rpcRead === 0, String(net.rpcRead));
  const noKeySave = await p.evaluate(async () => { hunterEdit('h1'); const dis = document.getElementById('hun-f-phone').disabled; const ph = document.getElementById('hun-f-phone').placeholder; document.getElementById('hun-f-memo').value = 'キーなしメモ'; await hunterSave(); return { dis, ph }; });
  const pw2 = net.writes.find(w => w.m === 'PATCH');
  T('2. キーなし: 個人情報の欄は入力できない', noKeySave.dis === true && /スタッフキー/.test(noKeySave.ph), JSON.stringify(noKeySave));
  T('2. キーなし: 保存は公開項目だけ（個人情報を空で上書きしない・関数を呼ばない）', pw2 && !SENSITIVE.some(c => c in pw2.body) && net.rpcSave.length === 0, JSON.stringify([pw2 && pw2.body, net.rpcSave]));
  const lbl = await p.evaluate(() => { window.__alerts = []; hunterPrintLabels(); return window.__alerts; });
  T('2. キーなし: 宛名ラベルは作らず理由を出す', lbl.some(a => /住所を読めない/.test(a)), lbl.join(' / '));

  // 4. 公式様式
  const doc = await p.evaluate(async () => { const d = DOC_DEFS.find(x => x.key === 'hunter_registry'); try { await d.gen(); return 'ok'; } catch (e) { return e.message; } });
  T('4. 公式様式（捕獲者台帳）: 住所・連絡先を読めないときは作らない', /スタッフキー/.test(doc), doc);
  await setKey(true);
  const doc2 = await p.evaluate(async () => { const d = DOC_DEFS.find(x => x.key === 'hunter_registry'); const r = await d.gen(); return r.rows[0]; });
  T('4. 公式様式: キーありなら住所・連絡先が入る', doc2 && doc2[4] === '架空県架空市1-1' && doc2[5] === '000-0000-0001', JSON.stringify(doc2));
  T('1〜4. 業務アプリ全体で hunters の読み出しに個人情報の列が無い', sentSensitive().length === 0, sentSensitive().join(' | '));

  // ── 5. 買取画面・捕獲票 ──
  for (const [file, key] of [['buyback.html', true], ['buyback.html', false], ['capture-form.html', true]]) {
    net.hunterGets = []; net.rpcRead = 0;
    const c2 = await b.newContext(); const q = await c2.newPage();
    q.on('pageerror', e => errors.push(file + ': ' + e.message));
    await q.route('**/rest/v1/**', route);
    await q.addInitScript(k => { try { sessionStorage.setItem('tg_role_v1', 'admin'); if (k) localStorage.setItem('tg_staff_key', 'test-key'); } catch (e) {} }, key);
    await q.goto('http://localhost:9094/' + file); await q.waitForTimeout(1200);
    if (file === 'buyback.html') {
      const r = await q.evaluate(() => ({ h: (typeof D !== 'undefined' && D.hunters) ? D.hunters[normName('架空 太郎')] : null, st: document.getElementById('statusBar') ? document.getElementById('statusBar').textContent : '' }));
      if (key) T('5. 買取画面（キーあり）: 口座・住所を関数から足す', r.h && r.h.bank_name === '架空銀行' && r.h.address === '架空県架空市1-1', JSON.stringify(r.h));
      else T('5. 買取画面（キーなし）: 口座を読めないことを画面に出す', /口座・住所を読めませんでした/.test(r.st), r.st);
    } else {
      const r = await q.evaluate(async () => { const before = (window._huntersCache || []).find(h => h.name === '架空 太郎'); await sb('POST', 'hunters', { name: 'x' }, '?select=id,name'); return before; });
      T('5. 捕獲票（キーあり）: 電話は関数から足す', r && r.phone === '000-0000-0001', JSON.stringify(r));
    }
    T(`5. ${file}${key ? '（キーあり）' : '（キーなし）'}: hunters の読み出しに個人情報の列が無い`, sentSensitive().length === 0 && net.hunterGets.length > 0, net.hunterGets.join(' | '));
    await c2.close();
  }

  T('ページエラーなし', errors.length === 0, errors.join(' / '));
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + got.slice(0, 260) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await b.close(); srv.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
