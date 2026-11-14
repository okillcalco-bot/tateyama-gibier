// 宛名を間違えた請求書を出し直せるようにする（2026-11-14）
//
//   きっかけ
//     沖「宛名を間違えやすい入力方式なのに、間違えてからもう一度出そうとすると出せないのは困ります」
//     （DIR-20261112-001319 → INV-202611-054 の宛名違い。#421 で同じ注文の2枚目の請求書を止めたため、出し直す手段が無かった）
//
//   決め事: 2枚が同時に生きている状態（二重請求）は作らない。出し直すときは、元の請求書を「取消」にして（データは残す・番号は使い回さない）
//           新しい番号で作り直す。入金の記録がある請求書・ほかの注文もまとめた請求書は、ここでは取消さない。お客さんへは自動で送らない。
//
//   ここで測ること（顧客・注文・請求書は架空）
//     1. 同じ注文の請求書があると「出し直しますか？」と聞く（元の番号と宛名を見せる）
//     2. OK → 元の請求書を取消（理由をメモに残す）→ 発行してよい（true）
//     3. キャンセル → 何も変えずに止める
//     4. 入金の記録がある・入金済みの請求書は取消さずに止める
//     5. ほかの注文もまとめた請求書は取消さずに止める
//     6. 取消に失敗したら作り直さない
//     7. 書類発行タブ（generateDoc）からも同じように聞く
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const DOCS = {
    d1: { id: 'd1', order_id: 'o1', doc_type: '請求書', status: '発行済', doc_number: 'INV-TEST-101', partner_name: '架空の間違った宛名', billing_status: '未入金', memo: null },
    d2: { id: 'd2', order_id: 'o2', doc_type: '請求書', status: '発行済', doc_number: 'INV-TEST-102', partner_name: '架空食堂', billing_status: '一部入金', memo: null },
    d3: { id: 'd3', order_id: null, doc_type: '請求書', status: '発行済', doc_number: 'INV-TEST-103', partner_name: '架空食堂', billing_status: '未入金', memo: null },
  };
  const LINKS = [{ order_id: 'o1', document_id: 'd1' }, { order_id: 'o2', document_id: 'd2' }, { order_id: 'o3', document_id: 'd3' }, { order_id: 'o4', document_id: 'd3' }];
  const net = { patches: [], failPatch: false };
  await page.route('**/*', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    if (url.startsWith('file:')) return rt.continue();
    const J = (x, s) => rt.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (!/\/rest\/v1\//.test(url)) return rt.fulfill({ status: 200, contentType: 'text/plain', body: '' });
    const inIds = k => ((url.match(new RegExp('[?&]' + k + '=in\\.\\(([^)]*)\\)')) || [])[1] || '').split(',').filter(Boolean);
    const alive = d => d.status !== '取消';
    if (m === 'PATCH' && /\/documents\b/.test(url)) {
      if (net.failPatch) return J({ message: 'テスト用の失敗' }, 500);
      const id = (url.match(/id=eq\.([^&]+)/) || [])[1]; const b = JSON.parse(req.postData() || '{}');
      net.patches.push({ id, b });
      if (DOCS[id] && alive(DOCS[id])) { Object.assign(DOCS[id], b); return J([DOCS[id]]); }
      return J([]);
    }
    if (m !== 'GET') return J([{ id: 'new' }], 201);
    if (/\/documents\b/.test(url) && /order_id=in/.test(url)) { const ids = inIds('order_id'); return J(Object.values(DOCS).filter(d => ids.includes(d.order_id) && alive(d))); }
    if (/\/documents\b/.test(url) && /[?&]id=in/.test(url)) { const ids = inIds('id'); return J(Object.values(DOCS).filter(d => ids.includes(d.id))); }
    if (/\/document_orders\b/.test(url)) {
      const oid = inIds('order_id'), did = inIds('document_id');
      return J(LINKS.filter(l => (oid.length ? oid.includes(l.order_id) : did.includes(l.document_id))).map(l => Object.assign({}, l, /documents\(/.test(url) ? { documents: DOCS[l.document_id] } : {})));
    }
    if (/\/payments\b/.test(url)) return J([]);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(700);
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);
  const guard = (ids, answer) => page.evaluate(async ([ids, answer]) => {
    window.__a = []; window.__c = [];
    window.alert = m => window.__a.push(String(m)); window.confirm = m => { window.__c.push(String(m)); return answer; };
    const ok = await invGuardNoDoubleInvoice(ids, id => 'DIR-' + id);
    return { ok, a: window.__a, c: window.__c };
  }, [ids, answer]);

  // 3. キャンセル
  let g = await guard(['o1'], false);
  T('1. 同じ注文の請求書があると「出し直しますか？」と聞く（元の番号・宛名を見せる）', g.c.length === 1 && /出し直しますか/.test(g.c[0]) && /INV-TEST-101（宛名: 架空の間違った宛名）/.test(g.c[0]) && /自動では送りません/.test(g.c[0]), g.c.join(' / '));
  T('3. キャンセル → 止める・何も変えない', g.ok === false && net.patches.length === 0 && DOCS.d1.status === '発行済', JSON.stringify([g.ok, net.patches]));
  // 6. 取消に失敗
  net.failPatch = true;
  g = await guard(['o1'], true);
  net.failPatch = false;
  T('6. 取消に失敗したら作り直さない・理由を出す', g.ok === false && g.a.some(x => /取消できなかったため、作り直していません/.test(x)) && DOCS.d1.status === '発行済', JSON.stringify(g));
  // 2. OK
  g = await guard(['o1'], true);
  T('2. OK → 元の請求書を取消にして、発行してよい', g.ok === true && DOCS.d1.status === '取消', JSON.stringify([g.ok, DOCS.d1.status]));
  T('2. 取消の理由をメモに残す', /宛名などの訂正のため取消/.test(DOCS.d1.memo || ''), DOCS.d1.memo);
  T('2. 取消した後は、もう同じ注文の請求書は無い扱い（もう聞かない）', (await guard(['o1'], true)).ok === true && (await page.evaluate(() => window.__c.length)) === 0, '');
  // 4. 入金の記録あり
  net.patches.length = 0;
  g = await guard(['o2'], true);
  T('4. 入金の記録がある請求書は取消さずに止める', g.ok === false && g.c.length === 0 && g.a.some(x => /入金の記録がある請求書（INV-TEST-102）は、ここでは取消しません/.test(x)) && net.patches.length === 0, JSON.stringify(g));
  // 5. ほかの注文もまとめた請求書
  g = await guard(['o3'], true);
  T('5. ほかの注文もまとめた請求書は取消さずに止める', g.ok === false && g.c.length === 0 && g.a.some(x => /ほかの注文もまとめた請求書（INV-TEST-103）/.test(x)) && net.patches.length === 0 && DOCS.d3.status === '発行済', JSON.stringify(g));
  g = await guard(['o3', 'o4'], false);
  T('5. まとめた注文を全部選んでいれば、出し直すかを聞く', g.c.length === 1 && /INV-TEST-103/.test(g.c[0]), JSON.stringify(g));
  // 7. 書類発行タブ
  DOCS.d1.status = '発行済';
  const gd = await page.evaluate(async () => {
    window.__c = []; window.confirm = m => { window.__c.push(String(m)); return false; }; window.alert = () => {};
    await generateDoc('請求書', [{ id: 'o1', order_code: 'DIR-20261112-TEST', customer_name: '架空食堂', order_items: [] }]);
    return window.__c;
  });
  T('7. 書類発行タブからも「出し直しますか？」と聞く', gd.length >= 1 && /出し直しますか/.test(gd[0]) && /INV-TEST-101/.test(gd[0]), JSON.stringify(gd));

  T('ページエラーなし', errors.length === 0, errors.join(' / '));
  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 260) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
