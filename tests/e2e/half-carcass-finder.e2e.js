// タグなし半身の照合（2026-09-29）
//
//   きっかけ
//     冷蔵室にタグの外れた半身があり、どの個体か分からなかった。
//     精肉データで「明らかに重さが少ない」個体を洗い出せるようにする。
//
//   実測（令和8年8/15〜9/29 のイノシシ）
//     枝肉（全体）= 体重の50〜58% → 半身は体重×26.5%前後
//     部位分けの精肉歩留まり = 25〜37%（中央値≈31%）
//     半身も「枝肉（全体）」で登録されている（例: 32.7kg の個体に 8.3kg×2）
//
//   ここで測ること
//     1. まだ精肉していない個体・精肉したが肉が少ない個体・枝肉が半分だけの個体が候補に出る
//     2. 普通に精肉した個体・枝肉を丸ごと（2本）登録した個体は候補に出ない
//     3. 半身の重さを入れると、体重が合う個体だけに絞られ、近い順に並ぶ
//     4. 精肉済みの候補には、ない主な部位（モモ・ロース等）が出る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const today = new Date();
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = n => ymd(new Date(today.getTime() - n * 864e5));

const INDS = [
  { label_id: 'TGC-08-T900', species: 'イノシシ', weight_total: 40, capture_date: daysAgo(3), hunter_name: '猟師A', capture_city: '館山市', capture_area: '神余' },   // 未精肉 半身≈10.6
  { label_id: 'TGC-08-T901', species: 'イノシシ', weight_total: 30, capture_date: daysAgo(5), hunter_name: '猟師B' },   // 精肉したが少ない（13%）半身≈8.0
  { label_id: 'TGC-08-T902', species: 'イノシシ', weight_total: 36, capture_date: daysAgo(6), hunter_name: '猟師C' },   // 枝肉が半分だけ 半身≈9.5
  { label_id: 'TGC-08-T903', species: 'イノシシ', weight_total: 40, capture_date: daysAgo(4), hunter_name: '猟師D' },   // 普通の精肉 31%
  { label_id: 'TGC-08-T904', species: 'イノシシ', weight_total: 32, capture_date: daysAgo(4), hunter_name: '猟師E' },   // 枝肉2本 52%
  { label_id: 'TGC-08-T905', species: 'イノシシ', weight_total: 35, capture_date: daysAgo(7) },  // 普通 30%
  { label_id: 'TGC-08-T906', species: 'イノシシ', weight_total: 30, capture_date: daysAgo(8) },  // 普通 32%
  { label_id: 'TGC-08-T907', species: 'イノシシ', weight_total: 28, capture_date: daysAgo(9) },  // 普通 29%
  { label_id: 'TGC-08-T908', species: 'イノシシ', weight_total: 70, capture_date: daysAgo(2) },  // 未精肉 大型 半身≈18.6
  // 実データ T337 の形: 片側を枝肉（全体）で出し、もう片側を部位分け。合計44%は1頭分そろっている
  { label_id: 'TGC-08-T909', species: 'イノシシ', weight_total: 41.8, capture_date: daysAgo(8) },
];
const INV = [
  { individual_id: 'TGC-08-T901', part_name: 'カタ', weight: 1.2 }, { individual_id: 'TGC-08-T901', part_name: 'ミンチ用', weight: 2.7 },
  { individual_id: 'TGC-08-T902', part_name: '枝肉（全体）', weight: 9.6 },
  { individual_id: 'TGC-08-T903', part_name: 'モモ', weight: 3 }, { individual_id: 'TGC-08-T903', part_name: 'ロース', weight: 2 }, { individual_id: 'TGC-08-T903', part_name: 'カタ', weight: 2.4 }, { individual_id: 'TGC-08-T903', part_name: 'バラ', weight: 1.4 }, { individual_id: 'TGC-08-T903', part_name: 'ヒレ', weight: 0.4 }, { individual_id: 'TGC-08-T903', part_name: 'ミンチ用', weight: 3.2 },
  { individual_id: 'TGC-08-T904', part_name: '枝肉（全体）', weight: 8.3 }, { individual_id: 'TGC-08-T904', part_name: '枝肉（全体）', weight: 8.3 },
  { individual_id: 'TGC-08-T905', part_name: 'ミンチ用', weight: 10.5 },
  { individual_id: 'TGC-08-T906', part_name: 'ミンチ用', weight: 9.6 },
  { individual_id: 'TGC-08-T907', part_name: 'ミンチ用', weight: 8.1 },
  { individual_id: 'TGC-08-T909', part_name: '枝肉（全体）', weight: 11.2 }, { individual_id: 'TGC-08-T909', part_name: 'モモ', weight: 2.6 }, { individual_id: 'TGC-08-T909', part_name: 'ロース', weight: 1.4 }, { individual_id: 'TGC-08-T909', part_name: 'ミンチ用', weight: 3.4 },
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const invQueries = [];
  await page.route('**/rest/v1/**', rt => {
    const url = decodeURIComponent(rt.request().url());
    const J = x => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (rt.request().method() !== 'GET') return J([]);
    if (/\/individuals\?.*capture_date=gte/.test(url)) return J(INDS);
    if (/\/inventory\?individual_id=in\./.test(url)) {
      invQueries.push(url);
      const m = url.match(/individual_id=in\.\(([^)]*)\)/);
      const ids = m ? m[1].split(',').map(s => s.replace(/"/g, '')) : [];
      return J(INV.filter(r => ids.includes(r.individual_id)));
    }
    return J([]);
  });
  await page.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(700);

  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);
  const ids = () => page.$$eval('#hf-body tr', trs => trs.map(tr => (tr.querySelector('b') || {}).textContent).filter(Boolean));
  const rowText = id => page.$$eval('#hf-body tr', (trs, id) => (trs.find(tr => tr.innerText.includes(id)) || {}).innerText || '', id);

  await page.evaluate(() => halfFinderOpen());
  await page.waitForTimeout(400);
  const all = await ids();
  T('未精肉の個体が候補に出る（T900・T908）', all.includes('TGC-08-T900') && all.includes('TGC-08-T908'), all.join(','));
  T('精肉したが肉が少ない個体が候補に出る（T901 13%）', all.includes('TGC-08-T901'), all.join(','));
  T('枝肉が半分だけの個体が候補に出る（T902）', all.includes('TGC-08-T902'), all.join(','));
  T('普通に精肉した個体は出ない（T903・T905〜T907）', !['TGC-08-T903', 'TGC-08-T905', 'TGC-08-T906', 'TGC-08-T907'].some(x => all.includes(x)), all.join(','));
  T('枝肉を2本（丸ごと）登録した個体は出ない（T904）', !all.includes('TGC-08-T904'), all.join(','));
  T('片側枝肉＋片側部位分けで1頭分そろった個体は出ない（T909）', !all.includes('TGC-08-T909'), all.join(','));
  T('在庫はまとめて取得（個体ごとに問い合わせない）', invQueries.length === 1, String(invQueries.length));
  const t901 = await rowText('TGC-08-T901');
  T('精肉済みの候補に、ない主な部位が出る（モモ・ロース・バラ・ヒレ）', /モモ・ロース・バラ・ヒレ/.test(t901) && !/モモ・ロース・カタ/.test(t901), t901.replace(/\s+/g, ' '));
  T('状態の表示（精肉したが肉が少ない）', t901.includes('精肉したが肉が少ない'), t901.replace(/\s+/g, ' '));
  const t900 = await rowText('TGC-08-T900');
  T('半身の目安が体重×26.5%（40kg→10.6kg）', t900.includes('10.6kg'), t900.replace(/\s+/g, ' '));

  // 半身 9.8kg → 体重が合うのは T902(36kg: 8.1〜11.0) と T900(40kg: 9.0〜12.2)。T901(30kg: 6.8〜9.2) と T908(70kg) は外れる
  await page.fill('#hf-weight', '9.8');
  await page.waitForTimeout(150);
  const narrowed = await ids();
  T('重さ9.8kgで体重が合う個体だけに絞られる', narrowed.length === 2 && narrowed.includes('TGC-08-T902') && narrowed.includes('TGC-08-T900'), narrowed.join(','));
  T('目安が近い順に並ぶ（T902 9.5kg が先）', narrowed[0] === 'TGC-08-T902', narrowed.join(','));
  const summary = await page.$eval('#hf-summary', el => el.textContent);
  T('候補数と目安（中央値）を表示', /候補 2頭/.test(summary) && /中央値/.test(summary), summary);

  await page.fill('#hf-weight', '30');
  await page.waitForTimeout(150);
  const none = await page.$eval('#hf-body', el => el.innerText);
  T('合う個体がないときはそう表示する', /当てはまる個体はありません/.test(none), none);

  T('ページエラーなし', errors.length === 0, errors.join(' / '));
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
