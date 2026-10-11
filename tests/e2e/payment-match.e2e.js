// 入金明細との照合（受発注管理 → 書類一覧の「入金明細と照合する」）（2026-10-11）
//
//   きっかけ: 発行済み請求書86件がすべて「未入金」のまま。入金の記録は0件。
//     バイトに、責任者から渡した入金明細と請求書の照合を任せたい。
//
//   ここで測ること（すべて架空のデータ。本番には触らない）
//     1. 名義（顧客のふりがな）と残額が一致して候補が1件のときだけ「記録できる」
//     2. 同額でも名義が違う／合算／分割・不足／手数料差／過入金／資料不足／該当なし は「確認待ち」と理由
//     3. 記録: 明細の日付で入金日を入れ、照合キーを残す。請求書は「入金済」
//     4. 同じ明細をもう一度貼っても「記録済み」になり、二重に記録できない（画面内でもDBでも）
//     5. 同時編集: 開いた後に別の人が入金を記録していたら、残額を超える分は記録しない
//     6. 保存に失敗したら画面に出し、「記録した」扱いにしない
//     7. 一覧の「💰 入金」: 入金日を入れられる（当日固定だった）・残額を超える入金は記録しない
//     8. 日報用の文面に振込名義を入れない（明細の行番号・請求番号・理由だけ）
//     9. 未入金・期限超過の区別は既存のとおり（期日を過ぎたものは「期限超過」）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const CUSTS = [
  { id: 'c1', name: '館山食堂', kana: 'たてやましょくどう' },
  { id: 'c2', name: 'B商店', kana: 'びーしょうてん' },
  { id: 'c3', name: 'C亭', kana: 'しーてい' },
  { id: 'c4', name: 'D屋', kana: 'でぃーや' },
  { id: 'c5', name: 'E堂', kana: 'いーどう' },
];
const D = (id, num, cid, name, total, due) => ({ id, doc_type: '請求書', doc_number: num, customer_id: cid, partner_name: name, total_amount: total, tax_amount: 0, status: '発行済', billing_status: '未入金', issue_date: '2026-09-30', due_date: due, created_at: '2026-09-30T00:00:00Z', snapshot: {} });
const DOCS = [
  D('d1', 'INV-202609-001', 'c1', '館山食堂', 12000, '2026-10-31'),
  D('d2', 'INV-202609-002', 'c2', 'B商店', 5000, '2026-10-31'),
  D('d3', 'INV-202609-003', 'c2', 'B商店', 3000, '2026-10-31'),
  D('d4', 'INV-202609-004', 'c3', 'C亭', 10000, '2026-09-30'),   // 期限超過
  D('d5', 'INV-202609-005', 'c4', 'D屋', 5500, '2026-10-31'),
  D('d6', 'INV-202609-006', 'c5', 'E堂', 7000, '2026-10-31'),
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ timezoneId: 'Asia/Tokyo' });
  await ctx.addInitScript(() => { try { localStorage.setItem('tg_staff_key', 'k'); } catch (e) {} });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date('2026-10-11T03:00:00Z'));
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const dialogs = []; let promptAnswers = [];
  page.on('dialog', d => { dialogs.push(d.message()); if (d.type() === 'prompt') d.accept(promptAnswers.length ? promptAnswers.shift() : d.defaultValue()); else d.accept(); });
  const pays = []; const posted = []; const patches = []; let failPost = false; let sneak = null;
  await page.route('**/rest/v1/**', async rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = (x, st) => rt.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (/\/customers\b/.test(url)) return J(CUSTS);
    if (/\/payments\b/.test(url)) {
      if (m === 'POST') { if (failPost) return rt.fulfill({ status: 500, body: '{"message":"boom"}' }); const b = JSON.parse(req.postData()); posted.push(...b); pays.push(...b); return J(b, 201); }
      // 別の人がこの瞬間に記録した入金（同時編集）
      if (sneak && url.includes('document_id=eq.' + sneak.document_id)) { pays.push(sneak); sneak = null; }
      const one = url.match(/document_id=eq\.([^&]+)/); const ins = url.match(/document_id=in\.\(([^)]*)\)/);
      return J(pays.filter(p => (one && p.document_id === one[1]) || (ins && ins[1].split(',').includes(p.document_id))));
    }
    if (/\/documents\b/.test(url)) {
      if (m === 'PATCH') { patches.push({ url, body: JSON.parse(req.postData()) }); return J([]); }
      if (/doc_type=eq\.請求書/.test(url)) return J(DOCS);
      return J([]);
    }
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));
  await page.route('https://cdn.jsdelivr.net/**', rt => rt.fulfill({ contentType: 'application/javascript', body: '' }));
  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(700);
  await page.evaluate(() => switchTab('invoice'));
  await page.waitForTimeout(400);
  await page.evaluate(() => loadInvoiceList()); await page.waitForTimeout(300);

  const results = []; const ck = (n, c, g) => results.push([n, !!c, g == null ? '' : String(g)]);
  const st = await page.evaluate(() => invListRows.map(r => invStatusOf(r)));
  ck('期日を過ぎた請求書は「期限超過」、それ以外は「未入金」（既存の区別）', st[3] === '期限超過' && st[0] === '未入金', JSON.stringify(st));

  const STMT = [
    '2026/10/05 ﾀﾃﾔﾏｼｮｸﾄﾞｳ 12,000',      // 1 名義も残額も一致 → 記録できる
    '2026/10/05 ﾋﾞｰｼｮｳﾃﾝ 8,000',         // 2 合算（5,000+3,000）
    '2026/10/06 ｼｰﾃｲ 6,000',             // 3 分割・不足
    '2026/10/06 ﾃﾞｨｰﾔ 5,000',            // 4 手数料差（500円）
    '2026/10/07 ﾔﾏﾀﾞﾀﾛｳ 7,000',          // 5 金額だけ一致（別名義）
    '2026/10/07 ﾀﾃﾔﾏｼｮｸﾄﾞｳ 15,000',      // 6 過入金
    'ｲｰﾄﾞｳ 7,000',                       // 7 資料不足（日付なし）
    '2026/10/08 ｿﾞﾝｼﾞﾅｲ 1,234',           // 8 該当なし
  ].join('\n');
  await page.evaluate(() => { document.getElementById('payMatchBox').open = true; });
  await page.fill('#payMatchText', STMT);
  await page.evaluate(() => payMatchRun()); await page.waitForTimeout(300);
  const R = await page.evaluate(() => payMatchRows.map(r => ({ no: r.no, kind: r.kind, reason: r.reason, cands: r.cands.map(c => c.doc_number) })));
  const K = n => R.find(r => r.no === n) || {};
  ck('1. 名義と残額が一致・候補1件 → 記録できる', K(1).kind === 'match' && K(1).cands[0] === 'INV-202609-001', JSON.stringify(K(1)));
  ck('2. 合算（2件の残額の合計と一致）→ 確認待ち', K(2).kind === 'wait' && /合算/.test(K(2).reason) && K(2).cands.length === 2, JSON.stringify(K(2)));
  ck('3. 分割・不足 → 確認待ち（入金済みにしない）', K(3).kind === 'wait' && /分割・不足/.test(K(3).reason), JSON.stringify(K(3)));
  ck('4. 手数料差（500円）→ 確認待ち', K(4).kind === 'wait' && /手数料差/.test(K(4).reason), JSON.stringify(K(4)));
  ck('5. 同額でも名義が違う → 確認待ち（同額だけで入金済みにしない）', K(5).kind === 'wait' && /金額だけ一致/.test(K(5).reason), JSON.stringify(K(5)));
  ck('6. 過入金 → 確認待ち', K(6).kind === 'wait' && /過入金/.test(K(6).reason), JSON.stringify(K(6)));
  ck('7. 日付が読めない → 資料不足で確認待ち', K(7).kind === 'wait' && /資料不足.*日付/.test(K(7).reason), JSON.stringify(K(7)));
  ck('8. 該当なし → 確認待ち', K(8).kind === 'wait' && /該当する請求書なし/.test(K(8).reason), JSON.stringify(K(8)));
  ck('「記録」ボタンは1件の行だけ', await page.$$eval('#payMatchOut button', bs => bs.length) === 1, '');

  // 保存失敗
  failPost = true;
  await page.evaluate(() => payMatchRecord(0)); await page.waitForTimeout(300);
  ck('6. 保存に失敗したら画面に出し、記録した扱いにしない', dialogs.some(d => /入金記録エラー/.test(d)) && !(await page.evaluate(() => Object.keys(payMatchUsed).length)), dialogs.slice(-1)[0]);
  failPost = false;
  await page.evaluate(() => payMatchRecord(0)); await page.waitForTimeout(400);
  const p1 = posted[0] || {};
  ck('3. 記録: 入金日は明細の日付・金額・照合キー・請求書は入金済', posted.length === 1 && p1.document_id === 'd1' && p1.paid_date === '2026-10-05' && p1.amount === 12000 && /^明細:2026-10-05\|12000\|/.test(p1.note) && patches.some(x => /id=eq\.d1/.test(x.url) && x.body.billing_status === '入金済'), JSON.stringify(p1));
  await page.evaluate(() => payMatchRecord(0)); await page.waitForTimeout(200);
  ck('4. 同じ行は画面内で二度記録できない', posted.length === 1, String(posted.length));
  await page.evaluate(() => { payMatchUsed = {}; return payMatchRun(); }); await page.waitForTimeout(300);
  const again = await page.evaluate(() => payMatchRows[0]);
  ck('4. 同じ明細を貼り直しても「記録済み」（DBの照合キーで判定）', again.kind === 'done' && /記録済み.*INV-202609-001/.test(again.reason), JSON.stringify({ kind: again.kind, reason: again.reason }));
  const dupSave = await page.evaluate(() => invSavePayment(invListRows.find(r => r.id === 'd1'), { amount: 12000, paidDate: '2026-10-05', note: payMatchRows[0].sig }));
  ck('4. 保存の直前にも同じ照合キーなら止める', dupSave === false && posted.length === 1, String(dupSave));

  // 同時編集: E堂(7,000)の入金をこちらが記録しようとした瞬間に、別の人が 7,000 を記録済み
  sneak = { document_id: 'd6', amount: 7000, paid_date: '2026-10-07', note: null };
  const conc = await page.evaluate(() => invSavePayment(invListRows.find(r => r.id === 'd6'), { amount: 7000, paidDate: '2026-10-07', note: 'x' }));
  ck('5. 同時編集: 開いた後に別の人が記録していたら、残額を超える分は記録しない', conc === false && posted.length === 1 && dialogs.some(d => /残額 ¥0 を超える入金は記録できません/.test(d) && /別の人が入金を記録/.test(d)), dialogs.slice(-1)[0]);

  // 一覧の「💰 入金」（C亭 10,000 に 6,000 を 10/6 付で）→ 一部入金、残額超えは止める
  await page.evaluate(() => loadInvoiceList()); await page.waitForTimeout(300);
  promptAnswers = ['6000', '2026/10/06'];
  await page.evaluate(() => invRecordPayment('d4')); await page.waitForTimeout(400);
  const p2 = posted[posted.length - 1];
  ck('7. 一覧の入金: 入金日を入れられる・分割は「一部入金」', p2.document_id === 'd4' && p2.paid_date === '2026-10-06' && p2.amount === 6000 && patches.some(x => /id=eq\.d4/.test(x.url) && x.body.billing_status === '一部入金'), JSON.stringify(p2));
  const before = posted.length;
  promptAnswers = ['5000', '2026-10-07'];
  await page.evaluate(() => invRecordPayment('d4')); await page.waitForTimeout(300);
  ck('7. 一覧の入金: 残額（4,000）を超える入金は記録しない', posted.length === before && dialogs.some(d => /残額 ¥4,000 を超える入金は記録できません/.test(d)), dialogs.slice(-1)[0]);
  promptAnswers = ['1000', '13/45'];
  await page.evaluate(() => invRecordPayment('d4')); await page.waitForTimeout(200);
  ck('7. 読めない日付は記録しない', posted.length === before && dialogs.some(d => /日付が読めません/.test(d)), '');

  // 日報
  await page.evaluate(() => { navigator.clipboard.writeText = t => { window.__copied = t; return Promise.resolve(); }; });
  await page.evaluate(() => payMatchCopyReport()); await page.waitForTimeout(100);
  const rep = await page.evaluate(() => window.__copied || '');
  ck('8. 日報: 件数・要確認の行番号と理由はあり、振込名義は入れない', /【確認件数】明細 8件/.test(rep) && /明細2行目.*合算/.test(rep) && !/ﾀﾃﾔﾏ|ﾋﾞｰｼｮｳﾃﾝ|ﾔﾏﾀﾞ/.test(rep), rep.slice(0, 300));
  ck('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, g] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (g ? '  [' + g + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
