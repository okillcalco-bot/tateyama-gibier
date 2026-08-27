// 学習ページ「獣を知る」
//   パートさんが読むページなので、ログイン不要で開けること・スマホで崩れないこと・
//   命に関わる数値（加熱条件・基準値）が正しく出ていること・出典が付いていることを測る。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let outbound = 0;
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith('file:')) return r.continue();
    outbound++;                                  // 外部への通信は本来ゼロのはず
    return r.fulfill({ status: 200, body: '' });
  });

  const results = [];
  const file = 'file://' + path.resolve(__dirname, '../../manabu.html');
  await page.goto(file);
  await page.waitForTimeout(400);
  const txt = await page.evaluate(() => document.body.innerText);
  // 折りたたみ(details)の中身は innerText に出ないので、内容の有無は textContent で見る
  const all = await page.evaluate(() => document.body.textContent.replace(/\s+/g, ' '));

  // 1) ログイン不要で中身が出る（パートさんが見られること）
  results.push(['ログインなしで読める', txt.length > 2000 && /獣を知る/.test(txt), txt.length + '文字']);
  results.push(['外部へ通信しない', outbound === 0, String(outbound)]);

  // 2) 命に関わる数値が正しい
  results.push(['加熱条件が中心部75℃1分以上', /中心部を?75℃で1分以上|中心部75℃1分以上/.test(txt.replace(/\s/g, '')) || /75℃で1分以上/.test(txt), '']);
  results.push(['放射性セシウムの基準値100Bq/kg', /1kgあたり100ベクレル/.test(all), '']);
  results.push(['生食は不可と明記', /生では絶対に出さない/.test(txt) && /刺身/.test(txt), '']);
  results.push(['迷ったら止める', /迷ったら止めて/.test(txt), '']);

  // 3) 「判断できないものは廃棄」が抜けていない（ここが実務でいちばん効く）
  results.push(['判断できないものは全部廃棄', /食用として問題がないと判断できないもの/.test(txt), '']);

  // 4) 実際に来る獣が7種そろっている（搬入台帳の実測に合わせる）
  for (const sp of ['イノシシ', 'キョン', 'ハクビシン', 'アライグマ', 'シカ', 'タヌキ', 'ノウサギ']) {
    results.push([`${sp}が載っている`, txt.includes(sp), '']);
  }
  results.push(['実測の頭数が入っている', /477/.test(txt) && /64/.test(txt), '']);

  // 5) 衛生の主要項目
  for (const k of ['E型肝炎', '旋毛虫', 'SFTS', '豚熱', 'レプトスピラ', '疥癬']) {
    results.push([`${k}に触れている`, all.includes(k), '']);
  }
  results.push(['豚熱は人にうつらないと書く', /豚熱は人には感染しません/.test(all), '']);
  results.push(['冷凍は理由にならないと書く', /冷凍は安全の根拠になりません|冷凍は安全の理由にならない/.test(all), '']);

  // 6) 公式が正であることと出典
  results.push(['公式ガイドラインが正と明記', /ガイドラインが正/.test(txt), '']);
  const links = await page.$$eval('#srcList a', a => a.map(x => x.href));
  results.push(['出典リンクが10本以上ある', links.length >= 10, String(links.length)]);
  results.push(['厚労省と千葉県の出典がある',
    links.some(u => /mhlw\.go\.jp/.test(u)) && links.some(u => /pref\.chiba\.lg\.jp/.test(u)), '']);
  const targets = await page.$$eval('#srcList a', a => a.length > 0 && a.every(x => x.target === '_blank' && /noopener/.test(x.rel)));
  results.push(['出典は別タブで開く（読みかけを失わない）', targets, '']);

  // 7) クイズが動く
  await page.click('#opt0 button:nth-child(1)');
  await page.waitForTimeout(150);
  results.push(['正解を選ぶと印がつく', await page.$eval('#opt0 button:nth-child(1)', el => el.classList.contains('ok')), '']);
  results.push(['解説が出る', /冷凍が効きません/.test(await page.$eval('#why0', el => el.innerText)), '']);
  await page.click('#opt1 button:nth-child(2)');
  await page.waitForTimeout(150);
  const wrong = await page.evaluate(() => ({
    ng: document.querySelector('#opt1 button:nth-child(2)').classList.contains('ng'),
    ok: document.querySelector('#opt1 button:nth-child(1)').classList.contains('ok')
  }));
  results.push(['不正解でも正解を示す', wrong.ng && wrong.ok, JSON.stringify(wrong)]);
  await page.click('#opt1 button:nth-child(1)');
  await page.waitForTimeout(150);
  results.push(['答えたあとは変えられない', await page.evaluate(() => answered[1]) === 1,
    String(await page.evaluate(() => answered[1]))]);
  results.push(['回答数が出る', /2\/6問 回答ずみ/.test(await page.$eval('#score', el => el.textContent)),
    await page.$eval('#score', el => el.textContent)]);

  // 8) 途中まで答えた状態が残る（一度に読み切れなくてよい）
  await page.reload();
  await page.waitForTimeout(400);
  results.push(['開き直しても回答が残る',
    await page.$eval('#opt0 button:nth-child(1)', el => el.classList.contains('ok')), '']);

  // 9) スマホで横に溢れない（折りたたみを全部開いた状態でも）
  const of = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  results.push(['スマホ幅で横スクロールしない', of <= 1, String(of)]);
  await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true));
  await page.waitForTimeout(250);
  const of2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  results.push(['全部開いても横スクロールしない', of2 <= 1, String(of2)]);
  results.push(['開くと中身が読める', /レプトスピラ/.test(await page.evaluate(() => document.body.innerText)), '']);

  // 10) 業務アプリから辿れる（パートさんが自力でたどり着けること）
  const idx = require('fs').readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
  results.push(['業務アプリにリンクがある', /href="manabu\.html"/.test(idx), '']);
  results.push(['学習と分かる名前で出す', /獣を知る（学習）/.test(idx), '']);

  results.push(['pageerrorなし', errors.length === 0, errors.join(' / ')]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' && got != null ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
