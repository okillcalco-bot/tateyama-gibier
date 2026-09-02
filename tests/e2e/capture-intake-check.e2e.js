// 捕獲受入・個体一覧の「記入チェック」機能
// 見るポイント: ①止めさし(放血)→搬入(受入)が1時間超 ②台帳の未記入
// 解体担当者は未記載でも記録者でOK（＝チェック対象外）。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9091);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const ctx = await b.newContext({ viewport: { width: 1200, height: 900 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  // ネットワークは空で返す（初期化を通すだけ）
  await p.route('**/rest/v1/**', route => route.fulfill({ contentType: 'application/json', body: '[]' }));
  await p.route('**/auth/**', route => route.fulfill({ contentType: 'application/json', body: '{}' }));

  await p.goto('http://localhost:9091/index.html'); await p.waitForTimeout(600);

  const base = {
    species: 'イノシシ', sex: 'オス', weight_total: 34, capture_date: '2026-08-14', capture_time: '08:30',
    capture_city: '館山市', capture_area: '神余', hunter_name: '加藤茂', capture_method: 'くくり罠',
    finishing_method: 'ナイフ', bleed_time: '08:40', receive_time: '09:10', process_time: '09:20', recorder: '沖浩志',
  };
  // 個体単位チェッカーの単体確認
  const unit = await p.evaluate((base) => {
    const clean   = { ...base, label_id: 'TGC-08-T001' };
    const overtime= { ...base, label_id: 'TGC-08-T002', bleed_time: '08:00', receive_time: '10:00' }; // 120分
    const missing = { ...base, label_id: 'TGC-08-T003', recorder: '', receive_time: '' };
    const butcher = { ...base, label_id: 'TGC-08-T004', butcher_staff: '' }; // 解体担当空でも記録者あり→OK
    const zeroW   = { ...base, label_id: 'TGC-08-T005', weight_total: 0 };
    const provis  = { ...base, label_id: 'TGC-08-T006', intake_status: '搬入待ち' };
    const test    = { ...base, label_id: '仮-9999' };
    const R = x => indRecordIssues(x);
    return {
      clean: R(clean).length,
      overtimeHasTime: R(overtime).some(s => s.includes('止めさし→搬入') && s.includes('120')),
      overtimeLen: R(overtime).length,
      missingText: R(missing).join('|'),
      butcherLen: R(butcher).length,
      zeroWText: R(zeroW).join('|'),
      provisLen: R(provis).length,
      testLen: R(test).length,
    };
  }, base);
  ck('問題なし個体は0件', unit.clean === 0, String(unit.clean));
  ck('放血→受入120分を1時間超で検出', unit.overtimeHasTime && unit.overtimeLen === 1, JSON.stringify(unit));
  ck('記録者・受入未記入を検出', unit.missingText.includes('未記入') && unit.missingText.includes('記録者') && unit.missingText.includes('受入時刻'), unit.missingText);
  ck('受入が空なら時間超過は誤検出しない', !unit.missingText.includes('止めさし→搬入'), unit.missingText);
  ck('解体担当者が空でも記録者があればOK（不問）', unit.butcherLen === 0, String(unit.butcherLen));
  ck('体重0kgは未記入扱い', unit.zeroWText.includes('体重'), unit.zeroWText);
  ck('搬入待ち（仮登録）は対象外', unit.provisLen === 0, String(unit.provisLen));
  ck('テスト/仮番は対象外', unit.testLen === 0, String(unit.testLen));

  // 一覧描画：バッジ・件数・絞り込み
  const render = await p.evaluate((base) => {
    indAllData = [
      { ...base, label_id: 'TGC-08-T001' },                                             // OK
      { ...base, label_id: 'TGC-08-T002', bleed_time: '08:00', receive_time: '10:00' }, // 時間超
      { ...base, label_id: 'TGC-08-T003', recorder: '', receive_time: '' },             // 未記入
      { ...base, label_id: 'TGC-08-T004', butcher_staff: '' },                          // OK（解体担当空）
    ];
    indSortCol = 'label_id'; indSortAsc = true;
    document.getElementById('indIssuesOnly').checked = false;
    indRender();
    const countHtml = document.getElementById('ind-issue-count').textContent;
    const badgeAll = document.querySelectorAll('#ind-body tr').length;
    const warnBadges = [...document.querySelectorAll('#ind-body td span')].filter(s => s.textContent.includes('⚠')).length;
    // 絞り込みON
    document.getElementById('indIssuesOnly').checked = true;
    indRender();
    const rowsOnly = document.querySelectorAll('#ind-body tr').length;
    const labelsOnly = [...document.querySelectorAll('#ind-body tr td:nth-child(3)')].map(td => td.textContent.trim());
    const bodyText = document.getElementById('ind-body').textContent;
    return { countHtml, badgeAll, warnBadges, rowsOnly, labelsOnly, bodyText };
  }, base);
  ck('件数表示に「要確認 2件」', render.countHtml.includes('要確認 2件'), render.countHtml);
  ck('全4行を描画', render.badgeAll === 4, String(render.badgeAll));
  ck('⚠バッジは2件', render.warnBadges === 2, String(render.warnBadges));
  ck('要確認のみ絞り込みで2行', render.rowsOnly === 2, String(render.rowsOnly));
  ck('絞り込み結果はT002・T003', render.labelsOnly.join(',') === 'TGC-08-T002,TGC-08-T003', render.labelsOnly.join(','));
  ck('要確認の内容が画面に見える(止めさし→搬入)', render.bodyText.includes('止めさし→搬入'), render.bodyText.slice(0, 120));
  ck('要確認の内容が画面に見える(未記入)', render.bodyText.includes('未記入'), render.bodyText.slice(0, 120));

  ck('新機能でJSエラーなし', !errs.some(e => /indRecordIssues|indRender|IND_NEED/.test(e)), errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
