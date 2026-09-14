// 捕獲票: 保存の失敗を「オフライン」と誤判定して黙って捨てない
//
//   きっかけ（2026-09-14）
//     引き取りの仮個体をセンターで本入力すると、採番トリガが M191 を付けようとし、削除済みの
//     TGC-08-M191 が一意制約で番号を塞いでいたため 23505 で失敗。捕獲票アプリは catch で何でも
//     「オフライン」扱いにして端末キューへ入れ、再送時に「23505＝登録済み」と判定して黙って捨てた。
//     現場からは「編集して保存しても何も更新されない」「通信ができてないみたい」に見えた。
//
//   ここで測ること
//     1. 修正の保存でDBが 409/23505 を返したら、画面に理由（個体番号の重複）を出し、キューに入れない。
//        入力は消えない（修正モードのまま）
//     2. 通信エラー（fetch失敗）なら従来どおりキューに入る。ただし修正は _patchId 付き（再送は PATCH）
//     3. 再送（syncPending）で 23505（label_id）は捨てずに残し、理由を付けて知らせる。
//        submit_ref の重複だけは「登録済み」として外す
//     4. PATCH が0行（DBに無い個体）のときも成功扱いにしない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/capture-form.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9081);
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const dialogs = []; page.on('dialog', d => { dialogs.push(d.type() + ':' + d.message()); d.accept(); });

  let mode = 'conflict';   // conflict | network | notfound | ok
  const calls = [];
  const DUP = '{"code":"23505","details":"Key (label_id)=(TGC-08-M191) already exists.","hint":null,"message":"duplicate key value violates unique constraint \\"individuals_label_id_key\\""}';
  await page.route('**/*', r => {
    const u = r.request().url(), m = r.request().method();
    if (u.startsWith('http://localhost:9081/')) return r.continue();
    if (/\/rest\/v1\/individuals/.test(u) && (m === 'PATCH' || m === 'POST')) {
      calls.push({ m, u: decodeURIComponent(u.split('?')[1] || ''), body: JSON.parse(r.request().postData() || '{}'), mode });
      if (mode === 'network') return r.abort('failed');
      if (mode === 'conflict') return r.fulfill({ status: 409, contentType: 'application/json', body: DUP });
      if (mode === 'notfound') return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      if (mode === 'dupref') return r.fulfill({ status: 409, contentType: 'application/json', body: DUP.replace('individuals_label_id_key', 'individuals_submit_ref_ukey').replace('(label_id)=(TGC-08-M191)', '(submit_ref)=(x)') });
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([Object.assign({ id: 'db1' }, calls[calls.length - 1].body, { label_id: 'TGC-08-M191', serial_number: 538 })]) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  await page.goto('http://localhost:9081/capture-form.html');
  await page.waitForTimeout(700);

  // 仮個体を編集モードで開く（引き取りで登録した個体をセンターで本入力する状況）
  const REC = { id: '8dafd5c7', label_id: '仮-MU0KAP0R', species: 'イノシシ', sex: 'メス', weight_total: 44, capture_date: '2026-09-14', capture_time: '08:30', hunter_name: '白石秀一', capture_city: '南房総市', capture_area: '山名', intake_status: '搬入待ち', intake_method: '引取', recorder: '沖浩志' };
  const openEdit = () => page.evaluate(r => { localStorage.removeItem('tgc_queue'); loadForEdit(r); }, REC);

  // 1) 一意制約違反 → 画面に理由を出す・キューに入れない・修正モードのまま
  mode = 'conflict'; dialogs.length = 0; calls.length = 0;
  await openEdit(); await page.waitForTimeout(200);
  await page.evaluate(() => handleSubmit());
  await page.waitForTimeout(800);
  const q1 = await page.evaluate(() => JSON.parse(localStorage.getItem('tgc_queue') || '[]'));
  T('23505: 保存は PATCH で送られる', calls.some(c => c.m === 'PATCH' && /id=eq\.8dafd5c7/.test(c.u)), JSON.stringify(calls.map(c => c.m + ' ' + c.u)));
  T('23505: 失敗の理由（個体番号の重複）が画面に出る', dialogs.some(d => /保存できませんでした/.test(d) && /TGC-08-M191/.test(d) && /削除済み/.test(d)), dialogs.join(' | ').slice(0, 200));
  T('23505: 端末キューに入れない（黙って再送→捨てる事故を防ぐ）', q1.length === 0, String(q1.length));
  T('23505: 修正モードのまま（入力は残る）', await page.evaluate(() => editMode === true && document.getElementById('hunterName').value === '白石秀一'), '');

  // 2) 通信エラー → キューに入る（修正は _patchId 付き）
  mode = 'network'; dialogs.length = 0; calls.length = 0;
  await page.evaluate(() => handleSubmit());
  await page.waitForTimeout(800);
  const q2 = await page.evaluate(() => JSON.parse(localStorage.getItem('tgc_queue') || '[]'));
  T('通信エラー: キューに入る', q2.length === 1, String(q2.length));
  T('通信エラー: 修正の再送は PATCH 用に _patchId を持つ', q2.length === 1 && q2[0]._patchId === '8dafd5c7', JSON.stringify(q2[0] && q2[0]._patchId));

  // 3) 再送: 23505(label_id) は残して知らせる／submit_ref 重複は外す
  mode = 'conflict'; dialogs.length = 0; calls.length = 0;
  await page.evaluate(() => syncPending());
  await page.waitForTimeout(500);
  const q3 = await page.evaluate(() => JSON.parse(localStorage.getItem('tgc_queue') || '[]'));
  T('再送: 修正は PATCH で送る（新規登録にしない）', calls.length === 1 && calls[0].m === 'PATCH' && /id=eq\.8dafd5c7/.test(calls[0].u) && !('_patchId' in calls[0].body), JSON.stringify(calls.map(c => c.m + ' ' + c.u)));
  T('再送: 個体番号の重複は捨てずに残す', q3.length === 1, String(q3.length));
  T('再送: 送れない理由がデータに付く', q3.length === 1 && /TGC-08-M191/.test(q3[0]._error || ''), (q3[0] || {})._error);
  T('再送: 受け付けられなかったことを知らせる', dialogs.some(d => /受け付けられませんでした/.test(d) && /TGC-08-M191/.test(d)), dialogs.join(' | ').slice(0, 160));
  await page.evaluate(() => showPendingModal());
  await page.waitForTimeout(100);
  T('未送信一覧に「修正の再送」と理由が出る', /修正の再送/.test(await page.$eval('#pendingModal', el => el.textContent)) && /送れない理由/.test(await page.$eval('#pendingModal', el => el.textContent)), '');
  await page.evaluate(() => document.getElementById('pendingModal').remove());

  mode = 'dupref'; dialogs.length = 0;
  await page.evaluate(() => syncPending());
  await page.waitForTimeout(500);
  const q4 = await page.evaluate(() => JSON.parse(localStorage.getItem('tgc_queue') || '[]'));
  T('再送: submit_ref の重複（＝登録済み）だけはキューから外す', q4.length === 0 && dialogs.length === 0, String(q4.length) + ' dialogs=' + dialogs.length);

  // 4) PATCH が0行 → 成功扱いにしない
  mode = 'notfound'; dialogs.length = 0; calls.length = 0;
  await openEdit(); await page.waitForTimeout(200);
  await page.evaluate(() => handleSubmit());
  await page.waitForTimeout(800);
  const q5 = await page.evaluate(() => JSON.parse(localStorage.getItem('tgc_queue') || '[]'));
  T('0行更新: DBに無い旨を画面に出し、キューにも入れない', dialogs.some(d => /DBにありません/.test(d)) && q5.length === 0, dialogs.join(' | ').slice(0, 160));

  // 5) 正常: 保存できたら修正モードが解除される
  mode = 'ok'; dialogs.length = 0;
  await page.evaluate(() => handleSubmit());
  await page.waitForTimeout(800);
  T('正常: 保存後は修正モードが解除される', await page.evaluate(() => editMode === false), '');

  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close(); srv.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
