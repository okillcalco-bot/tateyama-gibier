// 放射能検査台帳（capture-report.html）: イノシシ以外を印刷するとき放射能検査欄を出さない
//
//   きっかけ（2026-09-10）
//     「放射能検査台帳、良い感じに作ってもらったんだけど、イノシシ以外でこれを
//     印刷する意味は、市役所が記録を確認したいだけだから、放射能検査の部分は
//     不要です」との指摘。全頭検査はイノシシだけの制度なので、シカ等の記録に
//     空欄の放射能検査記入欄を付けても意味が無く、紛らわしいだけだった。
//
//   ここで測ること
//     1. イノシシの記録は従来どおり「▼ 放射能検査記録」欄が付く
//     2. イノシシ以外（シカ等）は放射能検査欄が付かない
//     3. イノシシ以外でも備考は消えずに出る（放射能検査欄の判定行に同居していたため）
//     4. 見出しもイノシシ以外は「捕獲票」（放射能検査台帳を名乗らない）になる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

// このサンドボックスはcdn.jsdelivr.netへ出られないため、実際のsupabase-jsは読み込めない。
// ページのコードはチェーンメソッド（select/order/gte/lte/eq/neq/or/limit）を呼ぶだけなので、
// すべて自分自身を返して最後にlimit()で空配列を返す最小限のスタブに差し替える。
async function stubSupabase(ctx) {
  await ctx.addInitScript(() => {
    window.supabase = {
      createClient: () => ({
        from: () => {
          const builder = {
            select: () => builder, order: () => builder, gte: () => builder, lte: () => builder,
            eq: () => builder, neq: () => builder, or: () => builder,
            limit: async () => ({ data: [], error: null }),
          };
          return builder;
        },
      }),
    };
  });
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await stubSupabase(ctx);
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { await d.dismiss(); });

  await page.route('**/rest/v1/**', rt => rt.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/auth/**', rt => rt.fulfill({ contentType: 'application/json', body: '{}' }));

  await page.goto('file://' + path.resolve(__dirname, '../../capture-report.html'));
  await page.waitForTimeout(500);

  const results = [];
  const ck = (name, cond, got) => results.push([name, cond, got]);

  const boarHtml = await page.evaluate(() => buildRecordBlock({
    label_id: 'TGC-08-T001', serial_number: 1, species: 'イノシシ', capture_date: '2026-08-01',
    origin: '館山市', capture_city: '館山市', memo: 'イノシシの備考メモ',
  }, 1));
  const deerHtml = await page.evaluate(() => buildRecordBlock({
    label_id: 'TGC-08-S001', serial_number: 2, species: 'シカ', capture_date: '2026-08-02',
    origin: '南房総市', capture_city: '南房総市', memo: 'シカの備考メモ',
  }, 2));

  ck('イノシシは放射能検査記録欄が付く', boarHtml.includes('▼ 放射能検査記録'), boarHtml.slice(0, 200));
  ck('イノシシの見出しは「捕獲票兼放射能検査台帳」', boarHtml.includes('捕獲票兼放射能検査台帳'), boarHtml.slice(0, 200));

  ck('シカは放射能検査記録欄が付かない', !deerHtml.includes('▼ 放射能検査記録') && !deerHtml.includes('Cs-134'), deerHtml.slice(0, 300));
  ck('シカの見出しは「捕獲票」のみ（放射能検査台帳を名乗らない）', deerHtml.includes('捕獲票') && !deerHtml.includes('捕獲票兼放射能検査台帳'), deerHtml.slice(0, 200));
  ck('シカでも備考は表示される', deerHtml.includes('シカの備考メモ'), deerHtml);
  ck('イノシシでも備考は表示される', boarHtml.includes('イノシシの備考メモ'), boarHtml);

  ck('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
