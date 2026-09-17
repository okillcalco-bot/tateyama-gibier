// 捕獲者台帳（index.html）: 郵便番号の欄と、宛名ラベル印刷（コメリ KML-506 24面）ボタン
//   買取金額通知（buyback.html）の宛名ラベルと同じ用紙・同じレイアウト。レイアウトの実測は
//   buyback-print-margins.e2e.js で行っているので、ここは台帳側の配線だけを見る。
const pw = (() => { try { return require('/opt/node22/lib/node_modules/playwright'); } catch (e) { return require('playwright'); } })();
const { chromium } = pw;
const path = require('path');

const HUNTERS = [
  { id:'h1', name:'井上　定男', furigana:'いのうえさだお', city:'館山市', address:'館山市神余454', postal_code:'2940223' },
  { id:'h2', name:'山田千代子', furigana:'やまだちよこ', city:'館山市', address:'千葉県船橋市滝台2-13-13 603', postal_code:null },
  { id:'h3', name:'鈴木　太郎', furigana:'すずきたろう', city:'南房総市', address:null, postal_code:null },
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext(); await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_role_v1', 'admin'); localStorage.setItem('tg_staff_key', 'TESTKEY'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept('3枠'));
  const calls = [];
  await page.route('**/*', r => {
    const u = decodeURIComponent(r.request().url()), m = r.request().method();
    if (u.startsWith('file:')) return r.continue();
    if (/fonts\./.test(u)) return r.fulfill({ status: 200, body: '' });
    const J = x => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m !== 'GET') { let b = null; try { b = JSON.parse(r.request().postData() || 'null'); } catch (e) {} calls.push({ m, u, b }); return J(Array.isArray(b) ? b : [b]); }
    if (/\/hunters/.test(u)) return J(HUNTERS);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(800);
  const results = []; const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  await page.evaluate(() => loadHunters());
  await page.waitForTimeout(500);
  const n = await page.evaluate(() => huntersData.length);
  T('捕獲者台帳が読める（3人）', n === 3, n);

  // 郵便番号の欄がフォームにあり、保存時に payload に入る
  await page.evaluate(() => hunterEdit('h1'));
  const postal = await page.evaluate(() => document.getElementById('hun-f-postal_code').value);
  T('編集フォームに郵便番号が入る', postal === '2940223', postal);
  await page.fill('#hun-f-postal_code', '294-0223');
  await page.evaluate(() => hunterSave());
  await page.waitForTimeout(300);
  const patch = calls.find(c => c.m === 'PATCH' && /hunters/.test(c.u));
  T('保存すると postal_code が PATCH される', patch && patch.b.postal_code === '294-0223' && patch.b.address === '館山市神余454', JSON.stringify(patch && patch.b.postal_code));

  // 宛名ラベル: prompt で「3枠」→ 3枚目から・枠線あり
  const html = await page.evaluate(() => { let out = ''; const orig = window.open; window.open = () => ({ document: { write: h => { out += h; }, close(){} } }); try { hunterPrintLabels(); } finally { window.open = orig; } return out; });
  T('ラベルHTML: KML-506 のレイアウト（70mm×3列・33.9mm・上余白12.9mm・@page余白0）', /grid-template-columns:repeat\(3,70mm\)/.test(html) && /grid-auto-rows:33\.9mm/.test(html) && /padding-top:12\.9mm/.test(html) && /@page\{size:A4;margin:0\}/.test(html), html.length);
  T('ラベル: 3枚目から（空2枚）・枠線あり・3人分', (html.match(/<div class="lbl f"><\/div>/g)||[]).length === 2 && (html.match(/　様/g)||[]).length === 3 && (html.match(/class="sheet"/g)||[]).length === 1, (html.match(/　様/g)||[]).length);
  T('ラベル: 〒はハイフン付き・千葉県が付く・住所無しは「住所未登録」', /〒294-0223/.test(html) && /千葉県館山市神余454/.test(html) && /千葉県船橋市滝台/.test(html) && !/千葉県千葉県/.test(html) && /住所未登録/.test(html), '');
  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [nm, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + nm + (got ? '  [' + String(got).slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
