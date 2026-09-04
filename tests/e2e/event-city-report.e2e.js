// 出店タブ「市役所へメール報告（コピー）」
//   出店ごとに、種類別の頭数・重量と小分け合算・売上を平文にまとめてクリップボードへコピーする。
//   個体は種類ごとに集計（頭数の重複カウントをしない＝Setで個体番号を数える）。
//   小分け・加工品は個体を特定できないため点数のみ合算。クリップボード不可時はモーダルで手動コピー。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9104);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const ctx = await b.newContext({ viewport: { width: 1200, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  await p.route('**/rest/v1/**', rt => rt.fulfill({ contentType: 'application/json', body: '[]' }));
  await p.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));
  await p.goto('http://localhost:9104/index.html'); await p.waitForTimeout(500);

  const EVENT = { id: 'ev-1', event_date: '2026-09-03', end_date: '2026-09-03', venue_name: '館山なぎさ食堂前',
    start_time: '10:00', end_time: '15:00', weather: '晴', staff_names: '沖浩志', status: '確定' };
  const ITEMS = [
    { kind: 'inventory', individual_label: 'TGC-08-T100', species: 'イノシシ', weight_kg: 1.2, qty_sold: 1, amount: 3600 },
    { kind: 'inventory', individual_label: 'TGC-08-T100', species: 'イノシシ', weight_kg: 0.8, qty_sold: 0, amount: 0 },
    { kind: 'inventory', individual_label: 'TGC-08-M050', species: 'イノシシ', weight_kg: 1.5, qty_sold: 1, amount: 4500 },
    { kind: 'inventory', individual_label: 'TGC-08-シ001', species: 'シカ', weight_kg: 2.0, qty_sold: 0, amount: 0 },
    { kind: 'lot', qty_taken: 20, qty_sold: 14, amount: 14000 },
    { kind: 'product', qty_taken: 5, qty_sold: 3, amount: 3000 },
  ];

  const text = await p.evaluate(({ EVENT, ITEMS }) => evCityReportText(EVENT, ITEMS), { EVENT, ITEMS });

  ck('件名に日付と会場が入る', text.includes('件名: 出店報告（2026-09-03 館山なぎさ食堂前）'), text.split('\n')[0]);
  ck('日時が和暦風の表記になる（年月日＋曜日）', /2026年9月3日（木）/.test(text), text);
  ck('時間帯が入る', text.includes('10:00〜15:00'), text);
  ck('場所が入る', text.includes('場所: 館山なぎさ食堂前'), text);
  ck('天候・担当が入る', text.includes('天候: 晴') && text.includes('担当: 沖浩志'), text);
  // イノシシ: T100(2件=1頭・1.2+0.8=2.00kg)+M050(1頭・1.5kg) => 2頭・3.50kg、うち販売1頭(T100の売れた分1.2kg)+M050(1頭1.5kg)=2頭2.70kg
  ck('イノシシが頭数の重複なく集計される(2頭)', /イノシシ: 2頭（合計3\.50kg）/.test(text), text);
  ck('イノシシの販売頭数・重量が正しい', /うち販売 2頭（2\.70kg）/.test(text), text);
  ck('シカが1頭・未販売で出る', /シカ: 1頭（合計2\.00kg）／うち販売 0頭（0\.00kg）/.test(text), text);
  ck('小分け・加工品が合算される(taken25/sold17)', text.includes('持参 25点／販売 17点'), text);
  ck('売上合計が全項目の合計', text.includes('売上合計: ¥25,100'), text);
  ck('末尾の署名がある', text.includes('館山ジビエセンター（合同会社アルコ）') && text.trim().endsWith('合同会社アルコ）'), '');

  // 種類なし（明細が空）でも壊れない
  const empty = await p.evaluate((EVENT) => evCityReportText(EVENT, []), EVENT);
  ck('明細が空でも「なし」と出す', empty.includes('■ 取り扱った鳥獣（一頭ずつ分かるもの）\nなし'), empty);
  ck('明細が空でもJSエラーにならない', typeof empty === 'string' && empty.length > 0, '');

  // evCur未設定なら何もしない（エラーにならない）
  const noEvent = await p.evaluate(async () => {
    window.evCur = null; window.toast = (m) => { window.__toastMsg = m; };
    await evCityReportCopy();
    return window.__toastMsg;
  });
  ck('出店を開いていない時はエラートーストで止める', /出店を開いてから/.test(noEvent || ''), String(noEvent));

  // ── ボタンから実際にクリップボードへコピーされる ──
  await p.evaluate(({ EVENT, ITEMS }) => {
    evCur = EVENT; evItems = ITEMS;
    window.__toastMsg = null; window.toast = (m) => { window.__toastMsg = m; };
  }, { EVENT, ITEMS });
  await p.evaluate(() => evCityReportCopy());
  await p.waitForTimeout(200);
  const clip = await p.evaluate(() => navigator.clipboard.readText()).catch(() => null);
  const toastMsg = await p.evaluate(() => window.__toastMsg);
  ck('ボタンでクリップボードにコピーされる', !!clip && clip.includes('件名: 出店報告'), clip ? clip.slice(0, 40) : '(null)');
  ck('コピー後にトースト表示', /コピーしました/.test(toastMsg || ''), String(toastMsg));

  ck('JSエラーなし', !errs.some(e => /evCityReportText|evCityReportCopy/.test(e)), errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
