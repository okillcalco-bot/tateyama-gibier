// 「この肉の物語」公開ページ：個体の一生が見え、感想を残せる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const STORY = {
  scan_code: '10000783',
  product: { name: 'ミンチ用', kg: 0.59, ident: 'TGC-08-M167-MU-2' },
  individual: {
    label: 'TGC-08-M167', species: 'イノシシ', sex: 'オス', weight_total: 42.5,
    capture_date: '2026/08/20', place: '南房総市 珠師ケ谷', method: '箱罠', is_juvenile: false,
    radiation_date: '2026/08/21', radiation_result: '検出下限値以下'
  },
  parts: [{ part: 'ロース', kg: 2.1 }, { part: 'ミンチ用', kg: 1.15 }],
  voices: [{ nickname: '館山の田中', rating: 5, dish: 'ぼたん鍋', comment: '臭みが全くなく驚きました', at: '2026/08/25' }]
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let posted = null, storyCalls = 0;

  await page.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith('file:')) return route.continue();
    const J = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/rpc\/story_get/.test(u)) {
      storyCalls++;
      let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      if (b.p_code !== '10000783') return J(null);          // 見つからない番号
      return J(STORY);
    }
    if (/rpc\/story_add_voice/.test(u)) {
      try { posted = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      return J({ ok: true });
    }
    return route.fulfill({ status: 200, body: '[]' });
  });

  const results = [];
  const file = 'file://' + path.resolve(__dirname, '../../s.html');

  // 1) 正しい番号 → 物語が出る
  await page.goto(file + '?c=10000783');
  await page.waitForTimeout(500);
  const t = await page.$eval('#main', el => el.innerText);
  results.push(['商品名と重さ', /ミンチ用/.test(t) && /0\.590 kg/.test(t), '']);
  results.push(['獲れた場所', /南房総市 珠師ケ谷/.test(t), '']);
  results.push(['獲れた日', /2026\/08\/20/.test(t), '']);
  results.push(['捕獲方法と鳥獣種', /箱罠/.test(t) && /イノシシ/.test(t) && /オス/.test(t), '']);
  results.push(['個体番号', /TGC-08-M167/.test(t), '']);
  results.push(['放射能検査の結果', /検出下限値以下/.test(t), '']);
  results.push(['部位の一覧', /ロース/.test(t) && /ミンチ用/.test(t), '']);
  results.push(['既存の声が出る', /館山の田中/.test(t) && /ぼたん鍋/.test(t) && /臭みが全くなく/.test(t), '']);

  // 2) 個人情報は出さない
  results.push(['捕獲者名を出さない', !/捕獲者/.test(t), '']);
  const html = await page.content();
  results.push(['座標を出さない', !/capture_lat|capture_lng/.test(html), '']);

  // 3) 星も感想も無いと送れない
  await page.click('#send');
  await page.waitForTimeout(200);
  results.push(['未入力は送信を止める', /どちらかを入れて/.test(await page.$eval('#msg', el => el.innerText)) && posted === null, '']);

  // 4) 星＋感想を送れる
  await page.click('#stars button[data-n="4"]');
  await page.fill('#dish', 'カレー');
  await page.fill('#comment', '子どもがよく食べました');
  await page.fill('#nickname', 'テスト太郎');
  await page.click('#send');
  await page.waitForTimeout(500);
  results.push(['感想を送信できる', posted && posted.p_code === '10000783' && posted.p_rating === 4
    && posted.p_dish === 'カレー' && /子どもがよく食べました/.test(posted.p_comment) && posted.p_nickname === 'テスト太郎',
    JSON.stringify(posted)]);
  results.push(['送信後にお礼を出す', /ありがとうございました/.test(await page.$eval('#msg', el => el.innerText)), '']);
  results.push(['送信後に物語を読み直す', storyCalls >= 2, String(storyCalls)]);

  // 5) 見つからない番号
  await page.goto(file + '?c=99999999');
  await page.waitForTimeout(400);
  results.push(['見つからない番号の案内', /見つかりませんでした/.test(await page.$eval('#main', el => el.innerText)), '']);

  // 6) 番号なしで開いた場合
  await page.goto(file);
  await page.waitForTimeout(300);
  results.push(['番号なしの案内', /QRコードから開いて/.test(await page.$eval('#main', el => el.innerText)), '']);

  // 7) スマホ幅で横スクロールしない
  await page.goto(file + '?c=10000783');
  await page.waitForTimeout(400);
  const of = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  results.push(['横スクロールしない', of <= 1, String(of)]);

  results.push(['pageerrorなし', errors.length === 0, errors.join(' / ')]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' && got != null ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
