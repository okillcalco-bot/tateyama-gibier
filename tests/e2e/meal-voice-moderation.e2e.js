// 食べた人の声は「承認してから公開」する
//   ・お客様が書いた瞬間には公開ページに出ない
//   ・業務アプリの一覧で中身を見て、公開ボタンを押したものだけが出る
//   ・失敗を握り潰さない（保存に失敗したら画面に出す）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const PENDING = [
  { id: '11111111-1111-1111-1111-111111111111', scan_code: '10000783', individual_label: 'TGC-08-M167',
    nickname: '館山の田中', rating: 5, dish: 'ぼたん鍋', comment: '臭みが全くなく驚きました',
    at: '2026/08/26 19:30', status: 'pending', moderated_by: null, product: 'ミンチ肉（粗挽き）' },
  { id: '22222222-2222-2222-2222-222222222222', scan_code: '10000926', individual_label: 'TGC-08-T262',
    nickname: null, rating: null, dish: null, comment: '<script>alert(1)</script>',
    at: '2026/08/26 20:00', status: 'pending', moderated_by: null, product: 'スライス肉（1.5mm）' },
];
const PUBLISHED = [
  { id: '33333333-3333-3333-3333-333333333333', scan_code: '10000001', individual_label: 'TGC-08-M100',
    nickname: '沖', rating: 4, dish: 'カレー', comment: '子どもがよく食べました',
    at: '2026/08/25 12:00', status: 'published', moderated_by: '沖', product: 'ロース' },
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let moderateCalls = [];
  let failNext = false;

  await page.route('**/*', route => {
    const u = route.request().url(), m = route.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (!/\/rest\/v1\//.test(u)) { if (u.startsWith('file:')) return route.continue(); return route.fulfill({ status: 200, body: '[]' }); }
    const J = b => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/rpc\/staff_voices_list/.test(u)) {
      let b = {}; try { b = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      if (b.p_status === 'published') return J(PUBLISHED);
      if (b.p_status === 'rejected') return J([]);
      return J(PENDING);
    }
    if (/\/rpc\/staff_voice_moderate/.test(u)) {
      try { moderateCalls.push(JSON.parse(route.request().postData() || '{}')); } catch (e) {}
      if (failNext) return route.fulfill({ status: 400, contentType: 'application/json', body: '{"message":"権限がありません"}' });
      return J({ ok: true });
    }
    if (/\/rpc\//.test(u)) return J(null);
    if (m === 'POST' || m === 'PATCH') return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    return J([]);
  });
  await page.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  page.on('dialog', d => d.accept());

  const results = [];
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(700);

  // 1) ナビに「食べた人の声」タブがある
  results.push(['ナビにタブがある', await page.$('.tab-btn[data-tab="voices"]') !== null, '']);

  await page.click('.tab-btn[data-tab="voices"]');
  await page.waitForTimeout(500);

  // 2) 承認待ちが出て、判断に必要な情報が揃っている
  const t = await page.$eval('#panel-voices', el => el.innerText);
  results.push(['承認待ちの感想が出る', /館山の田中/.test(t) && /臭みが全くなく/.test(t), '']);
  results.push(['星が出る', /★{5}/.test(t), '']);
  results.push(['料理名が出る', /ぼたん鍋/.test(t), '']);
  results.push(['どの肉かが分かる', /ミンチ肉/.test(t) && /TGC-08-M167/.test(t) && /10000783/.test(t), '']);
  results.push(['公開前だと分かる説明がある', /公開するを押したものだけ/.test(t), '']);

  // 3) 感想の文章をHTMLとして実行しない（お客様が書いた文字がそのまま動くと危険）
  const html = await page.$eval('#vc-list', el => el.innerHTML);
  results.push(['書かれたタグを実行しない', !/<script>alert\(1\)<\/script>/.test(html) && /&lt;script&gt;/.test(html), '']);

  // 4) 公開ボタンで publish が飛ぶ（担当者名つき）
  await page.fill('#vc-operator', '沖');
  moderateCalls = [];
  await page.click('#vc-list .btn-primary');
  await page.waitForTimeout(500);
  const c1 = moderateCalls[0] || {};
  results.push(['公開ボタンでpublishを送る', c1.p_action === 'publish', String(c1.p_action)]);
  results.push(['対象のIDを送る', c1.p_id === PENDING[0].id, String(c1.p_id)]);
  results.push(['担当者名を送る', c1.p_by === '沖', String(c1.p_by)]);

  // 5) 却下ボタンで reject が飛ぶ
  moderateCalls = [];
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('#vc-list button')].filter(b => b.textContent.includes('却下'));
    btns[0].click();
  });
  await page.waitForTimeout(500);
  results.push(['却下ボタンでrejectを送る', (moderateCalls[0] || {}).p_action === 'reject', String((moderateCalls[0] || {}).p_action)]);

  // 6) 公開中タブでは「取り下げる」が出る
  await page.click('#vc-tab-published');
  await page.waitForTimeout(500);
  const t2 = await page.$eval('#vc-list', el => el.innerText);
  results.push(['公開中の一覧が出る', /子どもがよく食べました/.test(t2), '']);
  results.push(['公開中には取り下げボタン', /公開を取り下げる/.test(t2), '']);
  results.push(['承認した人が分かる', /沖/.test(t2), '']);

  moderateCalls = [];
  await page.evaluate(() => {
    [...document.querySelectorAll('#vc-list button')].find(b => b.textContent.includes('取り下げる')).click();
  });
  await page.waitForTimeout(500);
  results.push(['取り下げでunpublishを送る', (moderateCalls[0] || {}).p_action === 'unpublish', String((moderateCalls[0] || {}).p_action)]);

  // 7) 空のときは何もないと分かる
  await page.click('#vc-tab-rejected');
  await page.waitForTimeout(500);
  results.push(['0件のときの案内', /却下した感想はありません/.test(await page.$eval('#vc-list', el => el.innerText)), '']);

  // 8) 保存に失敗したら画面に出す（サイレント失敗を作らない）
  await page.click('#vc-tab-pending');
  await page.waitForTimeout(500);
  failNext = true;
  const toastText = await page.evaluate(async () => {
    document.querySelector('#vc-list .btn-primary').click();
    await new Promise(r => setTimeout(r, 700));
    return document.body.innerText;
  });
  results.push(['失敗を画面に出す', /失敗しました/.test(toastText), '']);
  failNext = false;

  // 9) 承認待ちの件数がナビのバッジに出る（お客様を待たせないため）
  await page.evaluate(() => refreshNavBadges());
  await page.waitForTimeout(700);
  results.push(['承認待ちの件数をバッジに出す',
    (await page.$eval('#nav-badge-voices', el => el.textContent)) === '2',
    await page.$eval('#nav-badge-voices', el => el.textContent)]);

  results.push(['pageerrorなし', errors.length === 0, errors.join(' / ')]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' && got != null ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
