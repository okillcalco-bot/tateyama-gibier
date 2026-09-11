// 産廃搬出ルール・チェック表ページ
//   紙の「産廃搬出ルール」「最終チェック表」（2026-09-10制定）をスマホから見られるように
//   起票した学習・確認用ページ。ログイン不要で開けること・スマホで崩れないこと・
//   紙の10項目チェックと1文字も違わず一致すること・全部チェックしないとOKにならないことを測る。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
const fs = require('fs');

// 紙の「産廃搬出　最終チェック表」10項目（PDFからそのまま書き写した文言。順序も一致させる）
const PAPER_ITEMS = [
  '廃棄物はすべて45Lビニール袋の中に完全に収まっている',
  '丸のまま・大きな塊・袋から突き出す状態の廃棄物がない',
  'すべての袋口が確実に結束されている',
  '袋に破れ・穴・裂けがない',
  '袋の外側に血液・液体が付着・滴下していない',
  '液漏れの懸念がある袋は補強または二重袋にしている',
  '荷台の底面・側面を、破損のない防水ブルーシートで覆っている',
  'ブルーシートの端部を立ち上げ、積載物を包み込む状態にしている',
  '積載後、荷台・車外へ血液や液体が漏れる状態ではない',
  '上記すべてを確認し、不適合があれば是正してから出発する'
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let outbound = 0;
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith('file:')) return r.continue();
    outbound++;
    return r.fulfill({ status: 200, body: '' });
  });

  const results = [];
  const file = 'file://' + path.resolve(__dirname, '../../sanpai.html');
  await page.goto(file);
  await page.waitForTimeout(300);
  const all = await page.evaluate(() => document.body.textContent.replace(/\s+/g, ' '));

  // 1) ログイン不要・外部通信なしで開ける
  results.push(['ログインなしで読める', /産廃搬出ルール/.test(all), '']);
  results.push(['外部へ通信しない', outbound === 0, String(outbound)]);

  // 2) 3つの必須ルールが出典どおり出ている
  results.push(['3点ルールが明記', /45L袋に収まる大きさ/.test(all) && /血・液体の外漏れゼロ/.test(all) && /荷台をブルーシートで包む/.test(all), '']);

  // 3) 搬出の流れが紙と同じ順序で出ている
  results.push(['搬出の流れが順番どおり', /裁断・袋詰め.*袋口結束.*ブルーシートで包む.*積載.*最終チェック表記入.*出発/s.test(all), '']);

  // 4) 紙のチェック表10項目が1つも欠けず・順序も違わず出ている
  const items = await page.$$eval('#checkList .citem .t', els => els.map(e => e.textContent.replace(/^\d+/, '').trim()));
  results.push(['チェック項目が10件ある', items.length === 10, String(items.length)]);
  results.push(['紙のチェック表と文言・順序が完全一致', JSON.stringify(items) === JSON.stringify(PAPER_ITEMS), items.join(' / ')]);

  // 5) 全部チェックしないとOKにならない（紙と同じ「STOPルール」を再現する）
  results.push(['最初はSTOP表示', await page.$eval('#gate', el => /STOP/.test(el.textContent)), '']);
  const boxes = await page.$$('#checkList input[type=checkbox]');
  for (let i = 0; i < boxes.length - 1; i++) await boxes[i].click();
  await page.waitForTimeout(100);
  results.push(['9/10チェックではまだSTOP', await page.$eval('#gate', el => /STOP/.test(el.textContent)), '']);
  await boxes[boxes.length - 1].click();
  await page.waitForTimeout(100);
  results.push(['10/10チェックでOKに変わる', await page.$eval('#gate', el => /確認OK/.test(el.textContent)), await page.$eval('#gate', el => el.textContent)]);

  // 6) リセットで最初の状態に戻る（担当者が変わっても前の人のチェックが残らない）
  await page.fill('#cfStaff', 'テスト太郎');
  await page.click('.resetbtn');
  await page.waitForTimeout(100);
  const afterReset = await page.evaluate(() => ({
    staff: document.getElementById('cfStaff').value,
    checked: [...document.querySelectorAll('#checkList input[type=checkbox]')].some(cb => cb.checked),
    gate: document.getElementById('gate').textContent
  }));
  results.push(['リセットで氏名が消える', afterReset.staff === '', afterReset.staff]);
  results.push(['リセットでチェックが全部外れる', !afterReset.checked, '']);
  results.push(['リセットでSTOPに戻る', /STOP/.test(afterReset.gate), afterReset.gate]);

  // 7) スマホ幅で横に溢れない
  const of = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  results.push(['スマホ幅で横スクロールしない', of <= 1, String(of)]);

  // 8) 業務アプリから辿れる
  const idx = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
  results.push(['業務アプリにリンクがある', /href="sanpai\.html"/.test(idx), '']);

  results.push(['pageerrorなし', errors.length === 0, errors.join(' / ')]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' && got != null ? '  [' + String(got).slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
