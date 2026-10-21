// 精肉モード: 「骨付き」は1パック登録するごとに OFF に戻る（2026-10-21 沖「骨付きは1パックごとにオフにして」）
//
//   事故（2026-10-21 TGC-08-T370）
//     最初のバラだけ骨付きにするつもりで ON にした → OFF に戻し忘れ、続く9パック（スネ・モモ・肩ロース・カタ・
//     ペットフード用・シンタマ・ロース）の在庫とラベルがすべて「骨付き ○○」になった。同じことが 9/25・9/29 にもあった。
//   ここで測ること: 本番と同じ登録の流れ（pmRequestRegister → 在庫POST → 加工ログ）で、
//     1. ON で登録した1パックだけ「骨付き」になる
//     2. 登録が終わると ON → OFF に戻り、ボタンの表示も OFF になる
//     3. 何もしないで次を登録すると「骨付き」は付かない（在庫・ラベルとも）
//     4. 再開用に保存されるセッションも OFF になっている
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const IND = { label_id: 'TGC-08-T900', species: 'イノシシ', weight_total: 48, capture_date: '2026-10-20' };

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  const rows = [];
  await page.route('**/*', r => {
    const u = r.request().url(), m = r.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = (b, st) => r.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/rest\/v1\/inventory/.test(u)) {
      if (m === 'POST') { const b = JSON.parse(r.request().postData() || '{}'); rows.push(b); return J([b], 201); }
      return J([]);
    }
    if (/\/rest\/v1\/individuals/.test(u)) return J([IND]);
    if (/\/rest\/v1\/staff/.test(u)) return J([{ name: 'テスト担当' }]);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(700);
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

  await page.evaluate(async () => {
    window.__printed = [];
    window.pmPrintLabel = (w, lot, ident, part) => { window.__printed.push({ ident, part }); };
    pmCurrentOperator = 'テスト担当';
    await pmSelectIndividual('TGC-08-T900');
  });
  await page.waitForTimeout(400);
  const reg = async (part, code, kg) => {
    await page.evaluate(([p, c, k]) => { pmSelectedPart = { part_name: p, barcode_num: c, price_standard: 2000 }; return pmRequestRegister(k); }, [part, code, kg]);
    await page.waitForTimeout(500);
  };
  const state = () => page.evaluate(() => ({ on: pmBoneIn, btn: document.getElementById('pmBoneBtn').textContent, cls: document.getElementById('pmBoneBtn').classList.contains('bone-on') }));

  // 1) 骨付き ON にしてバラを登録
  await page.evaluate(() => pmToggleBone());
  T('ON にするとボタンが「骨付き: ON」', (await state()).btn.includes('ON'), (await state()).btn);
  await reg('バラ', 'BA', 2.22);
  T('ON で登録した1パックは「骨付き バラ」（在庫）', rows[0] && rows[0].part_name === '骨付き バラ', rows[0] && rows[0].part_name);
  T('…ラベルも「骨付き バラ」', (await page.evaluate(() => window.__printed[0] && window.__printed[0].part)) === '骨付き バラ', await page.evaluate(() => JSON.stringify(window.__printed)));
  const s1 = await state();
  T('登録が終わると OFF に戻る（変数・ボタン表示・色）', s1.on === false && s1.btn.includes('OFF') && !s1.cls, JSON.stringify(s1));

  // 2) 何もしないで次（スネ・肩ロース）を登録
  await reg('スネ', 'SN', 0.63);
  await reg('肩ロース', 'KR', 0.5);
  T('次のパックは「骨付き」が付かない（スネ・肩ロース）', rows[1] && rows[1].part_name === 'スネ' && rows[2] && rows[2].part_name === '肩ロース', rows.map(r => r.part_name).join(' / '));
  T('…ラベルも付かない', (await page.evaluate(() => window.__printed.slice(1).map(p => p.part).join(','))) === 'スネ,肩ロース', await page.evaluate(() => window.__printed.map(p => p.part).join(',')));
  T('登録済み一覧の骨付き印は1件目だけ', JSON.stringify(await page.evaluate(() => pmCompletedParts.map(c => c.bone_in))) === '[true,false,false]', JSON.stringify(await page.evaluate(() => pmCompletedParts.map(c => c.bone_in))));

  // 3) もう一度 ON → 1パックだけ骨付き
  await page.evaluate(() => pmToggleBone());
  await reg('カタ', 'KT', 1.29);
  await reg('ロース', 'RO', 0.5);
  T('もう一度 ON にすると、その1パックだけ骨付き（カタ）・次（ロース）は付かない', rows[3].part_name === '骨付き カタ' && rows[4].part_name === 'ロース', rows.map(r => r.part_name).join(' / '));

  // 4) 再開用のセッションも OFF
  const saved = await page.evaluate(() => { try { const s = (typeof pmSessions !== 'undefined' && pmSessions[pmCurrentOperator]) || null; return s ? s.boneIn : 'no-session'; } catch (e) { return 'err'; } });
  T('再開用に保存したセッションも OFF', saved === false || saved === 'no-session', saved);
  T('画面の説明に「1パックごとに OFF に戻る」がある', await page.evaluate(() => /骨付きは1パック登録するごとに OFF に戻ります/.test(document.body.innerHTML)), '');
  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [nm, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + nm + (got ? '  [' + String(got).slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
