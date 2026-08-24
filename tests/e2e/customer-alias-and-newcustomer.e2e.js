// 顧客の検索エイリアス（複数の読み方）と、手入力注文の新規顧客インライン登録のスモーク
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const CUSTOMERS = [
  { id: 'c1', code: 'C0001', name: '植山', kana: 'うえやま', phone: '090', address: '千葉県館山市1', price_rank: 'standard', is_active: true, search_aliases: ['エフユーアイジャパン', 'FUIジャパン'] },
  { id: 'c2', code: 'C0002', name: '田中', kana: 'たなか', phone: '091', price_rank: 'local', is_active: true, search_aliases: [] }
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  let postedCustomer = null;

  await page.route('**/rest/v1/**', route => {
    const url = route.request().url(), method = route.request().method();
    if (/\/customers/.test(url) && method === 'POST') {
      let body = {}; try { body = JSON.parse(route.request().postData() || '[{}]')[0]; } catch (e) {}
      postedCustomer = body;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ ...body, id: 'newid-1' }]) });
    }
    if (/\/customers/.test(url)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CUSTOMERS) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.addInitScript(() => { try { localStorage.setItem('tg_staff_key', 'TESTKEY'); } catch (e) {} });

  const results = [];
  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(800);

  // 1) 顧客管理のエイリアス検索：会社名で人が出る
  await page.evaluate(() => { document.getElementById('custSearch').value = 'エフユーアイ'; renderCustomers(); });
  await page.waitForTimeout(200);
  const aliasHit = await page.$$eval('#custBody tr', trs => trs.map(t => t.innerText).join(' | '));
  results.push(['会社名エイリアスで植山がヒット', /植山/.test(aliasHit) && !/田中/.test(aliasHit), aliasHit.slice(0, 40)]);

  // 2) 手入力注文：エイリアス入力で本人に解決
  const resolved = await page.evaluate(() => {
    document.getElementById('moCustomerInput').value = 'エフユーアイジャパン';
    onMoCustomerInput();
    return { id: document.getElementById('moCustomer').value, hit: document.getElementById('moCustomerHit').textContent };
  });
  results.push(['エイリアス入力→植山(c1)に解決', resolved.id === 'c1' && /植山/.test(resolved.hit), JSON.stringify(resolved)]);

  // 3) 新規のお客様をインライン登録して使う
  await page.evaluate(() => moToggleNewCustomer(true));
  const boxOpen = await page.$eval('#moNewCustomer', el => el.style.display !== 'none');
  results.push(['新規登録欄が開く', boxOpen, boxOpen]);
  await page.evaluate(() => {
    document.getElementById('mnName').value = '新規カフェ';
    document.getElementById('mnPhone').value = '0470-11-2222';
    document.getElementById('mnAliases').value = 'しんきカフェ\nSHINKI';
  });
  await page.evaluate(() => moSaveNewCustomer());
  await page.waitForTimeout(300);
  const afterNew = await page.evaluate(() => ({
    id: document.getElementById('moCustomer').value,
    hit: document.getElementById('moCustomerHit').textContent,
    boxHidden: document.getElementById('moNewCustomer').style.display === 'none'
  }));
  results.push(['新規登録→その注文の宛先に設定', afterNew.id === 'newid-1' && /新規登録/.test(afterNew.hit), JSON.stringify(afterNew)]);
  results.push(['登録欄が閉じる', afterNew.boxHidden, afterNew.boxHidden]);
  results.push(['POSTにエイリアス配列が入る', postedCustomer && Array.isArray(postedCustomer.search_aliases) && postedCustomer.search_aliases.includes('しんきカフェ') && postedCustomer.search_aliases.includes('SHINKI'), JSON.stringify(postedCustomer && postedCustomer.search_aliases)]);
  results.push(['POSTに名前が入る', postedCustomer && postedCustomer.name === '新規カフェ', postedCustomer && postedCustomer.name]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' && got != null ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
