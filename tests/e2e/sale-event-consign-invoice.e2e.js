// 出店: 委託販売の売上報告 → 手数料を引いた額の請求書
//
//   きっかけ（2026-09-17）
//     「ニイチク直売会のは後で売上を教えてもらってから手数料を引いた額を請求する。そのための請求書を作れるようにして」
//     8月29日分: 税抜 82,352 ／ 消費税(8%) 6,588 ／ 売上合計 88,940 ／ 手数料 9,059 → ご請求 79,881
//
//   ここで測ること
//     1. 委託販売の出店先（event_venues.consignment）なら欄が出て、請求先・手数料率が出店先から入る
//     2. 「明細から計算」で 税抜 82,352・消費税 6,588・手数料 9,059（11%）・ご請求 79,881 になる（8/29 の報告と一致）
//     3. 「保存」で sale_events の consign_* と event_venues の請求先・率が書かれる
//     4. 「発行」で documents に 請求書（INV-YYYYMM-連番・合計 79,881・税 6,588・source=sale_event・明細2行）と
//        document_items が入り、出店に consign_doc_id が付き、印刷ウィンドウが order-admin.html?print=<id> に向く
//     5. 採番が競合したら番号を取り直す。もう発行済なら二重に発行しない。消費税が8%と合わなければ発行しない
//     6. 書込みの失敗は画面に出る（握り潰さない）。委託でない出店先では欄は出ず、押せば出せる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const now = new Date(); const YM = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
const EV = { id: 'e1', event_date: '2026-08-29', end_date: null, venue_id: 'v1', venue_name: 'ニイチク直売会', title: 'ニイチク直売会', status: '実績確定',
  cash_total: null, cashless_total: null, other_cost: null, booth_fee: null, visitors: null, staff_names: null, start_time: null, end_time: null, weather: null, note: null,
  consign_sales_ex: null, consign_tax: null, consign_fee: null, consign_doc_id: null };
const EV2 = { id: 'e2', event_date: '2026-08-30', end_date: null, venue_id: 'v2', venue_name: '川島夜店市', title: null, status: '実績確定', consign_sales_ex: null, consign_doc_id: null };
const VENUES = [{ id: 'v1', name: 'ニイチク直売会', consignment: true, commission_pct: 11, bill_to: '株式会社ニイチク', bill_to_address: '千葉県館山市××', lat: null, lng: null },
                { id: 'v2', name: '川島夜店市', consignment: false, commission_pct: null, bill_to: null, bill_to_address: null, lat: null, lng: null }];
