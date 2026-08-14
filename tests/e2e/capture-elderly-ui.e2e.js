// 捕獲票入力の高齢者向け改修:
// 白地テーマ / 文字大 / 体重キーパッド / 必須マーク / 処理区分・市役所票用の削除 / 捕獲者→地区の自動入力
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/capture-form.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9076);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  await p.route('**/rest/v1/**', async route => {
    const url = decodeURIComponent(route.request().url());
    const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    if (url.includes('/area_master')) return j([
      { city: '館山市', district: '豊房', oaza: '神余', address_label: '神余' },
      { city: '館山市', district: '館山', oaza: '館山', address_label: '館山' },
    ]);
    return j([]);
  });
  await p.goto('http://localhost:9076/capture-form.html'); await p.waitForTimeout(600);

  // 1) 白地テーマ
  const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ck('白地背景（body=白）', bg === 'rgb(255, 255, 255)', bg);
  const htmlFs = await p.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  ck('基準文字が大きい（html≥18px）', parseFloat(htmlFs) >= 18, htmlFs);

  // 2) 必須マーク
  const reqCount = await p.evaluate(() => document.querySelectorAll('.req-badge').length);
  ck('必須マークが付いている（複数）', reqCount >= 6, String(reqCount));
  const reqLabels = await p.evaluate(() => [...document.querySelectorAll('.form-label')]
    .filter(l => l.querySelector('.req-badge')).map(l => l.textContent.replace('必須', '').trim()));
  ck('体重に必須マーク', reqLabels.some(t => t.includes('体重')), reqLabels.join(','));
  ck('捕獲者名に必須マーク', reqLabels.some(t => t.includes('捕獲者名')));
  ck('種別に必須マーク', reqLabels.some(t => t.includes('種別')));

  // 3) 体重キーパッド（「.」の切替不要）
  const wt = await p.evaluate(() => {
    document.getElementById('weight').value = '';
    ['4', '2', '.', '5'].forEach(k => wtKey(k));
    return document.getElementById('weight').value;
  });
  ck('数字ボタンで 42.5 が入る', wt === '42.5', wt);
  const wtDel = await p.evaluate(() => { wtKey('del'); return document.getElementById('weight').value; });
  ck('⌫で末尾を消せる', wtDel === '42.', wtDel);
  const padKeys = await p.evaluate(() => document.querySelectorAll('.wt-pad .wt-key').length);
  ck('キーパッドのボタンが12個', padKeys === 12, String(padKeys));

  // 4) 削除された項目
  ck('処理区分（分割/背割り）が無い', await p.evaluate(() => !document.querySelector('[data-field="processing_type"]')));
  ck('市役所票用「体長」入力が無い', await p.evaluate(() => !document.getElementById('bodyLength')));
  ck('市役所票用「処理方法」入力が無い', await p.evaluate(() => !document.getElementById('disposalMethod')));
  ck('市役所票用「わな設置日」が無い', await p.evaluate(() => !document.getElementById('trapSetDate')));
  ck('「市役所の調査票も作る」欄が無い', await p.evaluate(() => !document.getElementById('surveyOn')));
  ck('捕獲場所の地図（市役所票用）が無い', await p.evaluate(() => !document.getElementById('capMapWrap')));

  // 5) 捕獲者→地区の自動入力
  const auto = await p.evaluate(() => {
    const el = document.getElementById('hunterName');
    el.value = '加藤茂';
    onHunterPicked();
    return {
      area: document.getElementById('captureArea').value,
      oldTown: document.getElementById('captureOldTown').value,
      city: state.capture_city,
      hint: document.getElementById('hunterAreaHint').textContent,
      hintShown: document.getElementById('hunterAreaHint').style.display !== 'none',
    };
  });
  ck('加藤茂 → 大字「神余」を自動入力', auto.area === '神余', JSON.stringify(auto));
  ck('加藤茂 → 市町村「館山市」', auto.city === '館山市', auto.city);
  ck('加藤茂 → 地区「豊房」を補完', auto.oldTown === '豊房', auto.oldTown);
  ck('「いつもの場所」ヒント表示', auto.hintShown && auto.hint.includes('神余'), auto.hint);

  // 空白ゆらぎ（岩浪 優 / 岩浪優）でも引ける
  const norm = await p.evaluate(() => hunterUsualArea('岩浪 優'));
  ck('氏名の空白ゆらぎでも紐付く（岩浪 優）', !!norm && norm.area === '宮下', JSON.stringify(norm));

  // 既に地区が入っていれば自動上書きしない（別の捕獲者を選んでも尊重）
  const noOverride = await p.evaluate(() => {
    document.getElementById('captureArea').value = '手入力の場所';
    const el = document.getElementById('hunterName'); el.value = '沖浩志'; onHunterPicked();
    return document.getElementById('captureArea').value;
  });
  ck('入力済みの捕獲場所は自動上書きしない', noOverride === '手入力の場所', noOverride);

  // 6) ボタン名: 搬入登録
  ck('登録ボタンが「搬入登録」', await p.evaluate(() => document.getElementById('submitBtn').textContent.trim()) === '搬入登録');

  // 7) 搬入登録の直後は撮影用ボードを直接表示（ラベル印刷・次の入力ボタン付き）
  const board = await p.evaluate(() => {
    showBoard({ label_id: 'TGC-08-T272', serial_number: 458, species: 'イノシシ', capture_date: '2026-08-14',
      hunter_name: '沖浩志', capture_city: '館山市', capture_area: '布沼', sex: 'オス', weight_total: 34 }, true);
    return {
      shown: document.getElementById('boardOverlay').classList.contains('show'),
      sheet: document.getElementById('boardSheet').textContent,
      printBtn: document.getElementById('boardPrintBtn').style.display !== 'none',
      newBtn: document.getElementById('boardNewBtn').style.display !== 'none',
      detailHidden: document.getElementById('boardDetailBtn').style.display === 'none',
    };
  });
  ck('登録直後にボードが開く', board.shown);
  ck('ボードに個体番号が大きく出る', board.sheet.includes('TGC-08-T272'));
  ck('ボードに「ラベル印刷」ボタン', board.printBtn);
  ck('ボードに「次の入力へ」ボタン', board.newBtn);
  ck('登録直後は「詳細」ボタンは隠す', board.detailHidden);
  // ラベル印刷ボタン → ボードを閉じて印刷モーダル
  const toPrint = await p.evaluate(() => {
    boardPrintLabels();
    return { boardClosed: !document.getElementById('boardOverlay').classList.contains('show'),
             modalShown: document.getElementById('printModal').classList.contains('show') };
  });
  ck('ラベル印刷 → ボードを閉じ印刷モーダルを表示', toPrint.boardClosed && toPrint.modalShown, JSON.stringify(toPrint));

  ck('JSエラーなし', errs.length === 0, errs.join(' / '));

  // 8) 採番: 共有の開始番号を正とし、古い端末カウンタ(localStorage)に負けない
  const p2 = await ctx.newPage();
  const errs2 = []; p2.on('pageerror', e => errs2.push(String(e)));
  await p2.route('**/rest/v1/**', async route => {
    const url = decodeURIComponent(route.request().url());
    const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    if (url.includes('/app_settings') && url.includes('capture_numbering'))
      return j([{ value: { serial_start: 458, label_start_T: 272, label_start_M: 170 } }]);
    if (url.includes('/individuals')) {
      if (url.includes('capture_date=not.is.null')) return j([{ serial_number: 417 }]);           // dbNext=418
      if (url.includes('like.TGC-08-T')) return j([{ label_id: 'TGC-08-T251' }]);                  // dbLabelNext=252
      if (url.includes('like.TGC-08-M')) return j([{ label_id: 'TGC-08-M150' }]);
      return j([]);
    }
    if (url.includes('/area_master')) return j([{ city: '館山市', district: '豊房', oaza: '神余' }]);
    return j([]);
  });
  await p2.goto('http://localhost:9076/capture-form.html'); await p2.waitForTimeout(500);
  const num = await p2.evaluate(async () => {
    // 古い端末カウンタが残っている状況を再現（高い値）
    localStorage.setItem('tgc_next_serial_イノシシ', '999');
    localStorage.setItem('tgc_next_label_T', '999');
    await loadNumStart();
    // 種別イノシシ・館山市を選ぶ
    document.querySelector('[data-field="species"] [data-val="イノシシ"]').click();
    document.querySelector('[data-field="capture_city"] [data-val="館山市"]').click();
    await new Promise(r => setTimeout(r, 400));
    return {
      serial: document.getElementById('indSerial').value,
      label: document.getElementById('indLabelId').value,
      lsSerial: localStorage.getItem('tgc_next_serial_イノシシ'),
      lsLabel: localStorage.getItem('tgc_next_label_T'),
    };
  });
  ck('通し番号は開始番号458（古い端末カウンタ999を無視）', num.serial === '458', JSON.stringify(num));
  ck('館山の管理番号はT272（開始番号優先）', num.label === 'TGC-08-T272', num.label);
  ck('古い端末カウンタを自己修復で消す', num.lsSerial === null && num.lsLabel === null, JSON.stringify(num));
  ck('採番ページJSエラーなし', errs2.length === 0, errs2.join(' / '));

  // 9) 搬入方法（持込/引取）: 引取で担当者欄が出る
  const intake = await p.evaluate(() => {
    const before = document.getElementById('intakeStaffRow').style.display;
    document.querySelector('[data-field="intake_method"] [data-val="引取"]').click();
    const after = document.getElementById('intakeStaffRow').style.display;
    document.querySelector('[data-field="intake_method"] [data-val="持込"]').click();
    const back = document.getElementById('intakeStaffRow').style.display;
    return { before, after, back, method: state.intake_method };
  });
  ck('既定は持込で担当者欄は隠れる', intake.before === 'none');
  ck('引取を選ぶと担当者欄が出る', intake.after !== 'none', intake.after);
  ck('持込に戻すと担当者欄は隠れる', intake.back === 'none');

  // 10) 職員フィールド入力リンク ?staff=氏名
  const p3 = await ctx.newPage();
  const errs3 = []; p3.on('pageerror', e => errs3.push(String(e)));
  await p3.route('**/rest/v1/**', route => {
    const url = decodeURIComponent(route.request().url());
    const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    if (url.includes('/staff')) return j([{ name: '沖浩志' }, { name: '今泉' }]);
    return j([]);
  });
  await p3.goto('http://localhost:9076/capture-form.html?staff=' + encodeURIComponent('沖浩志'));
  await p3.waitForTimeout(1000);
  const staff = await p3.evaluate(() => ({
    recorder: document.getElementById('recorder').value,
    intakeStaff: document.getElementById('intakeStaff').value,
    method: state.intake_method,
    rowShown: document.getElementById('intakeStaffRow').style.display !== 'none',
    banner: document.body.textContent.includes('職員フィールド入力モード'),
    hunterEmpty: document.getElementById('hunterName').value === '',
    fullForm: document.getElementById('recorder').closest('.form-row').style.display !== 'none',
  }));
  ck('?staff= → 記録者を沖浩志に', staff.recorder === '沖浩志', JSON.stringify(staff));
  ck('?staff= → 引取担当を沖浩志に', staff.intakeStaff === '沖浩志');
  ck('?staff= → 搬入方法は引取・担当者欄表示', staff.method === '引取' && staff.rowShown);
  ck('?staff= → 職員モードの案内を表示', staff.banner);
  ck('?staff= → 捕獲者名は空（本人=記録者と別）', staff.hunterEmpty);
  ck('?staff= → フル画面（記録者欄も表示）', staff.fullForm);
  ck('職員リンクJSエラーなし', errs3.length === 0, errs3.join(' / '));

  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
