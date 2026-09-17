// 業務アプリの「解析」タブ：
//   解析ページ（捕獲条件・フードマイレージ・売上）への入口と、「公的データで解析できそうなこと」の一覧があること。
//   座標の準備状況（地区／配送先／センター）が数字で出ること。取得に失敗したら画面に出ること。
//   ?tab=analysis で直接開けること。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

async function open(browser, { query = '', failGeo = false } = {}) {
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', rt => {
    const url = decodeURIComponent(rt.request().url());
    const J = (x, st) => rt.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (url.startsWith('file:')) return rt.continue();
    if (/cdnjs|jsdelivr|fonts\./.test(url)) return rt.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    if (/\/rest\/v1\/area_master\?select=id,lat/.test(url)) return J([{ id: 1, lat: 34.9 }, { id: 2, lat: null }, { id: 3, lat: null }]);
    if (/\/rest\/v1\/geo_cache/.test(url)) return failGeo ? rt.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' }) : J([{ q: 'a', lat: 35 }, { q: 'b', lat: null }]);
    if (/\/rest\/v1\/app_settings\?key=eq\.center_location/.test(url)) return J([{ value: { lat: 34.968, lng: 139.85, note: '仮の値。要確認' } }]);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html') + query);
  await page.waitForTimeout(900);
  return { page, errors };
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = []; const ck = (n, c, g) => results.push([n, c, g]);

  const { page, errors } = await open(browser);
  const nav = await page.evaluate(() => { const b = document.querySelector('.tab-btn[data-tab="analysis"]'); return b ? { text: b.textContent, group: (b.previousElementSibling || {}).textContent } : null; });
  ck('ナビに「解析」タブがあり、見出しグループが「解析」', nav && /解析/.test(nav.text) && nav.group === '解析', JSON.stringify(nav));
  await page.click('.tab-btn[data-tab="analysis"]');
  await page.waitForTimeout(500);
  const ui = await page.evaluate(() => ({
    active: document.getElementById('panel-analysis').classList.contains('active'),
    links: [...document.querySelectorAll('#an-cards a')].map(a => a.getAttribute('href')),
    rows: document.querySelectorAll('#an-public-table tbody tr').length,
    heads: [...document.querySelectorAll('#an-public-table thead th')].map(t => t.textContent),
    text: document.getElementById('panel-analysis').textContent,
    geo: document.getElementById('an-geo-status').textContent,
  }));
  ck('タブを押すと解析パネルが開く', ui.active, '');
  ck('解析ページへのリンク（捕獲条件・フードマイレージ・売上・過年度・買取・LCA）', ui.links.join() === 'catch-analysis.html,mileage-analysis.html,sales-dashboard.html,history.html,buyback.html,lca.html', ui.links.join());
  ck('公的データの一覧が12件以上', ui.rows >= 12, String(ui.rows));
  ck('一覧の列は「公的データ／出どころ／組み合わせる／解析すると出るかも／準備」', ui.heads.length === 5 && /公的データ/.test(ui.heads[0]) && /出どころ/.test(ui.heads[1]) && /出るかも/.test(ui.heads[3]) && /準備/.test(ui.heads[4]), ui.heads.join('|'));
  ck('人口統計・生産年齢人口・捕獲頭数・被害額・観光・放射性物質 が候補に入っている', ['国勢調査', '生産年齢人口', '捕獲頭数', '被害額', '観光入込', '放射性物質', '狩猟免許', '国土数値情報'].every(s => ui.text.includes(s)), '');
  ck('準備の状態が3種（今すぐ可／要るもの／稼働中）で出る', /今すぐ可/.test(ui.text) && /が要る/.test(ui.text) && /稼働中/.test(ui.text), '');
  ck('座標の準備: 地区 1／3・配送先 1件（見つからず 1）・センター仮の値', /捕獲地区 1／3地区/.test(ui.geo) && /配送先 1件（見つからず 1）/.test(ui.geo) && /仮の値/.test(ui.geo), ui.geo);
  ck('pageerrorなし', errors.length === 0, errors.join(' / '));
  await page.context().close();

  // ?tab=analysis で直接開く／準備状況の取得失敗は画面に出る
  const p2 = await open(browser, { query: '?tab=analysis', failGeo: true });
  await p2.page.waitForTimeout(400);
  const ui2 = await p2.page.evaluate(() => ({ active: document.getElementById('panel-analysis').classList.contains('active'), geo: document.getElementById('an-geo-status').textContent }));
  ck('?tab=analysis で直接開ける', ui2.active, '');
  ck('準備状況の取得失敗は画面に出る（握り潰さない）', /取得できませんでした/.test(ui2.geo), ui2.geo);
  ck('pageerrorなし(直接開く)', p2.errors.length === 0, p2.errors.join(' / '));

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