// 8/29 の明細（税込の売価・合計 88,940）
const AMTS = [6300, 7200, 33300, 7040, 9000, 6300, 6300, 8100, 5400];
const ITEMS = AMTS.map((a, i) => ({ id: 'i' + i, event_id: 'e1', kind: 'other', item_name: '品' + i, qty_taken: 10, qty_sold: a / 900, qty_sample: 0, unit_price: 900, amount: a }));
const SETTINGS = { issuer_name: '合同会社アルコ', issuer_sub: '館山ジビエセンター運営事業者', postal: '294-0025', address: '千葉県館山市大戸37', tel: '070-0000-0000', email: 'x@example.com', reg_number: 'T7040003010341', bank: '千葉銀行 館山支店 普通 0000000', seal_data_url: '' };
let DOCS = [{ id: 'd0', doc_number: `INV-${YM}-001`, status: '発行済' }];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); } catch (e) {}
    window.__opened = [];
    window.open = () => { const w = { _loc: '', closed: false, close() { this.closed = true; } }; Object.defineProperty(w, 'location', { set(v) { w._loc = v; }, get() { return w._loc; } }); window.__opened.push(w); return w; };
  });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const dialogs = []; let dialogAnswer = true;
  page.on('dialog', async d => { dialogs.push(d.message()); if (d.type() === 'confirm') { if (dialogAnswer) await d.accept(); else await d.dismiss(); } else await d.accept(); });
  const writes = [];
  let docPostMode = 'ok'; // ok | dup_once | fail
  let nextDoc = 1;
  await page.route('**/*', r => {
    const u = decodeURIComponent(r.request().url()), m = r.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = (b, st) => r.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(b) });
    const body = () => { try { return JSON.parse(r.request().postData() || 'null'); } catch (e) { return null; } };
    if (/\/rest\/v1\/sale_event_items/.test(u)) return J(ITEMS);
    if (/\/rest\/v1\/sale_events/.test(u)) {
      if (m === 'PATCH') { const b = body(); const id = (u.match(/id=eq\.([^&]+)/) || [])[1]; writes.push({ t: 'events', m, id, b }); const ev = id === 'e2' ? EV2 : EV; Object.assign(ev, b); return J([ev]); }
      if (/id=eq\.e2/.test(u)) return J([EV2]);
      if (/id=eq\.e1/.test(u)) return J([EV]);
      return J([Object.assign({ sale_event_items: ITEMS }, EV), EV2]);
    }
    if (/\/rest\/v1\/event_venues/.test(u)) {
      if (m === 'PATCH') { const b = body(); const id = (u.match(/id=eq\.([^&]+)/) || [])[1]; writes.push({ t: 'venues', m, id, b }); const v = VENUES.find(x => x.id === id); if (v) Object.assign(v, b); return J(v ? [v] : []); }
      return J(VENUES);
    }
    if (/\/rest\/v1\/app_settings/.test(u)) return J([{ key: 'invoice', value: SETTINGS }]);
    if (/\/rest\/v1\/documents/.test(u)) {
      if (m === 'POST') {
        const b = body(); const h = Array.isArray(b) ? b[0] : b;
        writes.push({ t: 'documents', m, b: h, cache: r.request().headers()['cache-control'] || '' });
        if (docPostMode === 'fail') return r.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' });
        if (docPostMode === 'dup_once') { docPostMode = 'ok'; DOCS.push({ id: 'dx', doc_number: h.doc_number, status: '発行済' }); return r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: '23505', message: 'duplicate key value violates unique constraint "documents_doc_number_key"' }) }); }
        const row = Object.assign({ id: 'doc' + (nextDoc++) }, h); DOCS.push(row); return J([row]);
      }
      const like = (u.match(/doc_number=like\.([^&]+)/) || [])[1];
      if (like) { const pre = like.replace('*', ''); return J(DOCS.filter(d => d.doc_number.startsWith(pre)).map(d => ({ doc_number: d.doc_number }))); }
      const id = (u.match(/id=eq\.([^&]+)/) || [])[1];
      if (id) return J(DOCS.filter(d => d.id === id));
      return J([]);
    }
    if (/\/rest\/v1\/document_items/.test(u)) { const b = body(); writes.push({ t: 'document_items', m, b }); return J(b); }
    return J([]);
  });

  await page.goto('file://' + path.resolve(__dirname, '../../index.html') + '?tab=event');
  await page.waitForTimeout(900);
  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);
  const $ = (sel, prop = 'value') => page.evaluate(([s, p]) => { const el = document.querySelector(s); return el ? el[p] : null; }, [sel, prop]);
  const vis = sel => page.evaluate(s => { const el = document.querySelector(s); return !!el && el.style.display !== 'none'; }, sel);

  // ── 1) 委託販売の出店先なら欄が出る ──
  await page.evaluate(() => evOpen('e1'));
  await page.waitForTimeout(500);
  T('委託販売の出店先（ニイチク直売会）では欄が出て、「委託販売として扱う」リンクは出ない', (await vis('#ev-consign-sec')) && !(await vis('#ev-consign-link')), '');
  T('請求先・住所・手数料率が出店先から入る', (await $('#ev-cs-billto')) === '株式会社ニイチク' && (await $('#ev-cs-addr')) === '千葉県館山市××' && (await $('#ev-cs-pct')) === '11', JSON.stringify([await $('#ev-cs-billto'), await $('#ev-cs-pct')]));
  T('件名は「8月29日 ニイチク直売会 売上（委託販売）」', /^8月29日 ニイチク直売会 売上（委託販売）$/.test(await $('#ev-cs-subject')), await $('#ev-cs-subject'));
  T('請求書はまだ発行していない、と出る', /まだ発行していません/.test(await $('#ev-cs-doc', 'textContent')), '');

  // ── 2) 明細から計算 ──
  await page.evaluate(() => evConsignFromItems());
  const calc = await page.evaluate(() => ({ ex: document.getElementById('ev-cs-ex').value, tax: document.getElementById('ev-cs-tax').value, fee: document.getElementById('ev-cs-fee').value, pct: document.getElementById('ev-cs-pct').value, total: document.getElementById('ev-cs-total').textContent, bill: document.getElementById('ev-cs-bill').textContent, note: document.getElementById('ev-cs-calc-note').textContent }));
  T('明細（税込 88,940）から: 税抜 82,352・消費税 6,588・手数料 9,059（11%）', calc.ex === '82352' && calc.tax === '6588' && calc.fee === '9059' && calc.pct === '11', JSON.stringify(calc));
  T('売上合計 ¥88,940・ご請求金額 ¥79,881（＝8/29 の報告どおり）', calc.total === '¥88,940' && calc.bill === '¥79,881' && calc.note === '', JSON.stringify(calc));

  // 手数料率を変えると手数料が計算される
  await page.fill('#ev-cs-pct', '10'); await page.evaluate(() => evConsignPctChange());
  T('率を 10% にすると手数料 8,235・ご請求 80,705', (await $('#ev-cs-fee')) === '8235' && (await $('#ev-cs-bill', 'textContent')) === '¥80,705', await $('#ev-cs-fee'));
  await page.fill('#ev-cs-fee', '9059'); await page.evaluate(() => evConsignCalc());
  T('手数料を 9,059 に戻すと率は 11 に戻る', (await $('#ev-cs-pct')) === '11', await $('#ev-cs-pct'));

  // ── 3) 保存 ──
  await page.evaluate(() => evConsignSave());
  await page.waitForTimeout(300);
  const wEv = writes.find(w => w.t === 'events' && w.id === 'e1'), wVe = writes.find(w => w.t === 'venues' && w.id === 'v1');
  T('保存: sale_events に consign_sales_ex/tax/fee が書かれる', wEv && wEv.b.consign_sales_ex === 82352 && wEv.b.consign_tax === 6588 && wEv.b.consign_fee === 9059, JSON.stringify(wEv && wEv.b));
  T('保存: event_venues に 請求先・住所・率（11）・consignment=true が書かれる', wVe && wVe.b.bill_to === '株式会社ニイチク' && wVe.b.commission_pct === 11 && wVe.b.consignment === true, JSON.stringify(wVe && wVe.b));
  T('保存したと画面に出る', /保存しました/.test(await $('#ev-cs-msg', 'textContent')), await $('#ev-cs-msg', 'textContent'));

  // ── 5a) 消費税が 8% と合わないと発行しない ──
  await page.fill('#ev-cs-tax', '6000'); await page.evaluate(() => evConsignCalc());
  T('消費税が合わないと注意が出る', /合いません/.test(await $('#ev-cs-calc-note', 'textContent')), await $('#ev-cs-calc-note', 'textContent'));
  const before = writes.filter(w => w.t === 'documents').length;
  await page.evaluate(() => evConsignIssue()); await page.waitForTimeout(200);
  T('消費税が合わないまま「発行」→ 止まる（documents に書かない・理由を alert）', writes.filter(w => w.t === 'documents').length === before && /8%/.test(dialogs[dialogs.length - 1] || ''), dialogs[dialogs.length - 1]);
  await page.fill('#ev-cs-tax', '6588'); await page.evaluate(() => evConsignCalc());

  // ── 4) 発行 ──
  await page.fill('#ev-cs-memo', '8月29日 即売会分。売上合計から販売手数料を差し引いた額をご請求します。');
  await page.evaluate(() => evConsignIssue());
  await page.waitForTimeout(600);
  const doc = writes.filter(w => w.t === 'documents').slice(-1)[0];
  T('confirm に 売上合計 88,940 − 手数料 9,059 = 79,881 が出る', dialogs.some(d => /88,940/.test(d) && /9,059/.test(d) && /79,881/.test(d)), dialogs.slice(-2).join(' | '));
  T(`発行: documents に 請求書 INV-${YM}-002（既存 001 の次）`, doc && doc.b.doc_type === '請求書' && doc.b.doc_number === `INV-${YM}-002`, doc && doc.b.doc_number);
  T('発行: 合計 79,881・税 6,588・発行済・未入金・source=sale_event・宛名 御中', doc && doc.b.total_amount === 79881 && doc.b.tax_amount === 6588 && doc.b.status === '発行済' && doc.b.billing_status === '未入金' && doc.b.source === 'sale_event' && doc.b.partner_name === '株式会社ニイチク' && doc.b.honorific === '御中', doc && JSON.stringify([doc.b.total_amount, doc.b.tax_amount, doc.b.status, doc.b.source]));
  const sn = doc && doc.b.snapshot;
  T('発行: スナップショットは受発注管理の請求書と同じ形（type/issuer/bank/lines）', sn && sn.type === '請求書' && sn.issuer.reg_number === 'T7040003010341' && sn.bank === SETTINGS.bank && sn.sale_event_id === 'e1' && Array.isArray(sn.order_ids), sn && JSON.stringify(Object.keys(sn)));
  T('発行: 明細は「売上（税抜）82,352・8%」と「販売手数料（11%）差引 −9,059・対象外」の2行', sn && sn.lines.length === 2 && sn.lines[0].amount === 82352 && sn.lines[0].tax === 8 && /8月29日 ニイチク直売会 売上（税抜）/.test(sn.lines[0].name) && sn.lines[1].amount === -9059 && sn.lines[1].tax === 0 && /11%/.test(sn.lines[1].name), sn && JSON.stringify(sn.lines));
  T('発行: 備考が請求書に載る', sn && /8月29日 即売会分/.test(sn.memo), sn && sn.memo);
  const di = writes.find(w => w.t === 'document_items');
  T('発行: document_items に2行（document_id=doc1）', di && di.b.length === 2 && di.b[0].document_id === 'doc1' && di.b[1].amount === -9059, JSON.stringify(di && di.b));
  const link = writes.filter(w => w.t === 'events' && w.id === 'e1').slice(-1)[0];
  T('発行: 出店に consign_doc_id が付く', link && link.b.consign_doc_id === 'doc1', JSON.stringify(link && link.b));
  const opened = await page.evaluate(() => window.__opened.map(w => ({ loc: w._loc, closed: w.closed })));
  T('発行: 押した直後に開いた印刷ウィンドウが order-admin.html?print=doc1 に向く', opened.length === 1 && opened[0].loc === 'order-admin.html?print=doc1' && !opened[0].closed, JSON.stringify(opened));
  const docBox = await $('#ev-cs-doc', 'textContent');
  T(`発行後: 画面に 請求書 INV-${YM}-002・¥79,881・未入金 と印刷ボタン`, new RegExp(`INV-${YM}-002`).test(docBox) && /79,881/.test(docBox) && /未入金/.test(docBox) && /印刷/.test(docBox), docBox.replace(/\s+/g, ' ').slice(0, 160));

  // ── 5b) もう発行済なら二重に発行しない ──
  const n1 = writes.filter(w => w.t === 'documents').length;
  await page.evaluate(() => evConsignIssue()); await page.waitForTimeout(200);
  T('発行済のまま「発行」→ 二重に作らず、番号を示して止まる', writes.filter(w => w.t === 'documents').length === n1 && new RegExp(`もう発行しています（INV-${YM}-002）`).test(dialogs[dialogs.length - 1] || ''), dialogs[dialogs.length - 1]);

  // ── 5c) 採番の競合 → 取り直す（取消済みの請求書がある出店で試す） ──
  DOCS.find(d => d.id === 'doc1').status = '取消';
  await page.evaluate(() => evConsignLoadDoc()); await page.waitForTimeout(200);
  T('取消済みなら「取消」と出て、発行し直せる', /取消/.test(await $('#ev-cs-doc', 'textContent')), '');
  docPostMode = 'dup_once';
  await page.evaluate(() => evConsignIssue()); await page.waitForTimeout(600);
  const dups = writes.filter(w => w.t === 'documents').slice(n1);
  T(`採番競合: 1回目 003 が重複 → 2回目は 004 で発行`, dups.length === 2 && dups[0].b.doc_number === `INV-${YM}-003` && dups[1].b.doc_number === `INV-${YM}-004`, JSON.stringify(dups.map(d => d.b.doc_number)));

  // ── 6) 失敗は画面に出る ──
  DOCS.find(d => d.id === 'doc2').status = '取消';
  await page.evaluate(() => evConsignLoadDoc()); await page.waitForTimeout(200);
  docPostMode = 'fail';
  await page.evaluate(() => evConsignIssue()); await page.waitForTimeout(400);
  const opened2 = await page.evaluate(() => window.__opened.map(w => ({ loc: w._loc, closed: w.closed })));
  T('documents への書込みが失敗 → 画面に「発行できませんでした」、開いた印刷ウィンドウは閉じる', /発行できませんでした/.test(await $('#ev-cs-msg', 'textContent')) && opened2[opened2.length - 1].closed && /発行できませんでした/.test(dialogs[dialogs.length - 1]), await $('#ev-cs-msg', 'textContent'));
  docPostMode = 'ok';

  // 委託でない出店先: 欄は出ず、リンクで出せる
  await page.evaluate(() => evOpen('e2')); await page.waitForTimeout(400);
  T('委託でない出店先（川島夜店市）では欄が出ず「委託販売として扱う」が出る', !(await vis('#ev-consign-sec')) && (await vis('#ev-consign-link')), '');
  await page.evaluate(() => evConsignShow()); await page.waitForTimeout(300);
  T('「委託販売として扱う」を押すと欄が出る（請求先は空）', (await vis('#ev-consign-sec')) && (await $('#ev-cs-billto')) === '', '');
  await page.evaluate(() => evConsignIssue()); await page.waitForTimeout(200);
  T('請求先が空のまま発行 → 止まる', /請求先/.test(dialogs[dialogs.length - 1] || ''), dialogs[dialogs.length - 1]);
  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 240) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
