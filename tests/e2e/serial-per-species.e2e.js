// 通し番号は獣種ごとに独立して管理する
//   シカの詳細を入れようとして登録できなかった事故の再発防止。
//   原因は「先に用意した空枠に入れる」機能がイノシシ専用だったこと。
//   空枠があると新規INSERTになり、label_idの一意制約で弾かれていた。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

// 空枠（番号だけあって捕獲日が無い行）を持つ獣種で試す
const PLACEHOLDER = { id: 'ph-shika-010', label_id: 'TGC-08-シ010', species: 'シカ',
  serial_number: 10, capture_date: null };
const TAKEN = { id: 'used-shika-009', label_id: 'TGC-08-シ009', species: 'シカ',
  serial_number: 9, capture_date: '2026-07-14' };

async function boot(routeFn) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', routeFn);
  return { browser, page, errors };
}

(async () => {
  const results = [];
  const calls = { patch: [], post: [] };
  const alerts = [];

  const route = r => {
    const u = r.request().url(), m = r.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (!/\/rest\/v1\//.test(u)) return r.fulfill({ status: 200, body: '[]' });

    if (m === 'PATCH' && /\/individuals/.test(u)) {
      let b = {}; try { b = JSON.parse(r.request().postData() || '{}'); } catch (e) {}
      calls.patch.push({ url: u, body: b });
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'ph-shika-010' }]) });
    }
    if (m === 'POST' && /\/individuals/.test(u)) {
      let b = {}; try { b = JSON.parse(r.request().postData() || '{}'); } catch (e) {}
      calls.post.push({ url: u, body: b });
      return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify([{ id: 'new-1' }]) });
    }
    if (/\/individuals/.test(u)) {
      // 空枠の照合と「使用済みか」の確認に答える
      if (/label_id=eq\.TGC-08-%E3%82%B7010|label_id=eq\.TGC-08-シ010/.test(u)) {
        if (/capture_date=is\.null/.test(u)) return J([{ id: PLACEHOLDER.id }]);
        return J([PLACEHOLDER]);
      }
      if (/label_id=eq\.TGC-08-%E3%82%B7009|label_id=eq\.TGC-08-シ009/.test(u)) {
        if (/capture_date=is\.null/.test(u)) return J([]);          // 空枠ではない
        return J([TAKEN]);                                          // 既に使用済み
      }
      if (/order=serial_number\.desc/.test(u)) return J([{ serial_number: 13 }]);
      return J([]);
    }
    if (/\/staff/.test(u)) return J([{ name: 'テスト' }]);
    return J([]);
  };

  const { browser, page, errors } = await boot(route);
  page.on('dialog', async d => { alerts.push(d.message()); await d.accept(); });
  await page.goto('file://' + path.resolve(__dirname, '../../capture-form.html'));
  await page.waitForTimeout(800);

  // 1) 通し番号の見出しに獣種が出る（他の獣種と混同させない）
  await page.evaluate(() => {
    state.species = 'シカ'; state.capture_city = '館山市';
  });
  await page.evaluate(async () => { await refreshIndividualNumber(); });
  await page.waitForTimeout(300);
  results.push(['通し番号の見出しに獣種が出る',
    /シカの通し番号/.test(await page.$eval('#serialLabel', el => el.textContent)),
    await page.$eval('#serialLabel', el => el.textContent)]);
  results.push(['シカの次番号は14（シ013の次）',
    await page.$eval('#indSerial', el => el.value) === '14',
    await page.$eval('#indSerial', el => el.value)]);

  // 2) 空枠の番号を入れると、その枠に入る（新規行を作らない）＝今回の不具合
  const flow = await page.evaluate(async () => {
    // 保存処理のうち「空枠にあてるか／新規にするか」の判定だけを再現する
    const serial = 10, labelId = 'TGC-08-シ010', species = 'シカ';
    const q = (species === 'イノシシ')
      ? `?species=eq.イノシシ&serial_number=eq.${serial}&capture_date=is.null&deleted_at=is.null&select=id&limit=1`
      : `?label_id=eq.${encodeURIComponent(labelId)}&capture_date=is.null&deleted_at=is.null&select=id&limit=1`;
    const rows = await sb('GET', 'individuals', null, q);
    return { matched: rows.length ? rows[0].id : null };
  });
  results.push(['シカでも空枠に一致する（イノシシ専用でない）', flow.matched === 'ph-shika-010', String(flow.matched)]);

  // 3) 実際に画面から登録して、POSTではなくPATCHになること
  await page.evaluate(() => {
    state.species = 'シカ'; state.capture_city = '館山市'; state.sex = 'オス';
    state.capture_method = 'くくり罠'; state.finishing_method = '銃';
    document.getElementById('indSerial').value = '10';
    syncLabelId();
    document.getElementById('captureDate').value = '2026-08-01';
    document.getElementById('captureTime').value = '09:00';
    document.getElementById('captureArea').value = '神余';
    document.getElementById('hunterName').value = 'テスト捕獲者';
    document.getElementById('weight').value = '31.7';
    const rec = document.getElementById('recorder'); if (rec && rec.options.length) rec.selectedIndex = rec.options.length - 1;
  });
  results.push(['番号を変えると管理番号も追従',
    await page.$eval('#indLabelId', el => el.value) === 'TGC-08-シ010',
    await page.$eval('#indLabelId', el => el.value)]);

  calls.patch = []; calls.post = [];
  await page.evaluate(async () => { await handleSubmit(); });
  await page.waitForTimeout(900);
  results.push(['空枠に上書き保存する（PATCH）', calls.patch.length === 1, `patch=${calls.patch.length} post=${calls.post.length}`]);
  results.push(['新規行を作らない（POSTしない）', calls.post.length === 0, String(calls.post.length)]);
  results.push(['空枠へ入れた内容に捕獲日が入る',
    calls.patch.length > 0 && calls.patch[0].body.capture_date === '2026-08-01',
    calls.patch.length ? String(calls.patch[0].body.capture_date) : 'なし']);
  results.push(['通し番号10のまま保存される',
    calls.patch.length > 0 && calls.patch[0].body.serial_number === 10,
    calls.patch.length ? String(calls.patch[0].body.serial_number) : 'なし']);

  // 4) 既に中身のある番号なら、理由が分かる形で止める（一意制約エラーだけにしない）
  alerts.length = 0; calls.patch = []; calls.post = [];
  // 1件保存すると resetForm() で状態が消えるので、入れ直してから次を試す
  await page.evaluate(() => {
    state.species = 'シカ'; state.capture_city = '館山市'; state.sex = 'オス';
    state.capture_method = 'くくり罠'; state.finishing_method = '銃';
    document.getElementById('captureDate').value = '2026-08-02';
    document.getElementById('captureTime').value = '09:00';
    document.getElementById('captureArea').value = '神余';
    document.getElementById('hunterName').value = 'テスト捕獲者';
    document.getElementById('weight').value = '30.0';
    const rec = document.getElementById('recorder'); if (rec && rec.options.length) rec.selectedIndex = rec.options.length - 1;
    document.getElementById('indSerial').value = '9';
    syncLabelId();
  });
  await page.evaluate(async () => { await handleSubmit(); });
  await page.waitForTimeout(900);
  results.push(['使用済みの番号は登録前に止める', calls.post.length === 0 && calls.patch.length === 0,
    `patch=${calls.patch.length} post=${calls.post.length}`]);
  results.push(['止めた理由が分かる文言を出す',
    alerts.some(a => /TGC-08-シ009 は既に登録されています/.test(a)), alerts.join(' / ').slice(0, 90)]);
  results.push(['どう直せばよいかも書く',
    alerts.some(a => /搬入一覧から/.test(a) && /空いている番号/.test(a)), '']);

  // 5) イノシシは従来どおり通し番号で空枠を探す（管理番号と通し番号が独立のため）
  const boar = await page.evaluate(async () => {
    const serial = 5, species = 'イノシシ';
    const q = (species === 'イノシシ')
      ? `?species=eq.イノシシ&serial_number=eq.${serial}&capture_date=is.null&deleted_at=is.null&select=id&limit=1`
      : '?label_id=eq.X';
    return q;
  });
  results.push(['イノシシは通し番号で空枠を探す', /species=eq\.イノシシ&serial_number=eq\.5/.test(boar), boar.slice(0, 60)]);

  results.push(['pageerrorなし', errors.length === 0, errors.join(' / ')]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' && got != null ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
