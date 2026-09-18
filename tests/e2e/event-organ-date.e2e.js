// 出店の個体シート・カード: 内臓（レバー等）だけを出す個体の「さばいた日」は獲れた日（2026-09-18 沖）
//   きっかけ: やわたんまち 9/19 にレバー（T332〜T336・各1kg）を持ち出したが、レバーは獲れた日にさばくもの。
//   個体は精肉前（processing_done_at 無し）で「さばいた日 —」になり、精肉後は枝肉の日付が出て
//   「内臓なのに◯日ねかせて」と読めてしまう。
//   測ること
//     1. 内臓だけ → さばいた日＝獲れた日（「獲れた日に処理」・ねかせ日数なし）、自動の文も「獲れたその日に…さばきました」
//     2. 枝肉（唐揚げ用など） → 従来どおり精肉完了日と ねかせ日数
//     3. 内臓＋枝肉が混ざる → 枝肉の精肉完了日
//     4. カード（evCardHtml）も同じ規則。内臓は見出しが「さばいた日」
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_role_v1', 'admin'); sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith('file:')) return r.continue();
    if (/cdn|jsdelivr|fonts\./.test(u)) return r.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html')); await page.waitForTimeout(600);
  const results = []; const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  const IND = { label_id: 'TGC-08-T332', species: 'イノシシ', sex: 'オス', weight_total: 22.9, capture_date: '2026-09-17', capture_city: '館山市', capture_area: '神余', capture_method: 'くくり罠', radiation_test_date: '2026-09-18', radiation_result: '検出下限値以下', processing_done_at: '2026-09-21T02:00:00+00:00' };
  const run = (packs, ind) => page.evaluate(([packs, ind]) => {
    evCur = { id: 'ev1', title: 'やわたんまち', venue_name: 'やわたんまち', event_date: '2026-09-19' }; evSheets = {}; evIndCache = {};
    const r = { label: ind.label_id, species: ind.species, packs, ind };
    const sheet = evIndSheetHtml([r], 'やわたんまち', '2026年9月19日', 'ev1').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const card = evCardHtml(r).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    return { sheet, card, sb: evSabaki(ind, packs) };
  }, [packs, ind]);

  // 1) レバーだけ（精肉前）
  const a = await run([{ part_name: 'レバー', weight: 1 }], Object.assign({}, IND, { processing_done_at: null }));
  T('内臓だけ・精肉前: さばいた日＝獲れた日（9/17・獲れた日に処理）', /さばいた日 9月17日（獲れた日に処理）/.test(a.sheet), a.sheet.match(/さばいた日[^放]*/) && a.sheet.match(/さばいた日[^放]*/)[0]);
  T('内臓だけ: 自動の文が「獲れたその日に…さばきました」', /獲れたその日に館山ジビエセンターでさばきました/.test(a.sheet), '');
  T('内臓だけ: ねかせ日数は出さない', !/ねかせ/.test(a.sheet) && a.sb.aging === null && a.sb.organ === true, JSON.stringify(a.sb));
  T('カード: 見出し「さばいた日」で獲れた日', /さばいた日 9月17日（獲れた日に処理）/.test(a.card), a.card.match(/さばいた日[^放]*/) && a.card.match(/さばいた日[^放]*/)[0]);

  // 1b) レバーだけ（精肉後でも獲れた日のまま）
  const a2 = await run([{ part_name: 'レバー', weight: 1 }], IND);
  T('内臓だけ・精肉後: それでも獲れた日（枝肉の精肉日 9/21 は使わない）', /さばいた日 9月17日/.test(a2.sheet) && !/9月21日/.test(a2.sheet), '');

  // 2) 枝肉（唐揚げ用）
  const b = await run([{ part_name: '唐揚げ用', weight: 1.66 }], IND);
  T('枝肉: 精肉完了日 9/21 と ねかせ4日', /さばいた日 9月21日（4日ねかせて）/.test(b.sheet) && /精肉した日 9月21日（4日ねかせました）/.test(b.card), b.sheet.match(/さばいた日[^放]*/) && b.sheet.match(/さばいた日[^放]*/)[0]);
  T('枝肉: 自動の文は精肉日', /館山ジビエセンターで9月21日にさばきました/.test(b.sheet), '');

  // 3) 内臓＋枝肉
  const c = await run([{ part_name: 'レバー', weight: 1 }, { part_name: 'モモ', weight: 2 }], IND);
  T('内臓＋枝肉: 枝肉の精肉日を使う', /さばいた日 9月21日（4日ねかせて）/.test(c.sheet) && c.sb.organ === false, JSON.stringify(c.sb));

  // 4) 内臓の判定（ハツ・タン・フワ・マメ・心臓も）
  const org = await page.evaluate(() => ['レバー', 'ハツ', 'タン', 'フワ', 'マメ', '心臓', 'モモ', '唐揚げ用', 'バラ'].map(p => evIsOrganPart(p)));
  T('内臓の判定: レバー・ハツ・タン・フワ・マメ・心臓は内臓、モモ・唐揚げ用・バラは違う', org.join() === 'true,true,true,true,true,true,false,false,false', org.join());
  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
