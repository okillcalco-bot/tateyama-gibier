// 受発注管理: 書類の印刷専用モード order-admin.html?print=<documents.id>
//   出店（委託販売）から発行した請求書を、受発注管理の請求書と同じ書式でそのまま印刷する。
//   1. スナップショットから 請求書（宛名・番号・8%対象・消費税・対象外（手数料の差引）・ご請求金額）が出る
//   2. スタッフキーの入力や注文の読み込みはしない（印刷だけ）
//   3. 無い id／印刷データ無し は画面に出る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const SNAP = { name: '株式会社ニイチク', honorific: '御中', address: '千葉県館山市××', subject: '8月29日 ニイチク直売会 売上（委託販売）', date: '2026-09-17', due: '2026-10-31',
  memo: '8月29日 即売会分。売上合計から販売手数料を差し引いた額をご請求します。', customer_id: null, order_ids: [], type: '請求書', proviso: '', bank: '千葉銀行 館山支店 普通 0000000',
  issuer: { issuer_name: '合同会社アルコ', issuer_sub: '館山ジビエセンター運営事業者', postal: '294-0025', address: '千葉県館山市大戸37', tel: '070-0000-0000', email: 'x@example.com', reg_number: 'T7040003010341' }, seal: '',
  lines: [{ name: '8月29日 ニイチク直売会 売上（税抜）', qty: null, unit: '', price: null, tax: 8, amount: 82352 }, { name: '販売手数料（11%） 差引', qty: null, unit: '', price: null, tax: 0, amount: -9059 }], sale_event_id: 'e1' };
const DOCS = [{ id: 'doc1', doc_number: 'INV-202609-002', doc_type: '請求書', status: '発行済', snapshot: SNAP }, { id: 'doc2', doc_number: 'INV-202609-003', doc_type: '請求書', status: '取消', snapshot: SNAP }, { id: 'doc3', doc_number: 'INV-202609-004', doc_type: '請求書', status: '発行済', snapshot: null }];

async function open(browser, q) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const dialogs = []; page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss(); });
  const calls = [];
  await page.route('**/*', r => {
    const u = decodeURIComponent(r.request().url());
    if (u.startsWith('file:')) return r.continue();
    if (/cdnjs|jsdelivr|fonts\./.test(u)) return r.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    const m = u.match(/\/rest\/v1\/(\w+)/); if (m) calls.push(m[1]);
    if (/\/rest\/v1\/documents/.test(u)) { const id = (u.match(/id=eq\.([^&]+)/) || [])[1]; return J(DOCS.filter(d => d.id === id)); }
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html') + q);
  await page.waitForTimeout(900);
  return { page, errors, dialogs, calls };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = []; const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  const a = await open(browser, '?print=doc1');
  const t = await a.page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
  T('請求書のタイトル・宛名（御中）・番号・発行日・支払期限', /請 求 書/.test(t) && /株式会社ニイチク 御中/.test(t) && /INV-202609-002/.test(t) && /2026年9月17日/.test(t) && /2026年10月31日/.test(t), t.slice(0, 200));
  T('ご請求金額 ¥79,881（税込）', /ご請求金額（税込）\s*¥79,881/.test(t), (t.match(/ご請求金額[^¥]*¥[\d,]+/) || [''])[0]);
  T('8%対象 ¥82,352・消費税 ¥6,588・対象外 ¥-9,059（手数料の差引）', /8%対象（税抜）※\s*¥82,352/.test(t) && /消費税（8%）\s*¥6,588/.test(t) && /対象外\s*¥-9,059/.test(t), (t.match(/小計[\s\S]{0,160}/) || [''])[0]);
  T('明細 2行（売上（税抜）／販売手数料 差引）と件名・備考・振込先・登録番号', /売上（税抜）/.test(t) && /販売手数料（11%） 差引/.test(t) && /件名: 8月29日/.test(t) && /8月29日 即売会分/.test(t) && /千葉銀行/.test(t) && /T7040003010341/.test(t), '');
  T('スタッフキーの prompt は出ない・注文や顧客は読まない（documents だけ）', a.dialogs.length === 0 && a.calls.every(c => c === 'documents'), JSON.stringify([a.dialogs, [...new Set(a.calls)]]));
  T('pageerrorなし', a.errors.length === 0, a.errors.join(' / '));
  await a.page.context().close();

  const b = await open(browser, '?print=doc2');
  T('取消済みの書類は「取消」の透かしが出る', /取消/.test(await b.page.evaluate(() => (document.querySelector('.void') || {}).textContent || '')), '');
  await b.page.context().close();

  const c = await open(browser, '?print=doc3');
  T('印刷データが無い書類は画面にそう出る', /印刷用データがありません/.test(await c.page.evaluate(() => document.body.innerText)), '');
  await c.page.context().close();

  const d = await open(browser, '?print=nope');
  T('無い id は「見つかりません」と出る（握り潰さない）', /見つかりません/.test(await d.page.evaluate(() => document.body.innerText)), '');
  await d.page.context().close();

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 240) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
