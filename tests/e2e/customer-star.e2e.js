// 顧客管理: スター（自動＋手動）・請求書/発送カラム・スターのみ絞り込みのスモーク
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const CUSTOMERS = [
  { id:'c1', code:'C0001', name:'エース商店', kana:'えーす', phone:'090', address:'A', price_rank:'standard', is_active:true, is_starred:false }, // 実績あり→自動★
  { id:'c2', code:'C0002', name:'手動VIP',   kana:'びっぷ', phone:'091', address:'B', price_rank:'local',    is_active:true, is_starred:true  }, // 手動★（実績なし）
  { id:'c3', code:'C0003', name:'ふつう客',   kana:'ふつう', phone:'092', address:'C', price_rank:'standard', is_active:true, is_starred:false }, // スターなし
];
const ORDERS = [{ id:'o1', customer_id:'c1', status:'発送済', order_items:[] }];
const SHIPMENTS = [{ customer_id:'c1', order_id:'o1' }, { customer_id:null, order_id:'o1' }]; // c1に2発送（1件はorder経由）
const INVOICES  = [{ customer_id:'c1', order_id:'o1' }]; // c1に請求書1

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c=>c.newPage());
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  let patchBody = null;

  await page.route('**/rest/v1/**', route => {
    const url = route.request().url();
    const method = route.request().method();
    if (method === 'PATCH' && /\/customers/.test(url)) { patchBody = route.request().postData(); return route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify([{}]) }); }
    let data = [];
    if (/\/customers/.test(url)) data = CUSTOMERS;
    else if (/\/shipments/.test(url)) data = SHIPMENTS;
    else if (/\/documents/.test(url)) data = INVOICES;
    else if (/\/orders/.test(url)) data = ORDERS;
    else if (/\/products|\/org_settings|\/invoice_settings|\/rpc\//.test(url)) data = [];
    return route.fulfill({ status:200, contentType:'application/json', body: JSON.stringify(data) });
  });
  // Supabase以外のCDN等は素通し（無ければ空）
  await page.addInitScript(() => { try{ localStorage.setItem('tg_staff_key','TESTKEY'); }catch(e){} });

  const fileUrl = 'file://' + path.resolve(__dirname, '../../order-admin.html');
  await page.goto(fileUrl);
  await page.waitForTimeout(800);

  // 顧客管理タブへ
  await page.click('.tab[data-tab="customers"]');
  await page.waitForTimeout(600);

  const results = [];
  const rowsText = await page.$$eval('#custBody tr', trs => trs.map(tr => tr.innerText.replace(/\n/g,' | ')));
  results.push(['行が3件描画される', rowsText.length === 3, rowsText.length]);

  // 並び順: スター（c1実績★, c2手動★）が上、c3が最後
  const firstCol = await page.$$eval('#custBody tr', trs => trs.map(tr => tr.querySelector('td:nth-child(2)').innerText));
  results.push(['3行目(最後)がC0003(スターなし)', firstCol[2] === 'C0003', firstCol.join(',')]);

  // ★/☆ 判定
  const stars = await page.$$eval('#custBody tr', trs => trs.map(tr => tr.querySelector('td:nth-child(1) span').innerText));
  const starOn = stars.filter(s => s === '★').length;
  results.push(['★が2件（c1自動+c2手動）', starOn === 2, stars.join('')]);
  results.push(['☆が1件（c3）', stars.filter(s=>s==='☆').length === 1, stars.join('')]);

  // 請求書/発送カラム（C0001=請求1・発送2）
  const c1row = await page.$$eval('#custBody tr', trs => {
    const tr = trs.find(t => t.querySelector('td:nth-child(2)').innerText === 'C0001');
    const tds = [...tr.querySelectorAll('td')].map(td=>td.innerText);
    return { inv: tds[tds.length-3], ship: tds[tds.length-2] };
  });
  results.push(['C0001 請求書=1', c1row.inv === '1', JSON.stringify(c1row)]);
  results.push(['C0001 発送=2', c1row.ship === '2', JSON.stringify(c1row)]);

  // スターのみ絞り込み → 2件
  await page.check('#custStarOnly');
  await page.waitForTimeout(300);
  const nStar = await page.$$eval('#custBody tr', trs => trs.length);
  results.push(['スターのみ=2件', nStar === 2, nStar]);
  await page.uncheck('#custStarOnly');
  await page.waitForTimeout(200);

  // 手動トグル: c3(☆)をクリックしてPATCH is_starred:true が飛ぶ
  await page.evaluate(() => toggleCustomerStar('c3'));
  await page.waitForTimeout(300);
  results.push(['c3クリックでPATCH is_starred:true', !!patchBody && /"is_starred":true/.test(patchBody), String(patchBody)]);

  // portalScope に starred オプション
  const hasStarScope = await page.$eval('#portalScope', el => !!el.querySelector('option[value="starred"]'));
  results.push(['portalScopeに⭐スター付きオプション', hasStarScope, hasStarScope]);

  results.push(['pageerrorなし', errors.length === 0, errors.join(' / ')]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok?'PASS':'FAIL')+' : '+name+'  ['+got+']'); if(ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
