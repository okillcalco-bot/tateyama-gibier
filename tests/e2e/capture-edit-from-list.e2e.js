// 捕獲票: 搬入一覧から個体を修正できる
// 一覧カード → 撮影ボード（✏️修正）／詳細モーダル（✏️この個体を修正）→ フォームに読み込み・入力タブへ
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/capture-form.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9078);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));

  const REC = {
    id: 'rec-1', label_id: 'TGC-08-T272', serial_number: 458, species: 'イノシシ', sex: 'オス',
    weight_total: 34, age_estimate: 2, capture_date: '2026-08-14', capture_time: '08:30',
    weather: '晴', capture_city: '館山市', capture_area: '神余', hunter_name: '加藤茂',
    capture_method: 'くくり罠', finishing_method: 'ナイフ', bleed_time: '08:40', receive_time: '09:10',
    quality: '良', recorder: '沖浩志', intake_method: '引取', intake_staff: '沖浩志', gutting: 'なし',
    hunter_health_ok: true, has_fetus: false, memo: 'テスト'
  };
  await p.route('**/rest/v1/**', async route => {
    const url = decodeURIComponent(route.request().url()); const m = route.request().method();
    const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    if (url.includes('/individuals') && m === 'GET') {
      if (url.includes('capture_date=eq.')) return j([REC]);   // loadList
      return j([]);
    }
    if (url.includes('/area_master')) return j([{ city: '館山市', district: '豊房', oaza: '神余' }]);
    return j([]);
  });
  await p.goto('http://localhost:9078/capture-form.html'); await p.waitForTimeout(500);

  // 搬入一覧タブへ → カード表示
  await p.evaluate(() => document.querySelector('[data-tab="list"]').click());
  await p.waitForTimeout(400);
  const cards = await p.evaluate(() => document.querySelectorAll('#cardList .card').length);
  ck('一覧にカードが出る', cards === 1, String(cards));

  // カード → 撮影ボード。修正ボタンが出ている
  await p.evaluate(() => document.querySelector('#cardList .card').click());
  await p.waitForTimeout(200);
  const boardEdit = await p.evaluate(() => ({
    boardShown: document.getElementById('boardOverlay').classList.contains('show'),
    editVisible: document.getElementById('boardEditBtn').style.display !== 'none',
    detailVisible: document.getElementById('boardDetailBtn').style.display !== 'none',
  }));
  ck('カードでボードが開く', boardEdit.boardShown);
  ck('ボードに「✏️修正」ボタン', boardEdit.editVisible);
  ck('ボードに「詳細」ボタン', boardEdit.detailVisible);

  // ボードの「✏️修正」→ 入力タブへ・編集モード・値が入る
  await p.evaluate(() => boardEdit());
  await p.waitForTimeout(300);
  const edit = await p.evaluate(() => ({
    boardClosed: !document.getElementById('boardOverlay').classList.contains('show'),
    formActive: document.getElementById('panel-form').classList.contains('active'),
    editMode: editMode === true,
    editRecordId: editRecordId,
    barShown: document.getElementById('editModeBar').style.display !== 'none',
    submitText: document.getElementById('submitBtn').textContent.trim(),
    weight: document.getElementById('weight').value,
    hunter: document.getElementById('hunterName').value,
    area: document.getElementById('captureArea').value,
    intakeStaff: document.getElementById('intakeStaff').value,
    intakeStaffShown: document.getElementById('intakeStaffRow').style.display !== 'none',
    speciesActive: document.querySelector('[data-field="species"] .toggle-btn.active')?.dataset.val,
    intakeActive: document.querySelector('[data-field="intake_method"] .toggle-btn.active')?.dataset.val,
  }));
  ck('修正 → ボードを閉じる', edit.boardClosed);
  ck('修正 → 捕獲票入力タブに切替', edit.formActive);
  ck('修正 → 編集モードON', edit.editMode && edit.editRecordId === 'rec-1', JSON.stringify(edit));
  ck('修正 → 修正バー表示・ボタン「修正を保存する」', edit.barShown && edit.submitText === '修正を保存する', edit.submitText);
  ck('修正 → 体重が入る(34)', edit.weight === '34', edit.weight);
  ck('修正 → 捕獲者が入る(加藤茂)', edit.hunter === '加藤茂', edit.hunter);
  ck('修正 → 捕獲場所が入る(神余)', edit.area === '神余', edit.area);
  ck('修正 → 種別トグルがイノシシ', edit.speciesActive === 'イノシシ', edit.speciesActive);
  ck('修正 → 搬入方法トグルが引取・担当者欄表示', edit.intakeActive === '引取' && edit.intakeStaffShown, JSON.stringify(edit));
  ck('修正 → 引取担当が入る(沖浩志)', edit.intakeStaff === '沖浩志', edit.intakeStaff);

  // 詳細モーダル経由でも修正できる
  await p.evaluate(() => { cancelEditMode(); showDetail(window._detailRecTest = { id: 'rec-2', label_id: 'TGC-08-M170', species: 'イノシシ', weight_total: 21, capture_date: '2026-08-14' }); });
  await p.waitForTimeout(150);
  const detailBtn = await p.evaluate(() => {
    const btns = [...document.querySelectorAll('#detailModal button')].map(x => x.textContent);
    return btns.some(t => t.includes('この個体を修正'));
  });
  ck('詳細モーダルに「✏️この個体を修正する」', detailBtn);
  const detailEditRes = await p.evaluate(() => {
    detailEdit();
    return { modalClosed: !document.getElementById('detailModal').classList.contains('show'),
             editMode: editMode === true, id: editRecordId,
             formActive: document.getElementById('panel-form').classList.contains('active') };
  });
  ck('詳細 → 修正で編集モード・入力タブ', detailEditRes.modalClosed && detailEditRes.editMode && detailEditRes.id === 'rec-2' && detailEditRes.formActive, JSON.stringify(detailEditRes));

  // 登録直後ボード（afterRegister）では修正ボタンを出さない
  const afterReg = await p.evaluate(() => {
    cancelEditMode();
    showBoard({ label_id: 'TGC-08-T273', species: 'イノシシ', capture_date: '2026-08-14' }, true);
    return document.getElementById('boardEditBtn').style.display;
  });
  ck('登録直後ボードでは修正ボタンを隠す', afterReg === 'none', afterReg);

  ck('JSエラーなし', errs.length === 0, errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
