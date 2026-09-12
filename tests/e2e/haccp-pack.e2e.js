// 保健所・市役所の立入対応: HACCP提出セット（対応表＋対象月の記録一式）
//
//   きっかけ（2026-09-12）
//     「市役所や保健所が確認に来た際にHACCP対応の提出をできるようにして」（千葉県ガイドライン参考）。
//     帳票ハブにHACCPの帳票は12種あったが、①ガイドライン・別表17の「この項目はどこで記録？」に
//     一覧で答えるものが無く、②ねずみ駆除・放射能検査・産廃搬出・出荷販売台帳（参考様式2）・
//     教育訓練の帳票が無く、③施設情報（許可番号・衛生責任者）を載せた表紙が無かった。
//
//   ここで測ること
//     1. 書類・帳票タブに「HACCP提出セット」の欄があり、施設情報は app_settings の値と既定値で埋まる
//     2. 対応表は17行、対象月の件数が実データどおり（個体3頭・放射能検査2頭・温度2件・駆除2回）、
//        0件の行は赤く目立つ
//     3. 新しい帳票5種が HACCP・衛生管理 に増えている
//     4. 出荷・販売台帳は order_items→orders/inventory の埋め込みで個体番号・販売先・販売日を出し、
//        取消の注文は除く
//     5. 「印刷/PDF」で表紙（施設情報・対応表）＋帳票一式が1つの印刷物になる
//     6. スマホ幅で横スクロールしない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));

  const reqs = [];
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    const qs = decodeURIComponent(u.split('?')[1] || '');
    reqs.push(u.replace(/^.*\/rest\/v1\//, '').split('?')[0] + '?' + qs);
    if (/\/rest\/v1\/app_settings/.test(u)) return J([{ key: 'haccp_facility', value: { license_no: '安保 第12-345号', hygiene_manager: '沖 浩志' } }]);
    if (/\/rest\/v1\/individuals/.test(u)) {
      const rows = [
        { id: 'i1', label_id: 'TGC-08-T300', species: 'イノシシ', capture_date: '2026-09-02', capture_city: '館山市', weight_total: 45, radiation_test_date: '2026-09-03', radiation_result_date: '2026-09-03', radiation_result: '検出下限値以下', capture_anomalies: 'なし', organ_anomalies: 'なし' },
        { id: 'i2', label_id: 'TGC-08-M180', species: 'イノシシ', capture_date: '2026-09-05', capture_city: '南房総市', weight_total: 30, radiation_test_date: '2026-09-06', radiation_result_date: '2026-09-06', radiation_result: '検出下限値以下', capture_anomalies: 'なし', organ_anomalies: '肝臓に白色結節' },
        { id: 'i3', label_id: 'TGC-08-T301', species: 'イノシシ', capture_date: '2026-09-08', capture_city: '館山市', weight_total: 52, radiation_test_date: null, radiation_result_date: null, radiation_result: null, capture_anomalies: 'なし', organ_anomalies: 'なし' },
      ];
      if (/radiation_test_date=not\.is\.null/.test(qs)) return J(rows.filter(x => x.radiation_test_date));
      return J(rows);
    }
    if (/\/rest\/v1\/cleaning_logs/.test(u)) {
      const rows = [
        { id: 'c1', room: '冷蔵・冷凍庫', staff_name: '大和田薫', cleaned_at: '2026-09-01T18:00:00+09:00', items: '庫内温度の確認・記録', temperature: '冷蔵2℃ / 冷凍-20℃' },
        { id: 'c2', room: '冷蔵・冷凍庫', staff_name: '大和田薫', cleaned_at: '2026-09-02T18:00:00+09:00', items: '庫内温度の確認・記録', temperature: '冷蔵3℃ / 冷凍-19℃' },
        { id: 'c3', room: '解体室', staff_name: '沖浩志', cleaned_at: '2026-09-02T18:10:00+09:00', items: '床・壁の洗浄', temperature: null },
      ];
      if (/room=eq\.冷蔵・冷凍庫/.test(qs)) return J(rows.filter(x => x.room === '冷蔵・冷凍庫'));
      return J(rows);
    }
    if (/\/rest\/v1\/pest_control_logs/.test(u)) return J([
      { id: 'p1', done_on: '2026-05-10', target: 'ねずみ・衛生害虫', method: '粘着トラップ・薬剤', area: '施設全体', vendor: '', operator: '沖浩志', result: '捕獲なし', measure: '', note: '' },
      { id: 'p2', done_on: '2026-08-20', target: 'ねずみ・衛生害虫', method: '粘着トラップ・薬剤', area: '施設全体', vendor: '', operator: '沖浩志', result: 'ゴキブリ1', measure: '再設置', note: '' },
    ]);
    if (/\/rest\/v1\/waste_checklists/.test(u)) return J([{ id: 'w1', checked_on: '2026-09-11', departure_time: '09:10', staff_name: '大和田薫', items: Array.from({ length: 10 }, (_, i) => ({ no: i + 1, text: 't', ok: true })), all_ok: true, correction_note: null }]);
    if (/\/rest\/v1\/equipment/.test(u)) return J([{ id: 'e1', mgmt_no: 1, name: 'レール', qty: 1, status: '使用中' }, { id: 'e2', mgmt_no: 20, name: '金属検出機', qty: 1, status: '使用中', location: '休憩室', price: 460211 }]);
    if (/\/rest\/v1\/order_items/.test(u)) return J([
      { part_name: 'ロース', species: 'イノシシ', weight_kg: 1.2, weight: null, orders: { order_code: 'O-2026-0901', delivery_date: '2026-09-03', customer_name: 'ビストロむじか', delivery_address: '千葉県館山市北条1', delivery_phone: '0470-00-0000', status: '発送済' }, inventory: { individual_id: 'TGC-08-T300', part_name: 'ロース', weight_kg: 1.2, species: 'イノシシ', process_type: '冷凍' } },
      { part_name: 'ミンチ肉（粗挽き）', species: 'イノシシ', weight_kg: 5, weight: null, orders: { order_code: 'O-2026-0902', delivery_date: '2026-09-05', customer_name: 'タウタウテラス館山', delivery_address: '', delivery_phone: '', status: '発送済' }, inventory: { individual_id: null, lot_code: 'L260905A', part_name: 'ミンチ肉（粗挽き）', weight_kg: 5, species: 'イノシシ', process_type: 'ミンチ肉（粗挽き）' } },
      { part_name: 'モモ', species: 'イノシシ', weight_kg: 2, weight: null, orders: { order_code: 'O-2026-0903', delivery_date: '2026-09-06', customer_name: '取消の店', delivery_address: '', delivery_phone: '', status: '取消' }, inventory: { individual_id: 'TGC-08-M180', part_name: 'モモ', weight_kg: 2, species: 'イノシシ', process_type: '冷凍' } },
    ]);
    if (/\/rest\/v1\/shipments/.test(u)) return J([{ id: 's1', shipment_date: '2026-09-03', status: '出荷済', order_id: 'o1' }]);
    return J([]);
  });

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  await page.goto('file://' + path.resolve(__dirname, '../../index.html') + '?tab=docs');
  await page.waitForTimeout(600);
  await page.evaluate(() => { document.getElementById('doc-month').value = '2026-09'; return haccpInit(); });
  await page.waitForTimeout(800);

  // 1) 施設情報
  T('HACCP提出セットの欄がある', await page.$('#haccp-pack') !== null, '');
  T('施設情報は app_settings の値で埋まる（許可番号・食品衛生責任者）', (await page.$eval('#hf-license_no', el => el.value)) === '安保 第12-345号' && (await page.$eval('#hf-hygiene_manager', el => el.value)) === '沖 浩志', '');
  T('未設定の項目は既定値（施設名・管轄保健所）', /館山ジビエセンター/.test(await page.$eval('#hf-name', el => el.value)) && /安房保健所/.test(await page.$eval('#hf-hokenjo', el => el.value)), '');

  // 2) 対応表
  const rowN = await page.$$eval('#haccp-map tr.haccp-row', els => els.length);
  T('対応表は17行（ガイドライン・別表17の項目）', rowN === 17, String(rowN));
  const mapText = await page.$eval('#haccp-map', el => el.textContent.replace(/\s+/g, ' '));
  T('対象月の件数: 個体3頭', /3頭/.test(mapText), '');
  T('対象月の件数: 放射能検査 2頭・温度記録 2件・駆除 2回（年度）', /2頭/.test(mapText) && /2件/.test(mapText) && /2回（年度）/.test(mapText), mapText.slice(0, 200));
  T('内臓異常 1頭（「なし」は数えない）', /1頭/.test(mapText), '');
  const zeroRows = await page.$$eval('#haccp-map tr.haccp-row-zero', els => els.map(e => e.children[0].textContent));
  T('0件の行（出退勤・在庫・フラグ）は赤く目立つ', zeroRows.length >= 3 && zeroRows.some(t => /別表17 七/.test(t)), zeroRows.join(' | '));
  T('根拠にガイドライン条番号と別表17が書いてある', /第6-6\(12\)/.test(mapText) && /別表17 五/.test(mapText) && /参考様式2/.test(mapText), '');

  // 3) 新しい帳票
  const keys = await page.evaluate(() => DOC_DEFS.filter(d => d.cat === 'HACCP・衛生管理').map(d => d.key));
  T('HACCP・衛生管理に 駆除・放射能・産廃・販売台帳・教育訓練 の帳票がある', ['pest_control_record', 'radiation_record', 'waste_checklist_record', 'sales_ledger', 'training_record'].every(k => keys.includes(k)), keys.join(','));

  // 4) 出荷・販売台帳
  const sl = await page.evaluate(async () => DOC_DEFS.find(d => d.key === 'sales_ledger').gen('2026-09'));
  T('販売台帳: 取消の注文を除いた2行', sl.rows.length === 2, String(sl.rows.length));
  T('販売台帳: 個体番号・部位・販売量・販売先・販売日・注文番号', sl.rows[0][0] === 'TGC-08-T300' && sl.rows[0][2] === 'ロース' && sl.rows[0][4] === '1.20' && sl.rows[0][5] === 'ビストロむじか' && sl.rows[0][8] === '2026-09-03' && sl.rows[0][9] === 'O-2026-0901', JSON.stringify(sl.rows[0]));
  T('販売台帳: 個体に紐付かないミンチはロット番号で出す', /ロット L260905A/.test(sl.rows[1][0]) && sl.rows[1][3] === 'ミンチ（冷凍）', sl.rows[1][0] + ' / ' + sl.rows[1][3]);
  T('販売台帳: 販売形態はブロック／スライス／ミンチ＋冷凍', sl.rows[0][3] === 'ブロック（冷凍）', sl.rows[0][3]);
  const slReq = reqs.find(r => r.startsWith('order_items?'));
  T('販売台帳の問い合わせは orders!inner の埋め込みで納品日を絞る', !!slReq && /orders!inner\(/.test(slReq) && /orders\.delivery_date=gte\.2026-09-01/.test(slReq), (slReq || '').slice(0, 160));
  const rad = await page.evaluate(async () => DOC_DEFS.find(d => d.key === 'radiation_record').gen('2026-09'));
  T('放射能検査記録: 未検査の頭数を注記に出す', rad.rows.length === 3 && /検査記録なし 1頭/.test(rad.note) && rad.rows[2][4] === '未検査', rad.note);
  const pest = await page.evaluate(async () => DOC_DEFS.find(d => d.key === 'pest_control_record').gen('2026-09'));
  T('駆除記録: 年度（4月〜3月）で数え、年2回の根拠を注記', pest.rows.length === 2 && /令和8年度/.test(pest.note) && /年2回以上/.test(pest.note), pest.note);

  // 5) 印刷（window.open を差し替えて出力HTMLを捕まえる）
  await page.evaluate(() => {
    window.__pack = ''; window.__printed = false;
    window.open = () => ({ document: { write: s => { window.__pack += s; }, open() { window.__pack = ''; }, close() {} }, print() { window.__printed = true; } });
  });
  await page.evaluate(() => haccpPackPrint());
  await page.waitForTimeout(1500);
  const pack = await page.evaluate(() => window.__pack);
  T('表紙に施設情報（許可番号・食品衛生責任者・管轄保健所）が入る', /安保 第12-345号/.test(pack) && /沖 浩志/.test(pack) && /安房保健所/.test(pack), pack.length + 'B');
  T('表紙に対応表が入る', /対応表（ガイドライン・別表17/.test(pack) && /別表17 五/.test(pack), '');
  const secN = (pack.match(/page-break-before:always/g) || []).length;
  T('帳票が改ページ区切りで一式付く（16帳票以上）', secN >= 16, String(secN));
  T('新しい帳票（放射能・駆除・産廃・販売台帳・教育訓練）も一式に入る', /放射性物質検査記録/.test(pack) && /ねずみ・昆虫駆除記録/.test(pack) && /産業廃棄物 搬出前チェック記録/.test(pack) && /出荷・販売台帳/.test(pack) && /衛生教育・訓練記録/.test(pack), '');
  T('備品台帳（別表17 三の設備一覧）も一式に入る', /備品管理台帳/.test(pack) && /金属検出機/.test(pack), '');
  T('印刷ダイアログが呼ばれる', await page.evaluate(() => window.__printed), '');

  // 6) スマホ幅
  const of = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  T('スマホ幅で横スクロールしない', of <= 1, String(of));

  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
