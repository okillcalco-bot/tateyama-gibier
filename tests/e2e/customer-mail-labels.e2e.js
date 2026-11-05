// 顧客管理の「🏷 宛名ラベル（紙で送る請求先）」と、顧客台帳の「請求書の郵送先」
//
//   きっかけ（2026-11-05 沖）
//     「請求書を紙で送付する先をラベルシールKML-506-100で印刷できるようにしたい。追加登録できるようにしつつ…
//      顧客名簿とかから印刷できるように」。ある加工施設の請求書は施設ではなく
//      役場の担当課（宛名・住所が登録住所と違う）へ郵送する。
//
//   ここで測ること（顧客・住所はすべて架空）
//     1. 一覧に出るのは「送り方＝紙で郵送」かつ使用中の顧客だけ（PDF・未設定・使用停止は出ない）
//     2. 郵送先を登録した顧客は、郵送先の宛名・敬称・住所で出る（登録住所・顧客名は使わない）
//     3. チェックを外した顧客は印刷に入らない・件数表示が変わる
//     4. 「＋ 追加」で名簿の顧客を入れると送り方を「紙で郵送」に保存する（PDFの顧客は確認してから）
//     5. 「外す」で送り方を未設定に戻す（確認してから）・書込みの失敗は画面に出す
//     6. 実寸: KML-506（A4・70×33.9mm・3列×8段・上余白12.9mm）、使いかけシートの開始位置、
//        シートを使い切るよう同じ宛名を繰り返す（4件→6枚ずつ・1件→24枚）／1件あたりの枚数を選べる
//     7. 長い宛名（役場＋課＋御中で15文字）も1行に収まる（切れない）
//     8. 顧客編集で郵送先を保存できる。DBに列が無い間は郵送先を送らず、保存は失敗させない（知らせる）
//     9. 月まとめ発行の宛名ラベルも郵送先を使う
//    10. スマホ幅（390px）で画面が横にはみ出さない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let confirmAnswer = true; const dialogs = [];
  page.on('dialog', async d => { dialogs.push(d.type() + ':' + d.message()); if (d.type() === 'confirm') await (confirmAnswer ? d.accept() : d.dismiss()); else await d.dismiss(); });

  const LONG = '架空川町役場　産業振興課';   // 実際の「町役場＋課」の宛名と同じ12文字
  const M = { mail_name: null, mail_honorific: null, mail_address: null };   // 列がDBにある状態（select * にキーが出る）
  const CUSTS = [
    { id: 'c-a', code: 'C9101', name: '架空精肉株式会社', kana: 'かくうせいにく', honorific: '御中', address: '〒１２３－４５６７ 千葉県架空市本町1-2', building: '架空ビル3F', billing_method: 'paper', is_active: true, ...M },
    { id: 'c-b', code: 'C9102', name: '架空町イノシシ肉加工施設', kana: 'かくうちょう', honorific: '様', address: '〒999-9999 架空県架空郡架空町奥山1', billing_method: 'paper', is_active: true, ...M, mail_name: LONG, mail_honorific: '御中', mail_address: '〒999-0001　架空県架空郡架空町本郷９９９番地' },
    { id: 'c-c', code: 'C9103', name: '架空食堂', kana: 'かくうしょくどう', honorific: '様', address: '東京都架空区1-1', billing_method: 'pdf', is_active: true, ...M },
    { id: 'c-d', code: 'C9104', name: '架空停止商店', kana: 'かくうていし', honorific: '様', address: '東京都架空区2-2', billing_method: 'paper', is_active: false, ...M },
    { id: 'c-e', code: 'C9105', name: '架空住所なし', kana: 'かくうじゅうしょなし', honorific: '様', address: '', billing_method: 'paper', is_active: true, ...M },
    { id: 'c-f', code: 'C9106', name: '架空工房', kana: 'かくうこうぼう', honorific: '様', address: '〒111-2222 神奈川県架空市3-3', billing_method: null, is_active: true, ...M },
  ];
  const patches = []; let failNextPatch = false;
  await page.route('**/rest/v1/**', rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = (x, s = 200) => rt.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(x) });
    if (m === 'PATCH') {
      if (failNextPatch) { failNextPatch = false; return J({ message: 'テスト用の失敗' }, 500); }
      const body = JSON.parse(req.postData() || '{}'); patches.push({ url, body });
      const id = (url.match(/id=eq\.([^&]+)/) || [])[1]; const c = CUSTS.find(x => x.id === id);
      if (c) Object.assign(c, body);   // DBに書けた体（次の読み直しで返す）
      return J(c ? [{ ...c }] : []);
    }
    if (m !== 'GET') return J([]);
    if (/\/customers\b/.test(url)) return J(CUSTS.map(c => ({ ...c })));
    return J([]);
  });
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));
  await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await page.waitForTimeout(700);
  // 印刷画面は window.open で開く → 中身を受け取る
  await page.evaluate(() => { window.__pop = []; window.open = () => { const w = { document: { _h: '', open() {}, write(h) { this._h += h; }, close() {} }, close() {} }; window.__pop.push(w); return w; }; });
  const lastPop = () => page.evaluate(() => window.__pop.length ? window.__pop[window.__pop.length - 1].document._h : '');

  const results = [];
  const ck = (name, cond, got) => results.push([name, !!cond, got == null ? '' : String(got)]);

  await page.evaluate(() => switchTab('customers'));
  await page.waitForTimeout(200);
  ck('顧客管理に「🏷 宛名ラベル」のボタンがある', await page.evaluate(() => [...document.querySelectorAll('#tab-customers button')].some(b => /宛名ラベル/.test(b.textContent))), '');
  await page.evaluate(() => openMailLabels());
  await page.waitForTimeout(100);

  // 1. 一覧
  const rows = await page.$$eval('#mailLabelList .ml-row', rs => rs.map(r => ({ id: r.dataset.cid, txt: r.innerText })));
  const ids = rows.map(r => r.id).sort().join(',');
  ck('1. 紙で郵送・使用中の顧客だけが並ぶ（A・B・E。PDF・未設定・使用停止は出ない）', ids === 'c-a,c-b,c-e', ids);
  const rowA = rows.find(r => r.id === 'c-a'), rowB = rows.find(r => r.id === 'c-b'), rowE = rows.find(r => r.id === 'c-e');
  ck('1. 郵便番号は半角に直し、住所と建物名を並べる', rowA && /〒123-4567 千葉県架空市本町1-2 架空ビル3F/.test(rowA.txt) && /架空精肉株式会社　御中/.test(rowA.txt), rowA && rowA.txt);
  // 2. 郵送先
  ck('2. 郵送先を登録した顧客は郵送先の宛名・敬称で出る', rowB && rowB.txt.includes(LONG + '　御中') && !/架空町イノシシ肉加工施設　様/.test(rowB.txt), rowB && rowB.txt);
  ck('2. 郵送先の住所（〒999-0001）で出て、登録住所（奥山）は使わない', rowB && /〒999-0001/.test(rowB.txt) && !/奥山/.test(rowB.txt), rowB && rowB.txt);
  ck('2. 郵送先を別に登録していると分かる札が出る（顧客名も見える）', rowB && /郵送先を別に登録（顧客: 架空町イノシシ肉加工施設）/.test(rowB.txt), rowB && rowB.txt);
  ck('1. 住所の無い顧客は「住所未登録」と出る', rowE && /住所未登録/.test(rowE.txt), rowE && rowE.txt);

  // 3. チェックを外す
  const planNow = () => page.evaluate(() => ({ btn: document.getElementById('mailLabelPrintBtn').textContent, plan: document.getElementById('mailLabelPlan').textContent }));
  const pl3 = await planNow();
  ck('3. はじめは全部チェック → 3件 × 8枚 ＝ 24枚（シートを使い切る）', pl3.plan === '3件 × 8枚 ＝ 24枚（シート1枚・使い切り）' && pl3.btn === '🖨 24枚を印刷', JSON.stringify(pl3));
  await page.click('#mailLabelList .ml-row[data-cid="c-e"] .ml-use');
  const pl2 = await planNow();
  ck('3. 外すと件数が変わる → 2件 × 12枚 ＝ 24枚', pl2.plan === '2件 × 12枚 ＝ 24枚（シート1枚・使い切り）', JSON.stringify(pl2));

  // 4. 追加（未設定の顧客 → そのまま紙で郵送に）
  await page.fill('#mailLabelAdd', 'C9106 架空工房');
  await page.evaluate(() => mailLabelAddCustomer());
  await page.waitForTimeout(150);
  const pF = patches.find(p => /id=eq\.c-f/.test(p.url));
  ck('4. 追加すると送り方を「紙で郵送」に保存する（その1項目だけ）', pF && pF.body.billing_method === 'paper' && Object.keys(pF.body).length === 1, JSON.stringify(pF));
  ck('4. 追加した顧客が一覧に入り、チェックも入る（3件を印刷）', await page.$('#mailLabelList .ml-row[data-cid="c-f"] .ml-use:checked') && (await planNow()).plan.startsWith('3件 × 8枚'), '');
  ck('4. 追加欄は空に戻る', (await page.$eval('#mailLabelAdd', i => i.value)) === '', '');
  // PDFの顧客 → 確認で「いいえ」なら何もしない
  confirmAnswer = false; dialogs.length = 0;
  await page.fill('#mailLabelAdd', '架空食堂');
  await page.evaluate(() => mailLabelAddCustomer());
  await page.waitForTimeout(100);
  ck('4. PDFで送っている顧客は確認してから変える（いいえなら保存しない）', dialogs.some(d => /confirm:.*架空食堂.*PDF/.test(d)) && !patches.some(p => /id=eq\.c-c/.test(p.url)), dialogs.join(' / '));
  confirmAnswer = true;
  await page.evaluate(() => mailLabelAddCustomer());
  await page.waitForTimeout(150);
  ck('4. はいなら紙で郵送に変えて一覧に入る', patches.some(p => /id=eq\.c-c/.test(p.url) && p.body.billing_method === 'paper') && await page.$('#mailLabelList .ml-row[data-cid="c-c"]'), '');
  // 名簿で1件に決まらない語
  dialogs.length = 0;
  await page.fill('#mailLabelAdd', '架空');
  await page.evaluate(() => mailLabelAddCustomer());
  ck('4. 1件に決まらないときは知らせて何もしない', dialogs.some(d => /alert:.*1件に決まりませんでした/.test(d)), dialogs.join(' / '));

  // 5. 外す（失敗は画面に出す → 成功）
  dialogs.length = 0; failNextPatch = true;
  await page.evaluate(() => mailLabelRemove('c-c'));
  await page.waitForTimeout(150);
  ck('5. 書込みに失敗したら画面に出し、一覧から消さない', dialogs.some(d => /alert:外せませんでした/.test(d)) && await page.$('#mailLabelList .ml-row[data-cid="c-c"]'), dialogs.join(' / '));
  await page.evaluate(() => mailLabelRemove('c-c'));
  await page.waitForTimeout(150);
  const pRm = patches.filter(p => /id=eq\.c-c/.test(p.url)).pop();
  ck('5. 外すと送り方を未設定（null）に戻し、一覧から消える', pRm && pRm.body.billing_method === null && Object.keys(pRm.body).length === 1 && !(await page.$('#mailLabelList .ml-row[data-cid="c-c"]')), JSON.stringify(pRm));

  // 6. 印刷（5枚目から・A・B・F。Eはチェックを外した）
  await page.fill('#mailLabelStart', '5');
  await page.evaluate(() => mailLabelPrint());
  const html = await lastPop();
  ck('6. 印刷にはチェックした顧客だけ（A・B・F。Eは入らない）', /架空精肉株式会社　御中/.test(html) && html.includes(LONG + '　御中') && /架空工房　様/.test(html) && !/架空住所なし/.test(html), '');
  ck('6. 郵送先の顧客は郵送先の宛名・住所で刷る（施設名・奥山は刷らない）', /〒999-0001/.test(html) && /架空県架空郡架空町本郷９９９番地/.test(html) && !/架空町イノシシ肉加工施設/.test(html) && !/奥山/.test(html), '');
  const lp = await ctx.newPage();
  await lp.setContent(html.replace(/<script>window\.onload[\s\S]*?<\/script>/, ''), { waitUntil: 'load' });
  const geo = await lp.evaluate(() => {
    const px = 96 / 25.4; const ls = [...document.querySelectorAll('.lbl')];
    const r = ls.map(e => e.getBoundingClientRect());
    const filled = ls.map((e, i) => e.textContent.trim() ? i : -1).filter(i => i >= 0);
    const nms = [...document.querySelectorAll('.nm')].map(n => ({ t: n.textContent, over: n.scrollWidth > n.clientWidth + 1, cls: n.className, right: n.getBoundingClientRect().right, lblRight: n.closest('.lbl').getBoundingClientRect().right }));
    const vOver = ls.filter(e => e.scrollHeight > e.clientHeight + 1).map(e => e.textContent.slice(0, 20));
    return { n: ls.length, top: +(r[0].top / px).toFixed(1), w: +(r[0].width / px).toFixed(1), h: +(r[0].height / px).toFixed(1), x3: +(r[2].left / px).toFixed(1), y4: +(r[3].top / px).toFixed(1), filled, nms, vOver };
  });
  ck('6. どのラベルも中身が縦にはみ出さない（住所が2行に折り返しても宛名まで入る）', geo.vOver.length === 0, JSON.stringify(geo.vOver));
  ck('6. 実寸がKML-506どおり（上12.9mm・幅70mm・高さ33.9mm・3列目の左端140mm・2段目46.8mm）', geo.top === 12.9 && geo.w === 70 && geo.h === 33.9 && geo.x3 === 140 && geo.y4 === 46.8, JSON.stringify(geo).slice(0, 200));
  ck('6. 使いかけシート: 5枚目から刷る（1〜4枚目は空き・5〜24枚目を全部使う）', geo.filled.length === 20 && geo.filled[0] === 4 && geo.filled[19] === 23, JSON.stringify(geo.filled));
  // シートを使い切る（2026-11-05 沖「4件だったら6枚ずつ、1件だったら24枚」）: 残り20面を3件で 7・7・6、同じ宛名は続けて並ぶ
  const seq = geo.nms.map(x => x.t);
  const runs = []; seq.forEach(t => { if (runs.length && runs[runs.length - 1][0] === t) runs[runs.length - 1][1]++; else runs.push([t, 1]); });
  ck('6. 残りの20面を3件で埋める（7・7・6枚・同じ宛名は続けて並ぶ）', runs.length === 3 && runs.map(r => r[1]).join(',') === '7,7,6', JSON.stringify(runs));
  const nmB = geo.nms.find(x => x.t.includes(LONG));
  ck('7. 長い宛名（' + LONG + '　御中）も1行に収まり、ラベルからはみ出さない', nmB && !nmB.over && nmB.right <= nmB.lblRight, JSON.stringify(nmB));
  ck('7. 短い宛名は大きい字のまま（13pt）', geo.nms.filter(x => !x.t.includes(LONG)).every(x => x.cls === 'nm' && !x.over), JSON.stringify(geo.nms));
  const pdfBuf = await lp.pdf({ preferCSSPageSize: true });
  const lpdf = pdfBuf.toString('latin1');
  ck('6. A4 1枚に収まる', (lpdf.match(/\/Type\s*\/Page[^s]/g) || []).length === 1, '');
  // 印刷（PDF）で測る: 画面では収まっても印刷は字幅が広く、「…」で切れて敬称が消えたことがある（2026-11-05）
  //   → PDFの文字を取り出し、宛名が敬称まで全部刷られているかを見る（pdftotext が無ければ不合格にする＝未実行を合格にしない）
  const tmpPdf = path.join(require('os').tmpdir(), 'mail-labels-' + process.pid + '.pdf');
  require('fs').writeFileSync(tmpPdf, pdfBuf);
  let pdfText = null;
  try { pdfText = require('child_process').execFileSync('pdftotext', ['-layout', tmpPdf, '-'], { encoding: 'utf8' }); } catch (e) { pdfText = null; }
  try { require('fs').unlinkSync(tmpPdf); } catch (e) {}
  const flat = (pdfText || '').replace(/[\s　]+/g, '');
  ck('7. 印刷（PDF）でも長い宛名が敬称まで刷られる（' + LONG + '　御中・「…」で切れない）', pdfText != null && flat.includes(LONG.replace(/[\s　]+/g, '') + '御中') && !/…/.test(pdfText), pdfText == null ? 'pdftotext が無く測れない' : pdfText.replace(/\s+/g, ' ').slice(0, 200));
  ck('7. 印刷（PDF）で3件とも宛名が敬称まで刷られる', pdfText != null && flat.includes('架空精肉株式会社御中') && flat.includes('架空工房様'), pdfText == null ? 'pdftotext が無く測れない' : '');
  await lp.close();
  // 1件あたりの枚数を選べる（1枚ずつ → 5・6・7枚目だけ）
  await page.selectOption('#mailLabelCopies', '1');
  const pl1 = await planNow();
  ck('6. 1件あたり「1枚」を選ぶと 3件 × 1枚（5枚目から・残り17面）', pl1.plan === '3件 × 1枚 ＝ 3枚（シート1枚・17面あまり）' && pl1.btn === '🖨 3枚を印刷', JSON.stringify(pl1));
  await page.evaluate(() => mailLabelPrint());
  const html1 = await lastPop();
  ck('6. 「1枚」で刷ると宛名は3枚だけ', (html1.match(/class="nm"/g) || []).length === 3, String((html1.match(/class="nm"/g) || []).length));
  await page.selectOption('#mailLabelCopies', 'auto');
  await page.fill('#mailLabelStart', '1');
  // 割り振りの決まり（関数そのもの）
  const plans = await page.evaluate(() => {
    const f = (n, st, c) => { const p = invLabelPlan(n, st, c); return { counts: p.counts.join(','), total: p.total, sheets: p.sheets, spare: p.spare, text: invLabelPlanText(p) }; };
    return { one: f(1, 1, 'auto'), four: f(4, 1, 'auto'), five: f(5, 1, 'auto'), seven: f(7, 1, 'auto'), start5: f(3, 5, 'auto'), many: f(30, 1, 'auto'), two: f(4, 1, 2), zero: f(0, 1, 'auto') };
  });
  ck('割り振り: 1件 → 24枚', plans.one.counts === '24' && plans.one.text === '1件 × 24枚 ＝ 24枚（シート1枚・使い切り）', JSON.stringify(plans.one));
  ck('割り振り: 4件 → 6枚ずつ', plans.four.counts === '6,6,6,6' && plans.four.spare === 0, JSON.stringify(plans.four));
  ck('割り振り: 5件 → 5・5・5・5・4（割り切れない分は上から）', plans.five.counts === '5,5,5,5,4' && plans.five.total === 24 && plans.five.text === '5枚×4件・4枚×1件 ＝ 24枚（シート1枚・使い切り）', JSON.stringify(plans.five));
  ck('割り振り: 7件 → 4・4・4・3・3・3・3（24枚）', plans.seven.counts === '4,4,4,3,3,3,3' && plans.seven.total === 24, JSON.stringify(plans.seven));
  ck('割り振り: 使いかけ（5枚目から）3件 → 残り20面を 7・7・6', plans.start5.counts === '7,7,6' && plans.start5.spare === 0, JSON.stringify(plans.start5));
  ck('割り振り: 24件より多い（30件）→ 1枚ずつ・シート2枚', plans.many.total === 30 && plans.many.sheets === 2 && plans.many.spare === 18, JSON.stringify(plans.many));
  ck('割り振り: 枚数を指定（4件×2枚）→ 8枚・16面あまり', plans.two.counts === '2,2,2,2' && plans.two.spare === 16, JSON.stringify(plans.two));
  ck('割り振り: 0件は何も刷らない', plans.zero.total === 0 && plans.zero.text === '', JSON.stringify(plans.zero));
  // 何もチェックが無いときは知らせる
  dialogs.length = 0;
  await page.evaluate(() => { document.querySelectorAll('#mailLabelList .ml-use').forEach(cb => { if (cb.checked) cb.click(); }); mailLabelPrint(); });
  ck('3. チェックが1つも無いと知らせる', dialogs.some(d => /alert:印刷する請求先にチェック/.test(d)), dialogs.join(' / '));

  // 8. 顧客編集で郵送先を保存
  await page.evaluate(() => openEditCustomer('c-b'));
  const form = await page.evaluate(() => ({ n: cfMailName.value, h: cfMailHonorific.value, a: cfMailAddress.value }));
  ck('8. 顧客編集に郵送先が読み込まれる', form.n === '架空川町役場　産業振興課' && form.h === '御中' && /本郷/.test(form.a), JSON.stringify(form));
  await page.evaluate(() => { cfMailHonorific.value = '様'; return saveCustomer(); });
  await page.waitForTimeout(300);
  const pB = patches.filter(p => /id=eq\.c-b/.test(p.url)).pop();
  ck('8. 保存すると郵送先の3項目も送る', pB && pB.body.mail_name === '架空川町役場　産業振興課' && pB.body.mail_honorific === '様' && /本郷/.test(pB.body.mail_address), JSON.stringify(pB && pB.body));
  // 郵送先を空にしたら敬称も空に（宛名は顧客名・敬称に戻る）
  await page.evaluate(() => { openEditCustomer('c-a'); return saveCustomer(); });
  await page.waitForTimeout(300);
  const pA = patches.filter(p => /id=eq\.c-a/.test(p.url)).pop();
  ck('8. 郵送先が空の顧客は3項目とも空（null）で送る', pA && pA.body.mail_name === null && pA.body.mail_address === null && pA.body.mail_honorific === null, JSON.stringify(pA && pA.body));
  ck('8. 保存後に宛名ラベルの一覧も最新になる（Bは郵送先の敬称「様」に）', await page.evaluate(() => [...document.querySelectorAll('#mailLabelList .ml-name')].some(n => n.textContent === '架空川町役場　産業振興課　様')), '');
  // 列がまだDBに無い状態（select * に mail_* キーが無い）
  dialogs.length = 0;
  await page.evaluate(() => { allCustomers.forEach(c => { delete c.mail_name; delete c.mail_honorific; delete c.mail_address; }); openEditCustomer('c-f'); cfMailName.value = '架空の別宛名'; return saveCustomer(); });
  await page.waitForTimeout(300);
  const pNo = patches.filter(p => /id=eq\.c-f/.test(p.url)).pop();
  ck('8. DBに列が無い間は郵送先を送らない（ほかの項目は保存する）', pNo && !('mail_name' in pNo.body) && !('mail_address' in pNo.body) && !('mail_honorific' in pNo.body) && pNo.body.name === '架空工房', JSON.stringify(pNo && pNo.body));
  ck('8. そのとき郵送先を入れていたら、保存されないことを画面に出す', dialogs.some(d => /alert:.*郵送先.*まだデータベースにありません/.test(d)), dialogs.join(' / '));

  // 9. 月まとめ発行の宛名ラベルも郵送先を使う
  const t = await page.evaluate(() => {
    const B = { name: '架空町イノシシ肉加工施設', honorific: '様', address: '〒999-9999 架空県架空郡架空町奥山1', mail_name: '架空川町役場　産業振興課', mail_address: '〒999-0001 架空県架空郡架空町本郷999番地' };
    const onlyAdr = { name: '架空A', honorific: '様', address: '東京都1', mail_address: '〒100-0001 東京都架空区郵送先1' };
    const onlyName = { name: '架空B', honorific: '様', address: '〒100-0002 東京都架空区2', mail_name: '架空B 経理部' };
    return { B: invLabelTarget(B), onlyAdr: invLabelTarget(onlyAdr), onlyName: invLabelTarget(onlyName), plain: invLabelTarget({ name: '架空C', address: '〒１００－０００３ 東京都3', building: '3F' }) };
  });
  ck('9. 郵送先の宛名・住所 → 敬称は空なら「御中」', t.B.name === '架空川町役場　産業振興課' && t.B.honorific === '御中' && t.B.zip === '999-0001' && /本郷999番地/.test(t.B.adr), JSON.stringify(t.B));
  ck('9. 郵送先の住所だけ → 宛名は顧客名・登録の敬称', t.onlyAdr.name === '架空A' && t.onlyAdr.honorific === '様' && t.onlyAdr.zip === '100-0001', JSON.stringify(t.onlyAdr));
  ck('9. 郵送先の宛名だけ → 住所は登録住所', t.onlyName.name === '架空B 経理部' && t.onlyName.honorific === '御中' && t.onlyName.zip === '100-0002', JSON.stringify(t.onlyName));
  ck('9. 郵送先なし → 今までどおり（全角の郵便番号も半角・建物名つき・敬称なしは御中）', t.plain.name === '架空C' && t.plain.honorific === '御中' && t.plain.zip === '100-0003' && t.plain.adr === '東京都3 3F', JSON.stringify(t.plain));

  // 10. スマホ幅
  await page.evaluate(() => closeModal('custModal'));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { allCustomers.forEach(c => { if (c.id === 'c-b') { c.mail_name = '架空川町役場　産業振興課'; c.mail_address = '〒999-0001 架空県架空郡架空町本郷999番地'; } }); openMailLabels(); });
  await page.waitForTimeout(150);
  const mob = await page.evaluate(() => {
    const m = document.querySelector('#mailLabelModal .modal').getBoundingClientRect();
    const btns = [...document.querySelectorAll('#mailLabelModal button')].map(b => b.getBoundingClientRect()).filter(r => r.width > 0);
    return { sw: document.documentElement.scrollWidth, iw: innerWidth, mr: m.right, ml: m.left, out: btns.filter(r => r.right > m.right + 1 || r.left < m.left - 1).length };
  });
  ck('10. スマホ幅で横にはみ出さない（画面・ボタンとも）', mob.sw <= mob.iw && mob.out === 0 && mob.mr <= mob.iw, JSON.stringify(mob));

  ck('pageerrorなし', errors.length === 0, errors.join(' / '));
  await browser.close();
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + got.slice(0, 300) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
