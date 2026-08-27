// 学習ページ「獣を知る」
//   パートさんが読むページなので、ログイン不要で開けること・スマホで崩れないこと・
//   命に関わる数値（加熱条件・基準値）が正しく出ていること・出典が付いていることを測る。
//   搬入頭数は年度を取り違えやすいので、DBの実測値と一致しているかも見る。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
const fs = require('fs');

// 令和8年度（2026-04-01〜2027-03-31）／令和7年度 の実測値。DBを測り直したらここも直す
const HEADCOUNT = [
  ['イノシシ', 477, 0], ['キョン', 53, 11], ['ハクビシン', 18, 2],
  ['アライグマ', 15, 4], ['シカ', 13, 2], ['タヌキ', 0, 4], ['ノウサギ', 0, 3]
];
// DBの species 値と、ページの見出しの綴りは同じとは限らない
// （「シカ」は「ニホンジカ」に含まれない。ジ≠シ）
const SECTION_OF = { 'シカ': 'ニホンジカ' };

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
  results.push(['中身の分量がある（生態を薄く書かない）', all.length > 14000, all.length + '文字']);

  // 2) 命に関わる数値が正しい
  results.push(['加熱条件が中心部75℃1分以上', /中心部を?75℃で1分以上/.test(txt.replace(/\s/g, '')) || /75℃で1分以上/.test(all), '']);
  results.push(['放射性セシウムの基準値100Bq/kg', /1kgあたり100ベクレル/.test(all), '']);
  results.push(['生食は不可と明記', /生では絶対に出さない/.test(txt) && /刺身/.test(txt), '']);
  results.push(['迷ったら止める', /迷ったら止めて/.test(txt), '']);
  results.push(['判断できないものは全部廃棄', /食用として問題がないと判断できないもの/.test(txt), '']);

  // 3) 冷凍の扱いを取り違えていない（効くものと効かないものがある）
  results.push(['冷凍が効かない寄生虫があると書く', /冷凍で死なない種類|冷凍が効かない/.test(all), '']);
  results.push(['住肉胞子虫は冷凍が効くと書く', /−20℃なら48時間以上|−20℃で48時間以上/.test(all), '']);

  // 4) 7種すべてが「食肉にする」前提で、実測の頭数と一致している
  const table = await page.$eval('#kemono ~ .card table', el => el.innerText.replace(/\s+/g, ' '));
  for (const [sp, r8, r7] of HEADCOUNT) {
    results.push([`${sp}: 令和8年度${r8}・令和7年度${r7}`,
      new RegExp(`${sp} ${r8} ${r7}`).test(table), '']);
  }
  results.push(['「防除（食べない）」と書いていない', !/しない（防除）/.test(all), '']);
  results.push(['7種すべて食肉にすると明記', /7種すべてを食肉にしています/.test(txt), '']);
  results.push(['タヌキ・ノウサギが令和8年度0頭だと分かる', /令和8年度はまだ搬入がなく/.test(txt), '']);

  // 5) 獣種ごとに、生態の中身とおすすめの調理が両方ある
  const perSpecies = await page.$$eval('details', ds => ds.map(d => ({
    title: d.querySelector('summary').textContent.trim(),
    len: d.querySelector('.body').textContent.replace(/\s+/g, ' ').length,
    cook: !!d.querySelector('.cook'),
    sci: !!d.querySelector('.sci')
  })));
  for (const [sp] of HEADCOUNT) {
    const key = SECTION_OF[sp] || sp;
    const d = perSpecies.find(x => x.title.includes(key));
    results.push([`${sp}: 生態の記述が十分ある`, !!d && d.len >= 700, d ? d.len + '文字' : 'なし']);
    results.push([`${sp}: おすすめの調理がある`, !!d && d.cook, '']);
    results.push([`${sp}: 学名がある`, !!d && d.sci, '']);
  }

  // 6) 海外文献にもとづく記述が入っている
  results.push(['キョンの妊娠210日・出産直後に発情', /約210日/.test(all) && /出産直後に発情/.test(all), '']);
  results.push(['タヌキが一夫一妻で両親が子育て', /厳密な一夫一妻/.test(all) && /子育てにも参加/.test(all), '']);
  results.push(['旋毛虫の海外保有率', /57\.5%/.test(all) && /39\.8%/.test(all), '']);
  results.push(['日本の旋毛虫保有率', /0\.9%/.test(all) && /1\.6%/.test(all), '']);
  results.push(['タヌキのため糞', /ため糞/.test(all), '']);
  results.push(['ノウサギの食糞（盲腸糞）', /盲腸糞/.test(all), '']);
  results.push(['アライグマとタヌキの見分け方', /尾に黒い縞が5〜7本/.test(all), '']);
  results.push(['ハクビシンの見分け方', /白い筋/.test(all), '']);
  results.push(['シカが反芻動物だと書く', /反芻動物/.test(all), '']);

  // 7) 病気ごとに「どうやって起こるか／症状／治し方」が揃っている
  const disease = await page.$$eval('#byouki ~ details', ds => ds.map(d => ({
    title: d.querySelector('summary').textContent.trim(),
    h3: [...d.querySelectorAll('h3')].map(h => h.textContent.trim())
  })));
  const NEED = ['E型肝炎', '旋毛虫症', '住肉胞子虫', '肺吸虫症', '腸管出血性大腸菌',
    'SFTS', 'レプトスピラ症', 'アライグマ回虫症', '野兎病', '疥癬'];
  for (const k of NEED) {
    const d = disease.find(x => x.title.includes(k));
    results.push([`${k}: どうやって起こるかを書く`, !!d && d.h3.some(h => /どうやって起こるか|人への影響/.test(h)), '']);
  }
  for (const k of ['E型肝炎', '旋毛虫症', '住肉胞子虫', '肺吸虫症', 'SFTS', 'レプトスピラ症', 'アライグマ回虫症', '野兎病', '疥癬']) {
    const d = disease.find(x => x.title.includes(k));
    results.push([`${k}: 症状と治し方を書く`,
      !!d && d.h3.some(h => /症状/.test(h)) && d.h3.some(h => /治し方|治療/.test(h)), d ? d.h3.join('/') : 'なし']);
  }

  // 8) 治療の要点（受診の速さが効くもの）
  results.push(['SFTSの致死率と早期投与', /約27%/.test(all) && /5〜6日以内/.test(all), '']);
  results.push(['ファビピラビル承認に触れる', /ファビピラビル/.test(all) && /2024年6月/.test(all), '']);
  results.push(['野兎病の感染菌量', /10〜50個/.test(all), '']);
  results.push(['E型肝炎の妊婦リスク', /10〜25%/.test(all), '']);
  results.push(['治療は医師が行うと断る', /自分で判断するためのものではありません/.test(txt), '']);

  // 9) 公式が正であることと出典
  results.push(['公式ガイドラインが正と明記', /ガイドラインが正/.test(txt), '']);
  const links = await page.$$eval('#srcList a', a => a.map(x => x.href));
  results.push(['出典リンクが35本以上ある', links.length >= 35, String(links.length)]);
  results.push(['厚労省と千葉県の出典がある',
    links.some(u => /mhlw\.go\.jp/.test(u)) && links.some(u => /pref\.chiba\.lg\.jp/.test(u)), '']);
  results.push(['海外の学術文献の出典がある',
    links.some(u => /springer\.com|ncbi\.nlm\.nih\.gov|link\.springer/.test(u)), '']);
  results.push(['査読文献でない出典があると断る', /査読された文献ではありません/.test(txt), '']);
  const targets = await page.$$eval('#srcList a', a => a.length > 0 && a.every(x => x.target === '_blank' && /noopener/.test(x.rel)));
  results.push(['出典は別タブで開く（読みかけを失わない）', targets, '']);

  // 10) クイズが動く
  await page.click('#opt0 button:nth-child(1)');
  await page.waitForTimeout(150);
  results.push(['正解を選ぶと印がつく', await page.$eval('#opt0 button:nth-child(1)', el => el.classList.contains('ok')), '']);
  results.push(['解説が出る', /冷凍が効かない/.test(await page.$eval('#why0', el => el.innerText)), '']);
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
  results.push(['回答数が出る', /2\/8問 回答ずみ/.test(await page.$eval('#score', el => el.textContent)),
    await page.$eval('#score', el => el.textContent)]);

  // 11) 途中まで答えた状態が残る（一度に読み切れなくてよい）
  await page.reload();
  await page.waitForTimeout(400);
  results.push(['開き直しても回答が残る',
    await page.$eval('#opt0 button:nth-child(1)', el => el.classList.contains('ok')), '']);

  // 12) 古い保存（設問が減った頃のもの）が残っていても壊れない
  await page.evaluate(() => localStorage.setItem('tg_manabu_quiz', JSON.stringify({ 0: 0, 99: 1 })));
  await page.reload();
  await page.waitForTimeout(400);
  results.push(['古い回答が残っていても壊れない',
    errors.length === 0 && /1\/8問 回答ずみ/.test(await page.$eval('#score', el => el.textContent)),
    await page.$eval('#score', el => el.textContent)]);
  await page.evaluate(() => localStorage.removeItem('tg_manabu_quiz'));

  // 13) スマホで横に溢れない（折りたたみを全部開いた状態でも）
  await page.reload();
  await page.waitForTimeout(400);
  const of = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  results.push(['スマホ幅で横スクロールしない', of <= 1, String(of)]);
  await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true));
  await page.waitForTimeout(300);
  const of2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  results.push(['全部開いても横スクロールしない', of2 <= 1, String(of2)]);
  results.push(['開くと中身が読める', /レプトスピラ/.test(await page.evaluate(() => document.body.innerText)), '']);

  // 14) 業務アプリから辿れる（パートさんが自力でたどり着けること）
  const idx = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');
  results.push(['業務アプリにリンクがある', /href="manabu\.html"/.test(idx), '']);
  results.push(['学習と分かる名前で出す', /獣を知る（学習）/.test(idx), '']);

  results.push(['pageerrorなし', errors.length === 0, errors.join(' / ')]);

  let pass = 0;
  for (const [name, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + name + (got !== '' && got != null ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
