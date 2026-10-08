// マニュアル ⑭ イノシシの解体手順 ／ ⑮ シカ・キョンの解体手順（2026-10-08 一次版）
//
//   きっかけ 「イノシシやシカの解体の手順書をマニュアルに載せて」
//   元はパートシフト表「マニュアル」シートの A 解体①〜⑤と現場ルール（受入基準・放射能検体600g・那珂川町の品質指摘）。
//
//   ここで測ること
//     1. マニュアルタブのカード一覧に ⑭・⑮ が載り、開ける
//     2. 現場ルールが手順に入っている（25kg未満／衛生センター 0470-23-3566／83℃／600g・頬肉首周り／腹回り・ヒレ周り／S字フック）
//     3. シカ: 食道と肛門をしばる・生食不可・カラーアトラス p.8〜
//     4. 印刷（A4縦）で各手順が 1ページに収まり（PDFを作ってページ数を数える）、横にはみ出さない
//     5. 「全手順をまとめて印刷」に両方入る
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await ctx.addInitScript(() => { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', rt => {
    const u = rt.request().url();
    if (u.startsWith('file:')) return rt.continue();
    if (/cdnjs|jsdelivr|fonts\./.test(u)) return rt.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    return rt.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html') + '?tab=manual');
  await page.waitForTimeout(900);
  const results = []; const ck = (n, c, g) => results.push([n, c, g]);

  const cards = await page.evaluate(() => [...document.querySelectorAll('#manual-index > div')].map(d => d.textContent.replace(/\s+/g, ' ')));
  ck('カード一覧に「⑭ イノシシの解体手順」「⑮ シカ・キョンの解体手順」', cards.some(c => /⑭ イノシシの解体手順/.test(c)) && cards.some(c => /⑮ シカ・キョンの解体手順/.test(c)), cards.filter(c => /解体/.test(c)).join(' | '));

  const read = async id => {
    await page.evaluate(i => manualOpen(i), id);
    return page.evaluate(() => { const sh = document.querySelector('#manualView .mv-sheet'); return { h1: sh.querySelector('h1').textContent, steps: sh.querySelectorAll('.mv-step').length, foot: sh.querySelector('.mv-foot').textContent, meta: sh.querySelector('.mv-meta').textContent, text: sh.textContent.replace(/\s+/g, ' ') }; });
  };
  const b = await read('kaitai_boar');
  ck('⑭ 見出し・番号・版', /^🐗 イノシシの解体手順/.test(b.h1) && /⑭/.test(b.foot) && /一次版 2026-10-08/.test(b.meta) && b.steps === 10, JSON.stringify([b.h1, b.steps]));
  const boarMust = ['25kg未満', '0470-23-3566', '83℃以上', '約600g', '頬肉・首周り', '腹回り・ヒレ周り', 'S字フック', '捕獲個体管理台帳の裏面', '解体所見', 'カラーアトラス', '清掃記録(HACCP)'];
  ck('⑭ 現場ルールが入っている（' + boarMust.length + '項目）', boarMust.every(w => b.text.includes(w)), boarMust.filter(w => !b.text.includes(w)).join(','));
  const d = await read('kaitai_deer');
  ck('⑮ 見出し・番号', /^🦌 シカ・キョンの解体手順/.test(d.h1) && /⑮/.test(d.foot) && d.steps === 9, JSON.stringify([d.h1, d.steps]));
  const deerMust = ['食道と肛門をしばって', '第一胃', '生で食べられない', 'シカ p.8〜', '83℃以上', '毛が抜けやすく'];
  ck('⑮ シカの注意が入っている', deerMust.every(w => d.text.includes(w)), deerMust.filter(w => !d.text.includes(w)).join(','));

  // 印刷: 各手順が A4 1ページ
  for (const [id, label] of [['kaitai_boar', '⑭'], ['kaitai_deer', '⑮']]) {
    await page.evaluate(i => manualOpen(i), id);
    await page.emulateMedia({ media: 'print' });
    const over = await page.evaluate(() => { const sh = document.querySelector('#manualView .mv-sheet'); const sw = sh.getBoundingClientRect(); return [...sh.querySelectorAll('.mv-step, .mv-caution, .mv-meta')].filter(e => e.getBoundingClientRect().right > sw.right + 0.5).length; });
    const pdf = await page.pdf({ format: 'A4', preferCSSPageSize: true, printBackground: true });
    const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    await page.emulateMedia({ media: 'screen' });
    ck(`${label} 印刷: A4 1ページに収まる・横にはみ出さない`, pages === 1 && over === 0, `pages=${pages} over=${over}`);
  }

  await page.evaluate(() => manualOpen('all'));
  const all = await page.evaluate(() => [...document.querySelectorAll('#manualView .mv-sheet h1')].map(h => h.textContent));
  ck('「全手順をまとめて印刷」に ⑭・⑮ が入る', all.some(t => /イノシシの解体手順/.test(t)) && all.some(t => /シカ・キョンの解体手順/.test(t)), String(all.length));

  ck('pageerrorなし', errors.length === 0, errors.join(' / '));
  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got ? '  [' + String(got).slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
