// HACCP実施記録表（月間）: 保健所の立入で求められる「HACCP記録表」を1枚で出す
//
//   きっかけ（2026-10-07 立入当日）
//     「HACCP記録表を求められる」。温度・清掃・健康は別々の帳票に分かれていて、
//     衛生管理計画に沿った「1日1行の実施記録」が無かった。
//
//   ここで測ること
//     1. 対象月の各日が1行（今日まで）。作業の無い日は「作業なし」
//     2. 受入頭数・異常、庫内温度（日本時間の時刻）と判定、区域ごとの清掃、ナイフ83℃消毒、従事者の健康が日々の入力どおり
//     3. 記録が無い項目は「未記録」「未」と出して赤くする（後から埋めない）
//     4. CSVにHTMLタグが混ざらない（セルは素の文字）
//     5. 印刷はA4横で、表が用紙の幅に収まる（実寸で測る）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'Asia/Tokyo' });
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));

  const ALL = '床・排水溝の洗浄、ナイフ・器具の洗浄（83℃以上の温湯消毒）';
  const LOGS = [
    // 9/1: 全区域＋温度（17:30 JST）
    ...['解体室', '精肉室', '前室・更衣室', 'トイレ', '施設外周'].map(r => ({ room: r, staff_name: '吉田友美', cleaned_at: '2026-09-01T08:20:00+00:00', items: r === '解体室' ? ALL : '清掃', temperature: null, note: null })),
    { room: '冷蔵・冷凍庫', staff_name: '今泉貴雄', cleaned_at: '2026-09-01T08:30:00+00:00', items: '庫内温度の確認・記録', temperature: '冷蔵-1 / 冷凍-20', note: null },
    // 9/2: 解体室だけ、温度は空欄、冷蔵12℃の記録は無し
    { room: '解体室', staff_name: '川島幸子', cleaned_at: '2026-09-02T07:00:00+00:00', items: '床・排水溝の洗浄', temperature: null, note: '排水溝つまり→清掃' },
    { room: '冷蔵・冷凍庫', staff_name: '川島幸子', cleaned_at: '2026-09-02T07:05:00+00:00', items: '', temperature: null, note: null },
    // 9/3: 温度が基準外
    { room: '冷蔵・冷凍庫', staff_name: '石田将来', cleaned_at: '2026-09-03T08:00:00+00:00', items: '', temperature: '冷蔵12 / 冷凍-20', note: null },
  ];
  const ATT = [
    { work_date: '2026-09-01', staff_name: '吉田友美', clock_in: '08:00', health_in: '異常なし', health_out: '異常なし' },
    { work_date: '2026-09-01', staff_name: '今泉貴雄', clock_in: '08:00', health_in: '異常なし', health_out: '異常なし' },
    { work_date: '2026-09-02', staff_name: '川島幸子', clock_in: '08:00', health_in: null, health_out: null },
    { work_date: '2026-09-02', staff_name: '石田将来', clock_in: '08:00', health_in: '異常なし', health_out: null },
    { work_date: '2026-09-03', staff_name: '石田将来', clock_in: '08:00', health_in: '発熱', health_out: null },
  ];
  const INDS = [
    { label_id: 'TGC-08-T300', capture_date: '2026-09-01', intake_status: null, capture_anomalies: 'なし', organ_anomalies: 'なし', quality: '良' },
    { label_id: 'TGC-08-T301', capture_date: '2026-09-01', intake_status: null, capture_anomalies: 'なし', organ_anomalies: '肝臓に白色結節', quality: '良' },
    { label_id: 'TGC-08-T302', capture_date: '2026-09-02', intake_status: '搬入待ち', capture_anomalies: null, organ_anomalies: null, quality: null },
  ];
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/rest\/v1\/cleaning_logs/.test(u)) return J(LOGS);
    if (/\/rest\/v1\/attendance/.test(u)) return J(ATT);
    if (/\/rest\/v1\/individuals/.test(u)) return J(INDS);
    if (/\/rest\/v1\/report_docs/.test(u)) return J(r.request().method() === 'POST' ? [{ id: 'rd1', status: '作成済み', output_count: 0 }] : []);
    return J([]);
  });

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(600);

  const keys = await page.evaluate(() => DOC_DEFS.filter(d => d.cat === 'HACCP・衛生管理').map(d => d.key));
  T('HACCP・衛生管理の先頭に「HACCP実施記録表（月間）」がある', keys[0] === 'haccp_monthly', keys.slice(0, 3).join(','));

  const d = await page.evaluate(async () => DOC_DEFS.find(x => x.key === 'haccp_monthly').gen('2026-09'));
  const col = n => d.columns.indexOf(n);
  T('9月は30行（1日1行）', d.rows.length === 30, String(d.rows.length));
  const r1 = d.rows[0], r2 = d.rows[1], r3 = d.rows[2], r4 = d.rows[3];
  T('日付は 9/1(火) 形式', r1[0] === '9/1(火)', r1[0]);
  T('9/1 受入2頭・内臓異常あり1頭（搬入待ちは数えない）', r1[col('受入個体の確認')] === '2頭／異常あり1頭' && r2[col('受入個体の確認')] === '受入なし', r1[1] + ' / ' + r2[1]);
  T('9/1 庫内温度は日本時間 17:30・判定「適」', r1[col('庫内温度（冷蔵/冷凍）')] === '冷蔵-1 / 冷凍-20（17:30）' && r1[col('温度判定')] === '適', r1[2] + ' ' + r1[3]);
  T('9/2 温度空欄は「未記録」', r2[col('庫内温度（冷蔵/冷凍）')] === '未記録', r2[2]);
  T('9/3 冷蔵12℃は「要確認」', r3[col('温度判定')] === '要確認', r3[3]);
  T('9/1 全区域○・ナイフ消毒○', ['解体室', '精肉室', '前室・更衣室', 'トイレ', '施設外周', 'ナイフ等83℃消毒'].every(n => r1[col(n)] === '○'), '');
  T('9/2 解体室だけ○、他は「未」、ナイフ消毒の記録なしは「未」', r2[col('解体室')] === '○' && r2[col('トイレ')] === '未' && r2[col('ナイフ等83℃消毒')] === '未', '');
  T('健康: 9/1「2名 異常なし」・9/2「1/2名 異常なし（1名未記録）」・9/3「異常あり 石田将来」',
    r1[col('従事者の健康')] === '2名 異常なし' && r2[col('従事者の健康')] === '1/2名 異常なし（1名未記録）' && r3[col('従事者の健康')] === '異常あり 石田将来', [r1, r2, r3].map(r => r[col('従事者の健康')]).join(' | '));
  T('特記事項に清掃記録の備考が入る', /排水溝つまり/.test(r2[col('特記事項')]), r2[col('特記事項')]);
  T('記録の無い日は「作業なし」', r4[col('特記事項')] === '作業なし', r4.join(','));
  T('注記に作業日・温度記録日数・体調未記録を数える', /作業日 3日/.test(d.note) && /温度記録 2日（要確認 1日）/.test(d.note) && /体調未記録 1人日/.test(d.note), d.note);
  T('セルにHTMLタグが無い（CSVが汚れない）', d.rows.every(r => r.every(c => !/[<>]/.test(String(c)))), '');

  // 印刷（window.open を差し替え、出てきたHTMLを実寸で測る）
  await page.evaluate(() => {
    document.getElementById('doc-month').value = '2026-09';
    window.__html = '';
    window.open = () => ({ document: { write: s => { window.__html += s; }, close() {} }, print() {} });
  });
  await page.evaluate(() => docOutput('haccp_monthly', 'print'));
  await page.waitForTimeout(500);
  const html = await page.evaluate(() => window.__html);
  T('印刷はA4横', /@page\{size:A4 landscape/.test(html), '');
  const p2 = await ctx.newPage();
  await p2.setContent(html);
  const red = await p2.$$eval('td', tds => tds.filter(t => /未記録|^未$|要確認|異常あり/.test(t.textContent)).every(t => getComputedStyle(t).color === 'rgb(204, 0, 0)'));
  T('未記録・未・要確認・異常ありは赤字', red, '');
  await p2.emulateMedia({ media: 'print' });
  // A4横 297mm − 余白10mm×2 = 277mm ≒ 1047px（96dpi）
  await p2.setViewportSize({ width: 1047, height: 800 });
  const over = await p2.evaluate(() => document.querySelector('table').scrollWidth - document.documentElement.clientWidth);
  T('表がA4横の印刷幅（277mm）に収まる', over <= 0, String(over) + 'px');
  const pdf = await p2.pdf({ preferCSSPageSize: true });
  const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  T('1か月分（30行）がA4横2ページ以内', pages >= 1 && pages <= 2, String(pages));

  // 提出セットにも入る
  await page.evaluate(() => { window.__pack = ''; window.open = () => ({ document: { write: s => { window.__pack += s; }, open() {}, close() {} }, print() {} }); });
  await page.evaluate(() => haccpPackPrint());
  await page.waitForTimeout(1500);
  const pack = await page.evaluate(() => window.__pack);
  T('提出セットに入り、その章だけA4横', /HACCP実施記録表（月間）/.test(pack) && /section class="land"/.test(pack) && /@page land\{size:A4 landscape/.test(pack), '');

  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
