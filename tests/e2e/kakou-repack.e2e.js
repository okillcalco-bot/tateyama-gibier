// 加工処理：登録済みバッチに「追加パック」を別サイズで登録・ラベル印刷できる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let postedInv = null, postedLog = null;

  await page.route('**/*', route => {
    const u = route.request().url(), m = route.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return route.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (!/\/rest\/v1\//.test(u)) { if (u.startsWith('file:')) return route.continue(); return route.fulfill({ status: 200, body: '[]' }); }
    // 追加パックPOST
    if (m === 'POST' && /\/inventory/.test(u)) { try { postedInv = JSON.parse(route.request().postData() || '[]'); } catch (e) {} return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    if (m === 'POST' && /\/processing_log/.test(u)) { try { postedLog = JSON.parse(route.request().postData() || '[]'); } catch (e) {} return route.fulfill({ status: 201, contentType: 'application/json', body: '[]' }); }
    // 最近の加工処理（tier3を in庫 から集計）
    if (m === 'GET' && /\/inventory/.test(u) && /or=\(individual_code\.like\.TGC-MIB/.test(u)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
        { individual_code: 'TGC-MIB-20260826-001', part_name: 'ミンチ肉（粗挽き）', process_type: 'ミンチ肉（粗挽き）', species: 'イノシシ', weight: '0.25', weight_kg: '0.250', operator: '沖浩志', processed_by: '沖浩志', processed_at: '2026-08-26T03:06:20Z', created_at: '2026-08-26T03:06:20Z' },
        { individual_code: 'TGC-MIB-20260826-001', part_name: 'ミンチ肉（粗挽き）', process_type: 'ミンチ肉（粗挽き）', species: 'イノシシ', weight: '1', weight_kg: '1.000', operator: '沖浩志', processed_by: '沖浩志', processed_at: '2026-08-26T05:00:00Z', created_at: '2026-08-26T05:00:00Z' }
      ]) });
    }
    // バッチの既存パック（1件目＝規格の元）
    if (m === 'GET' && /\/inventory/.test(u) && /individual_code=eq\./.test(u)) {
      if (/limit=1/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ species: 'イノシシ', part_name: 'ミンチ肉（粗挽き）', process_type: 'ミンチ肉（粗挽き）', weight: '0.25', weight_kg: '0.250', parent_inventory_id: 'P-1', location_code: 'F1' }]) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ weight: '0.25', weight_kg: '0.250' }, { weight: '0.25', weight_kg: '0.250' }, { weight: '1', weight_kg: '1.000' }]) });
    }
    // スタッフ名簿は公開VIEW経由（P0-2）。作業者選択の元になる
    if (m === 'GET' && /\/staff_public/.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 's1', name: '沖浩志', is_active: true, default_break_min: 60 }]) });
    // 連番採番（今日の最大＝003）
    if (m === 'GET' && /\/inventory/.test(u) && /ident_code=like\./.test(u)) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ ident_code: 'TGC-MI-99999999-003' }]) });
    // その他GET（processing_log等）
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });

  const results = [];
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(600);

  // モーダルを開く
  await page.evaluate(async () => { await kkRepackOpen('TGC-MIB-20260826-001'); });
  await page.waitForTimeout(300);
  const batch = await page.evaluate(() => kkRepackBatch);
  results.push(['バッチ情報が読み込まれる', batch && batch.prodName === 'ミンチ肉（粗挽き）' && batch.species === 'イノシシ' && batch.parent_inventory_id === 'P-1', JSON.stringify(batch)]);
  const infoShown = await page.$eval('#kk-rp-info', el => el.innerText);
  results.push(['既存パック規格を表示', /0.25kg×2/.test(infoShown) && /1kg×1/.test(infoShown), infoShown.replace(/\n/g, ' ')]);

  // 1kg × 3パックで登録
  await page.evaluate(() => {
    window.confirm = () => true;
    document.getElementById('kk-rp-operator').value = (PM_OPERATORS[0] || 'テスト');
    document.getElementById('kk-rp-w').value = '1';
    document.getElementById('kk-rp-n').value = '3';
    kkRepackUpdateSummary();
  });
  const summ = await page.$eval('#kk-rp-summary', el => el.innerText);
  results.push(['合計プレビュー 3.00kg', /3\.00kg/.test(summ), summ]);

  await page.evaluate(async () => { await kkRepackSubmit(); });
  await page.waitForTimeout(400);

  results.push(['inventoryへ3件POST', Array.isArray(postedInv) && postedInv.length === 3, postedInv && postedInv.length]);
  const ok = Array.isArray(postedInv) && postedInv.every(r =>
    r.individual_code === 'TGC-MIB-20260826-001' && r.tier === 3 && r.status === '在庫' &&
    r.weight === 1 && r.weight_kg === 1 && r.part_name === 'ミンチ肉（粗挽き）' &&
    r.species === 'イノシシ' && r.parent_inventory_id === 'P-1' && r.location_code === 'F1' && r.individual_id === null);
  results.push(['各パックが正しい規格・同一バッチ', ok, postedInv && JSON.stringify(postedInv[0])]);
  const codes = (postedInv || []).map(r => r.ident_code);
  results.push(['連番が004から始まる', codes[0] && /-004$/.test(codes[0]) && /-006$/.test(codes[2] || ''), JSON.stringify(codes)]);
  results.push(['トレーサビリティ3件POST', Array.isArray(postedLog) && postedLog.length === 3 && postedLog[0].parent_ident_code === 'TGC-MIB-20260826-001', postedLog && postedLog.length]);
  const closed = await page.$eval('#kkRepackModal', el => el.style.display);
  results.push(['登録後モーダルを閉じる', closed === 'none', closed]);

  // 最近の加工処理が在庫(tier3)から描画され、バッチが1行に集約される
  await page.evaluate(async () => { await loadKakouLog(); });
  await page.waitForTimeout(200);
  const logHtml = await page.$eval('#kk-log-body', el => el.innerText);
  results.push(['加工履歴にバッチが出る', /TGC-MIB-20260826-001/.test(logHtml), logHtml.replace(/\n/g, ' ').slice(0, 120)]);
  results.push(['規格を集約表示(0.25×1 / 1×1・計2)', /0\.25kg×1/.test(logHtml) && /1kg×1/.test(logHtml) && /計2パック/.test(logHtml), logHtml.replace(/\n/g, ' ')]);
  results.push(['履歴行にも追加パックボタン', /追加パック/.test(logHtml), '']);

  results.push(['pageerrorなし', errors.length === 0, errors.join(' / ')]);

  let pass = 0;
  for (const [name, okk, got] of results) { console.log((okk ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' && got != null ? '  [' + got + ']' : '')); if (okk) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
