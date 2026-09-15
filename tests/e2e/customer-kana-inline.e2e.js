// 受発注管理 顧客台帳: ふりがなを行で直接入れて保存できる／請求書が多い順・ふりがな未入力を先に並べられる
//
//   きっかけ（2026-09-15）
//     ひらがなの予測変換は台帳の「ふりがな」が要るが、820件中156件しか入っていない。
//     「顧客台帳から入れられるように（請求回数が多い顧客をソートできるように）」との依頼。
//
//   ここで測ること
//     1. カナ列が入力欄になり、入れて欄を出ると PATCH customers {kana} が飛び、一覧の値も変わる
//     2. 保存に失敗したら元の値に戻り、失敗が画面（alert）に出る
//     3. 並び順「請求書が多い順」で請求書の枚数の降順、「ふりがな未入力→請求書が多い順」で未入力が先
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const CUSTOMERS = [
  { id: 'c1', code: 'C0001', name: '山海亭', kana: 'さんかいてい', is_active: true },
  { id: 'c2', code: 'C0002', name: 'キュイジーヌリアン', kana: null, is_active: true },
  { id: 'c3', code: 'C0003', name: 'にくひろ', kana: null, is_active: true },
  { id: 'c4', code: 'C0004', name: '植山', kana: 'うえやま', is_active: true },
];
const DOCS = [ // 請求書: c3 ×3, c2 ×2, c1 ×1
  { customer_id: 'c3', order_id: null }, { customer_id: 'c3', order_id: null }, { customer_id: 'c3', order_id: null },
  { customer_id: 'c2', order_id: null }, { customer_id: 'c2', order_id: null },
  { customer_id: 'c1', order_id: null },
];
const SHIPS = [{ customer_id: 'c4', order_id: null }, { customer_id: 'c4', order_id: null }, { customer_id: 'c4', order_id: null }, { customer_id: 'c4', order_id: null }];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const alerts = []; page.on('dialog', d => { alerts.push(d.message()); d.accept(); });
  const patches = []; let failPatch = false;
  await page.route('**/rest/v1/**', route => {
    const url = route.request().url(), method = route.request().method();
    const J = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/customers/.test(url) && method === 'PATCH') {
      patches.push({ qs: decodeURIComponent(url.split('?')[1] || ''), body: JSON.parse(route.request().postData() || '{}') });
      return failPatch ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' }) : J([{}]);
    }
    if (/\/customers/.test(url)) return J(CUSTOMERS);
    if (/\/documents/.test(url)) return J(DOCS);
    if (/\/shipments/.test(url)) return J(SHIPS);
    return J([]);
  });
  await page.addInitScript(() => { try { localStorage.setItem('tg_staff_key', 'TESTKEY'); } catch (e) {} });

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);
  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(900);
  await page.evaluate(() => switchTab('customers'));
  await page.waitForTimeout(600);

  const rowsOf = () => page.$$eval('#custBody tr', trs => trs.map(tr => ({ code: tr.children[1].textContent.trim(), kana: tr.querySelector('.cust-kana-inline')?.value })));
  let rows = await rowsOf();
  T('カナ列が入力欄になっている（4件）', rows.length === 4 && rows.every(r => r.kana !== undefined), JSON.stringify(rows));

  // 1) 入力して欄を出ると保存
  // 入力欄の change は Playwright の fill/blur でも飛ぶことがあるので、回数ではなく「c2 への PATCH の中身」で見る
  const inp = await page.$('#custBody tr:has-text("C0002") .cust-kana-inline');
  await inp.fill('きゅいじーぬりあん');
  await inp.dispatchEvent('change');
  await page.waitForTimeout(300);
  const p2 = patches.filter(p => /id=eq\.c2/.test(p.qs));
  T('ふりがなを入れると PATCH customers {kana} が飛ぶ', p2.length >= 1 && p2.every(p => p.body.kana === 'きゅいじーぬりあん'), JSON.stringify(patches));
  T('一覧のデータも更新される（再描画後も残る）', (await page.evaluate(() => { renderCustomers(); return allCustomers.find(c => c.id === 'c2').kana; })) === 'きゅいじーぬりあん', '');
  const before = patches.length;
  await (async () => { const el = await page.$('#custBody tr:has-text("C0002") .cust-kana-inline'); await el.fill('きゅいじーぬりあん'); await el.dispatchEvent('change'); await page.waitForTimeout(200); })();
  T('同じ値のままなら保存しない', patches.length === before, `${before}→${patches.length}`);

  // 2) 失敗は画面に出て元に戻る
  failPatch = true;
  const inp3 = await page.$('#custBody tr:has-text("C0003") .cust-kana-inline');
  await inp3.fill('にくひろ');
  await inp3.dispatchEvent('change');
  await page.waitForTimeout(400);
  T('保存失敗は alert で出て、欄の値が元（空）に戻る', alerts.some(a => /ふりがなの保存に失敗/.test(a)) && (await page.$eval('#custBody tr:has-text("C0003") .cust-kana-inline', el => el.value)) === '' && (await page.evaluate(() => allCustomers.find(c => c.id === 'c3').kana)) == null, alerts.join(' / '));
  failPatch = false;

  // 3) 並び順
  await page.selectOption('#custSort', 'inv');
  await page.waitForTimeout(200);
  rows = await rowsOf();
  T('「請求書が多い順」: C0003(3) → C0002(2) → C0001(1) → C0004(0)', rows.map(r => r.code).join(',') === 'C0003,C0002,C0001,C0004', rows.map(r => r.code).join(','));
  await page.selectOption('#custSort', 'ship');
  await page.waitForTimeout(200);
  rows = await rowsOf();
  T('「発送が多い順」: C0004(4) が先頭', rows[0].code === 'C0004', rows.map(r => r.code).join(','));
  await page.selectOption('#custSort', 'kana_missing');
  await page.waitForTimeout(200);
  rows = await rowsOf();
  T('「ふりがな未入力→請求書が多い順」: 未入力の C0003 が先頭、次にふりがな有りが請求書順', rows[0].code === 'C0003' && rows.slice(1).map(r => r.code).join(',') === 'C0002,C0001,C0004', rows.map(r => r.code + (r.kana ? '' : '(空)')).join(','));
  T('ふりがな未入力の欄は縁が目立つ色（gold）、入力済みは通常の縁', /solid var\(--gold\)/.test(await page.$eval('#custBody tr:has-text("C0003") .cust-kana-inline', el => el.getAttribute('style'))) && /solid var\(--border\)/.test(await page.$eval('#custBody tr:has-text("C0001") .cust-kana-inline', el => el.getAttribute('style'))), '');

  T('pageerrorなし', errors.length === 0, errors.join(' / '));
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
