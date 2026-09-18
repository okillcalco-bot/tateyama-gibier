// 捕獲票（イノシシ以外）: 前回の個体と今回の番号を並べて見せ、日が空いていれば紙の台帳の未入力を疑わせる
//   事故（2026-09-18・市役所指摘）: 紙の台帳（様式2）を写真で後から入れる運用のため、7/22〜8/12 の 8 頭が
//   未入力のまま 8/19 に現場で新規登録され、「DBの最大＋1」＝キ053 が紙の キ053（7/22 渡邉）と重複。
//   同様に ア012〜018・ハ019〜021 も重複し、19 頭を付け替えた。
//   直し: 前回の個体（番号・捕獲日・捕獲者）を出し、14日以上空いていれば警告。紙の番号で登録する道も付ける。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const NOW = '2026-08-19T09:00:00+09:00';   // 8/19 に登録しようとしている
const LAST = {
  'キ': [{ serial_number: 52, label_id: 'TGC-08-キ052', capture_date: '2026-07-16', hunter_name: '加藤茂' }],   // 34日前
  'ハ': [{ serial_number: 19, label_id: 'TGC-08-ハ019', capture_date: '2026-08-18', hunter_name: '川口哲雄' }], // 1日前
  'ア': [],                                                                                                  // 今年度なし
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(fixed => {
    const RealDate = Date;
    function FakeDate(...a) { return a.length === 0 ? new RealDate(fixed) : new RealDate(...a); }
    FakeDate.prototype = RealDate.prototype; FakeDate.now = () => new RealDate(fixed).getTime();
    FakeDate.parse = RealDate.parse; FakeDate.UTC = RealDate.UTC; window.Date = FakeDate;
  }, NOW);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const dialogs = []; page.on('dialog', d => { dialogs.push(d.type() + ':' + d.message().slice(0, 60)); d.accept(); });
  const posts = [];
  await page.route('**/*', r => {
    const u = decodeURIComponent(r.request().url()), m = r.request().method();
    if (u.startsWith('file:')) return r.continue();
    if (/cdn|jsdelivr|fonts\./.test(u)) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    const J = x => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (/\/individuals/.test(u) && m === 'POST') { const b = JSON.parse(r.request().postData() || '{}'); posts.push(b); return J([Object.assign({ id: 'new-' + posts.length }, b, { label_id: String(b.label_id).replace(/^AUTO-(.)$/, 'TGC-08-$1999') })]); }
    if (/\/individuals/.test(u) && m === 'GET') {
      const mm = u.match(/label_id=like\.TGC-08-(.)\*/);
      if (mm) return J(LAST[mm[1]] || []);
      return J([]);
    }
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../capture-form.html'));
  await page.waitForTimeout(700);
  const results = []; const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);
  const pick = async (field, val) => { await page.evaluate(([f, v]) => document.querySelector(`[data-field="${f}"] .toggle-btn[data-val="${v}"]`).click(), [field, val]); await page.waitForTimeout(400); };
  const hint = () => page.evaluate(() => { const e = document.getElementById('numberHint'); return { shown: e.style.display !== 'none', cls: e.className, text: e.textContent.replace(/\s+/g, ' '), btn: !!e.querySelector('button') }; });

  // 1) キョン: 前回 キ052（7/16）から34日空き → 警告＋紙の番号ボタン
  await pick('species', 'キョン');
  const k = await hint();
  T('キョン: 前回 キ052（7/16 加藤茂）と今回 キ053 を並べて出す', k.shown && /TGC-08-キ052（7\/16 加藤茂）/.test(k.text) && /TGC-08-キ053/.test(k.text), k.text);
  T('キョン: 34日空いているので警告（紙の台帳の未入力を確かめる文言）', /warn/.test(k.cls) && /34日/.test(k.text) && /まだ入れていない個体/.test(k.text), k.cls + ' ' + k.text.slice(0, 80));
  T('キョン: 「紙の台帳の番号で登録する」ボタンあり', k.btn, '');
  const lab = await page.evaluate(() => document.getElementById('indLabelId').value);
  T('採番の表示は従来どおり TGC-08-キ053', lab === 'TGC-08-キ053', lab);

  // 2) ハクビシン: 前回が1日前 → 警告なしの案内だけ
  await pick('species', 'ハクビシン');
  const h = await hint();
  T('ハクビシン: 前回 ハ019（8/18） → 今回 ハ020、警告なし', h.shown && !/warn/.test(h.cls) && /前回 TGC-08-ハ019（8\/18 川口哲雄） → 今回 TGC-08-ハ020/.test(h.text), h.text);

  // 3) アライグマ: 今年度まだ無し
  await pick('species', 'アライグマ');
  const a = await hint();
  T('アライグマ: 今年度まだ登録なし → 今回 ア001', a.shown && /まだ登録がありません/.test(a.text) && /TGC-08-ア001/.test(a.text), a.text);

  // 4) イノシシは対象外（従来どおり非表示）
  await pick('species', 'イノシシ'); await pick('capture_city', '館山市');
  const b = await hint();
  T('イノシシ: 案内は出さない', !b.shown, b.text);

  // 5) 通常の新規登録は AUTO 採番のまま（キョン）
  await pick('species', 'キョン'); await pick('sex', 'オス');
  await page.fill('#hunterName', '石渡裕'); await page.fill('#weight', '6.05');
  await page.evaluate(() => handleSubmit()); await page.waitForTimeout(800);
  T('通常登録: label_id は AUTO-キ（DBトリガで採番）', posts.length === 1 && posts[0].label_id === 'AUTO-キ' && posts[0].serial_number === null, JSON.stringify(posts[0] && { l: posts[0].label_id, s: posts[0].serial_number }));

  // 6) 登録後は案内が消え、次の個体でまた出る（登録後は搬入一覧タブに移るので、捕獲票入力タブへ戻る）
  const after = await hint();
  T('登録後（resetForm）で案内は消える', !after.shown, after.text);
  await page.evaluate(() => document.querySelector('.tab[data-tab="form"]').click()); await page.waitForTimeout(300);
  await pick('species', 'キョン');
  const again = await hint();
  T('次の個体でまた案内が出る', again.shown && again.btn, again.text.slice(0, 60));

  // 7) 「紙の台帳の番号で登録する」→ 番号欄が開き、入れた番号（キ053）でそのまま登録される
  await page.evaluate(() => useManualNumber()); await page.waitForTimeout(200);
  const rowShown = await page.evaluate(() => ({ row: document.getElementById('indSerial').getBoundingClientRect().height > 0, note: document.getElementById('serialEditNote').textContent, manual: window.manualNumber === true, btn: !!document.querySelector('#numberHint button') }));
  T('番号欄が実際に見え、紙の番号を入れる案内が出る（ボタンは消える）', rowShown.row && /紙の台帳/.test(rowShown.note) && rowShown.manual && !rowShown.btn, JSON.stringify(rowShown));
  await page.fill('#indSerial', '53'); await page.evaluate(() => syncLabelId());
  const manLab = await page.evaluate(() => document.getElementById('indLabelId').value);
  T('通し番号 53 → 個体管理番号 TGC-08-キ053', manLab === 'TGC-08-キ053', manLab);
  await pick('sex', 'メス'); await page.fill('#hunterName', '渡邉利男'); await page.fill('#weight', '7.7');
  await page.evaluate(() => handleSubmit()); await page.waitForTimeout(800);
  T('紙の番号で登録: label_id=TGC-08-キ053・serial_number=53（AUTOではない）', posts.length === 2 && posts[1].label_id === 'TGC-08-キ053' && posts[1].serial_number === 53, JSON.stringify(posts[1] && { l: posts[1].label_id, s: posts[1].serial_number }));
  const manualAfter = await page.evaluate(() => ({ manual: !!window.manualNumber, row: document.getElementById('serialRow').style.display !== 'none' }));
  T('登録後は手入力モードが解除され番号欄も閉じる', !manualAfter.manual && !manualAfter.row, JSON.stringify(manualAfter));

  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
