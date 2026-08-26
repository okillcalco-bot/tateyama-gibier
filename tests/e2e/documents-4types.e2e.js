// 書類作成：見積書/納品書/請求書/領収書 の4種を同じエディタで作れ、変換で引き継げる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const CUSTOMERS = [{ id: 'c1', code: 'C0001', name: '株式会社CTIリード', kana: 'しーてぃーあい', price_rank: 'standard', is_active: true, search_aliases: [] }];
const DOCS = {
  '見積書': [{
    id: 'd1', doc_type: '見積書', doc_number: 'EST-202608-001', partner_name: '株式会社CTIリード', honorific: '御中',
    subject: 'R8環境調査補助', issue_date: '2026-08-20', due_date: '2026-09-19', total_amount: 462330, tax_amount: 42030,
    status: '発行済', customer_id: 'c1',
    snapshot: { type: '見積書', name: '株式会社CTIリード', honorific: '御中', subject: 'R8環境調査補助', date: '2026-08-20', due: '2026-09-19', customer_id: 'c1', order_ids: [], lines: [{ name: '現地調査', qty: 12, unit: '人・日', price: 23000, tax: 10, amount: 276000 }], issuer: { issuer_name: '合同会社アルコ' }, bank: '' }
  }],
  '請求書': [{
    id: 'd2', doc_type: '請求書', doc_number: 'INV-202608-003', partner_name: '旅するジビエ', honorific: '御中',
    issue_date: '2026-08-09', due_date: '2020-01-01', total_amount: 14814, tax_amount: 1097, status: '発行済',
    snapshot: { type: '請求書', name: '旅するジビエ', honorific: '御中', date: '2026-08-09', due: '2020-01-01', order_ids: [], lines: [{ name: 'ロース', qty: 2, unit: 'kg', price: 5000, tax: 8, amount: 10000 }], issuer: {}, bank: '千葉銀行' }
  }],
  '納品書': [], '領収書': []
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let posted = null;

  await page.route('**/rest/v1/**', route => {
    const u = route.request().url(), m = route.request().method();
    const J = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (m === 'POST' && /\/documents/.test(u)) {
      try { posted = JSON.parse(route.request().postData() || '[]'); } catch (e) {}
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify([{ id: 'new1' }]) });
    }
    if (m === 'POST' || m === 'PATCH' || m === 'DELETE') return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    if (/\/documents/.test(u)) {
      const mt = decodeURIComponent(u).match(/doc_type=eq\.([^&]+)/);
      if (mt) return J(DOCS[mt[1]] || []);
      return J([]);
    }
    if (/\/customers/.test(u)) return J(CUSTOMERS);
    return J([]);
  });
  await page.addInitScript(() => { try { localStorage.setItem('tg_staff_key', 'TESTKEY'); } catch (e) {} });

  const results = [];
  const dialogs = [];
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });

  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(700);
  await page.evaluate(() => { if (typeof openInvoiceTab === 'function') openInvoiceTab(); });
  await page.waitForTimeout(500);

  // 1) 4種類のタブが出る
  const tabs = await page.$$eval('#invTypeTabs button', els => els.map(e => e.textContent.trim()));
  results.push(['作成タブに4種類', ['見積書', '納品書', '請求書', '領収書'].every(t => tabs.includes(t)), tabs.join(',')]);

  // 2) 種類を変えるとラベルと採番接頭辞が変わる
  await page.evaluate(() => invSetType('見積書'));
  await page.waitForTimeout(250);
  const est = await page.evaluate(() => ({
    due: document.getElementById('invDueLabel').textContent,
    num: document.getElementById('invNumber').value,
    partner: document.getElementById('invPartnerLabel').textContent,
    proviso: document.getElementById('invProvisoRow').style.display
  }));
  results.push(['見積書: 期限ラベル=有効期限', est.due === '有効期限', est.due]);
  results.push(['見積書: 採番がEST-', /^EST-\d{6}-\d{3}$/.test(est.num), est.num]);
  results.push(['見積書: 宛先ラベルが見積先', /見積先/.test(est.partner), est.partner]);
  results.push(['見積書: 但し書きは非表示', est.proviso === 'none', est.proviso]);

  await page.evaluate(() => invSetType('領収書'));
  await page.waitForTimeout(250);
  const rcp = await page.evaluate(() => ({
    num: document.getElementById('invNumber').value,
    proviso: document.getElementById('invProvisoRow').style.display,
    due: document.getElementById('invDueLabel').textContent
  }));
  results.push(['領収書: 採番がRCP-', /^RCP-\d{6}-\d{3}$/.test(rcp.num), rcp.num]);
  results.push(['領収書: 但し書きが出る', rcp.proviso !== 'none', rcp.proviso]);
  results.push(['領収書: 期限ラベル=取引日', rcp.due === '取引日', rcp.due]);

  // 3) 印刷HTMLが種類ごとに変わる（表題・リード文・合計欄・収入印紙）
  const printed = await page.evaluate(() => {
    const out = {};
    const orig = window.open;
    window.open = () => ({ document: { open() {}, write(h) { out.html = h; }, close() {} } });
    const base = { name: 'テスト', honorific: '御中', date: '2026-08-26', due: '2026-08-26', issuer: {}, bank: '', lines: [{ name: 'ロース', qty: 10, unit: 'kg', price: 6000, tax: 8, amount: 60000 }] };
    const grab = (type, extra) => { out.html = ''; invRenderPrint(Object.assign({}, base, { type }, extra || {}), 'X-1', {}); return out.html; };
    const r = {
      est: grab('見積書'), dlv: grab('納品書'), inv: grab('請求書'),
      rcp: grab('領収書', { proviso: 'ジビエ肉代' }),
      rcpSmall: grab('領収書', { lines: [{ name: 'ミンチ', qty: 1, unit: 'kg', price: 3000, tax: 8, amount: 3000 }] })
    };
    window.open = orig;
    return r;
  });
  results.push(['見積書の表題とリード文', /見 積 書/.test(printed.est) && /お見積り申し上げます/.test(printed.est) && /お見積金額/.test(printed.est), '']);
  results.push(['納品書の表題とリード文', /納 品 書/.test(printed.dlv) && /納品いたしました/.test(printed.dlv), '']);
  results.push(['請求書の表題とリード文', /請 求 書/.test(printed.inv) && /ご請求申し上げます/.test(printed.inv), '']);
  results.push(['領収書の表題と但し書き', /領 収 書/.test(printed.rcp) && /但し ジビエ肉代 として/.test(printed.rcp), '']);
  results.push(['領収書5万円以上で収入印紙欄', /収入印紙/.test(printed.rcp), '']);
  results.push(['領収書5万円未満は印紙欄なし', !/収入印紙/.test(printed.rcpSmall), '']);
  results.push(['軽減税率8%の注記は維持', /軽減税率（8%）対象/.test(printed.inv), '']);

  // 4) 一覧が種類ごとに切り替わる＋変換ボタンが出る
  await page.evaluate(() => invSetListType('見積書'));
  await page.waitForTimeout(400);
  const listTxt = await page.$eval('#invListBody', el => el.innerText);
  const convBtns = await page.$$eval('#invListBody button', els => els.map(e => e.textContent.trim()));
  results.push(['見積書一覧に行が出る', /EST-202608-001/.test(listTxt), listTxt.split('\n')[0]]);
  results.push(['見積書に→納品書/→請求書の変換', convBtns.includes('→納品書') && convBtns.includes('→請求書'), convBtns.join(',')]);
  const thNum = await page.$eval('#invThNum', el => el.textContent);
  results.push(['見出しが見積番号になる', thNum === '見積番号', thNum]);

  // 5) 変換：見積書 → 請求書（明細と宛先を引き継ぐ）
  await page.evaluate(() => invConvert('d1', '請求書'));
  await page.waitForTimeout(400);
  const conv = await page.evaluate(() => ({
    type: invType, name: document.getElementById('invName').value,
    num: document.getElementById('invNumber').value,
    lines: invLines.map(l => l.name + ':' + l.amount).join('|'),
    lineCount: invLines.length
  }));
  results.push(['変換後は請求書になる', conv.type === '請求書', conv.type]);
  results.push(['変換で採番がINV-に', /^INV-\d{6}-\d{3}$/.test(conv.num), conv.num]);
  results.push(['変換で宛先を引き継ぐ', conv.name === '株式会社CTIリード', conv.name]);
  results.push(['変換で明細を引き継ぐ', /現地調査/.test(conv.lines), conv.lines]);

  // 6) 請求書一覧では未入金サマリーが出る（期限切れ含む）
  await page.evaluate(() => invSetListType('請求書'));
  await page.waitForTimeout(400);
  const bar = await page.evaluate(() => ({ disp: document.getElementById('invUnpaidBar').style.display, txt: document.getElementById('invUnpaidBar').innerText }));
  results.push(['請求書で未入金サマリー表示', bar.disp !== 'none' && /未入金合計/.test(bar.txt), bar.txt.replace(/\n/g, ' ')]);
  results.push(['期限超過を検知', /期限超過/.test(bar.txt), '']);

  // 7) 領収書一覧では未入金サマリーを出さない
  await page.evaluate(() => invSetListType('領収書'));
  await page.waitForTimeout(350);
  const bar2 = await page.$eval('#invUnpaidBar', el => el.style.display);
  results.push(['領収書では未入金バー非表示', bar2 === 'none', bar2]);

  results.push(['pageerrorなし', errors.length === 0, errors.join(' / ')]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' && got != null ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
