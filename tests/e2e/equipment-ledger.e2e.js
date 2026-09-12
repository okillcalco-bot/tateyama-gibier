// 備品管理台帳（台帳タブ）: スプレッドシート「備品管理台帳（TGC）2025」を業務アプリへ移した
//
//   きっかけ（2026-09-12）
//     備品（3万円以上・借用品）の台帳がスプレッドシートだけにあり、監査や市への返却のときに
//     業務アプリから引けなかった。台帳（管理者のみ）に「備品台帳」タブを置き、
//     書類・帳票の「備品管理台帳」帳票と同じテーブル（equipment）を使う。
//
//   ここで測ること
//     1. ?tab=equipment（管理者）で備品台帳が開き、DBの行が管理番号順に並ぶ
//     2. 廃棄・返却済みは既定で隠れ、チェックで出る。使用中の件数と購入金額合計が出る
//     3. 検索で絞れる
//     4. 「＋備品を追加」で次の管理番号がプリセットされ、保存すると equipment に POST される
//     5. 管理番号の重複は保存前に止める
//     6. 帳票ハブに「備品管理台帳」がある（認証・監査対応）
//     7. スマホ幅で横スクロールしない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const ROWS = [
  { id: 'e1', mgmt_no: 1, name: 'レール', qty: 1, location: '放血室', purchased_on: '令和3年10月', price: 1500000, funding: null, note: null, status: '使用中', disposed_on: null },
  { id: 'e2', mgmt_no: 14, name: '大型冷凍庫2', qty: 1, location: '保管室', purchased_on: '令和4年8月', price: 528000, funding: null, note: null, status: '使用中', disposed_on: null },
  { id: 'e3', mgmt_no: 22, name: '真空包装機', qty: 1, location: 'カット室', purchased_on: null, price: null, funding: '館山市より借用', note: null, status: '使用中', disposed_on: null },
  { id: 'e4', mgmt_no: 8, name: '古い冷蔵庫', qty: 1, location: '保管室', purchased_on: '令和3年12月', price: 80000, funding: null, note: null, status: '廃棄', disposed_on: '2026-03-01' },
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());

  const posted = [];
  await page.route('**/*', r => {
    const u = r.request().url(), m = r.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/rest\/v1\/equipment/.test(u)) {
      if (m === 'POST') { const b = JSON.parse(r.request().postData() || '{}'); posted.push(b); ROWS.push(Object.assign({ id: 'new' + posted.length }, b)); return J([ROWS[ROWS.length - 1]]); }
      return J(ROWS.slice().sort((a, b) => (a.mgmt_no || 1e9) - (b.mgmt_no || 1e9)));
    }
    return J([]);
  });

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  await page.goto('file://' + path.resolve(__dirname, '../../index.html') + '?tab=equipment');
  await page.waitForTimeout(1000);

  // 1) タブが開き、管理番号順
  T('?tab=equipment で備品台帳が開く', await page.$eval('#panel-equipment', el => el.classList.contains('active')), '');
  const names = await page.$$eval('#equipment-body tr', trs => trs.map(t => t.children[1] && t.children[1].textContent.trim()));
  T('管理番号順に並ぶ（1→14→22）', JSON.stringify(names) === JSON.stringify(['レール', '大型冷凍庫2', '真空包装機']), names.join(','));
  T('借用品は購入情報が出る', /館山市より借用/.test(await page.$eval('#equipment-body', el => el.textContent)), '');

  // 2) 廃棄は既定で隠れる / 集計
  T('廃棄済みは既定で隠れる', !names.includes('古い冷蔵庫'), '');
  const stats = await page.$eval('#equipment-stats', el => el.textContent);
  T('使用中の件数と購入金額合計が出る', /使用中 3件/.test(stats) && /¥2,028,000/.test(stats), stats);
  await page.check('#equipment-show-disposed');
  await page.waitForTimeout(100);
  const names2 = await page.$$eval('#equipment-body tr', trs => trs.map(t => t.children[1] && t.children[1].textContent.trim()));
  T('チェックすると廃棄済みも出る', names2.includes('古い冷蔵庫'), names2.join(','));
  await page.uncheck('#equipment-show-disposed');

  // 3) 検索
  await page.fill('#equipment-search', '保管室');
  await page.waitForTimeout(100);
  const names3 = await page.$$eval('#equipment-body tr', trs => trs.map(t => t.children[1] && t.children[1].textContent.trim()));
  T('検索で絞れる（保管室 → 大型冷凍庫2）', JSON.stringify(names3) === JSON.stringify(['大型冷凍庫2']), names3.join(','));
  await page.fill('#equipment-search', '');

  // 4) 新規登録
  await page.click('button[onclick="equipOpenNew()"]');
  await page.waitForTimeout(100);
  T('新規登録で次の管理番号（23）がプリセット', (await page.$eval('#eq-f-mgmt_no', el => el.value)) === '23', await page.$eval('#eq-f-mgmt_no', el => el.value));
  T('新規登録で在庫数1・状態「使用中」がプリセット', (await page.$eval('#eq-f-qty', el => el.value)) === '1' && (await page.$eval('#eq-f-status', el => el.value)) === '使用中', '');

  // 5) 管理番号の重複は止める
  await page.fill('#eq-f-mgmt_no', '14');
  await page.fill('#eq-f-name', '冷凍ストッカー3');
  await page.click('button[onclick="equipSave()"]');
  await page.waitForTimeout(200);
  T('管理番号が重複すると保存されない', posted.length === 0 && (await page.$eval('#equipModal', el => el.style.display)) !== 'none', String(posted.length));

  await page.fill('#eq-f-mgmt_no', '25');
  await page.fill('#eq-f-location', '保管室');
  await page.fill('#eq-f-purchased_on', '令和8年9月');
  await page.fill('#eq-f-price', '65000');
  await page.click('button[onclick="equipSave()"]');
  await page.waitForTimeout(400);
  const p = posted[0] || {};
  T('保存すると equipment に POST される', posted.length === 1, String(posted.length));
  T('管理番号・備品名・場所・購入日・金額が数値/文字で保存', p.mgmt_no === 25 && p.name === '冷凍ストッカー3' && p.location === '保管室' && p.purchased_on === '令和8年9月' && p.price === 65000 && p.qty === 1 && p.status === '使用中', JSON.stringify(p).slice(0, 160));
  T('保存後に一覧へ反映', /冷凍ストッカー3/.test(await page.$eval('#equipment-body', el => el.textContent)), '');

  // 6) 帳票ハブ
  const docTitles = await page.evaluate(() => DOC_DEFS.filter(d => d.key === 'equipment_ledger').map(d => d.cat + '/' + d.title));
  T('帳票ハブに「備品管理台帳」がある（認証・監査対応）', docTitles[0] === '認証・監査対応/備品管理台帳', docTitles.join(','));
  const doc = await page.evaluate(async () => { const d = DOC_DEFS.find(x => x.key === 'equipment_ledger'); return d.gen('2026-09'); });
  T('帳票は台帳と同じ行を出す', doc.rows.length === ROWS.length && doc.columns[0] === 'No.' && doc.rows[0][1] === 'レール', String(doc.rows.length));
  T('CSV出力の一覧にも備品台帳がある', await page.evaluate(() => CSV_TABLES.some(t => t[0] === 'equipment')), '');

  // 7) スマホ幅
  const of = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  T('スマホ幅で横スクロールしない', of <= 1, String(of));

  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
