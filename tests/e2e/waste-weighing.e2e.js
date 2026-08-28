// 産廃搬出（計量票）の記録
//   紙の計量票を続けて入れていく画面。いちばん大事なのは
//   「総重 − 風袋 = 正味」を手で入れさせないことと、同じ票を二度入れないこと。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

// 実際の票（令和8年）から
const ROWS = [
  { id: 'w1', weighed_on: '2026-06-20', weighed_time: '08:58', vehicle_no: '9434', trip_no: 2,
    gross_kg: 1510, tare_kg: 1080, net_kg: 430, waste_type: '動植物性残さ',
    vendor_name: '杉田建材株式会社 環境事業本部', site_name: '市原サーマルセンター', manifest_no: null, note: null },
  { id: 'w2', weighed_on: '2026-06-12', weighed_time: '15:55', vehicle_no: '2741', trip_no: 33,
    gross_kg: 1280, tare_kg: 1030, net_kg: 250, waste_type: '動植物性残さ',
    vendor_name: '杉田建材株式会社 環境事業本部', site_name: '市原サーマルセンター', manifest_no: null, note: null },
  { id: 'w3', weighed_on: '2026-06-09', weighed_time: '12:49', vehicle_no: '2741', trip_no: 22,
    gross_kg: 1500, tare_kg: 1040, net_kg: 460, waste_type: '動植物性残さ',
    vendor_name: '杉田建材株式会社 環境事業本部', site_name: '市原サーマルセンター', manifest_no: null, note: null },
  { id: 'w4', weighed_on: '2026-05-08', weighed_time: '14:24', vehicle_no: '6478', trip_no: 38,
    gross_kg: 1460, tare_kg: 810, net_kg: 650, waste_type: '動植物性残さ',
    vendor_name: '杉田建材株式会社 環境事業本部', site_name: '市原サーマルセンター', manifest_no: null, note: null },
  { id: 'w5', weighed_on: '2026-04-20', weighed_time: '13:43', vehicle_no: '709', trip_no: 41,
    gross_kg: 1270, tare_kg: 810, net_kg: 460, waste_type: '動植物性残さ',
    vendor_name: '杉田建材株式会社 環境事業本部', site_name: '市原サーマルセンター', manifest_no: null, note: null },
  // 年度をまたぐ確認用（3月は前の年度）
  { id: 'w0', weighed_on: '2026-03-31', weighed_time: '10:00', vehicle_no: '709', trip_no: 9,
    gross_kg: 1000, tare_kg: 700, net_kg: 300, waste_type: '動植物性残さ',
    vendor_name: '杉田建材株式会社 環境事業本部', site_name: '市原サーマルセンター', manifest_no: null, note: null },
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const asked = []; let answer = true;
  page.on('dialog', async d => { asked.push(d.message()); answer ? await d.accept() : await d.dismiss(); });

  const db = { rows: ROWS.slice() };
  const posted = [];
  await page.route('**/*', r => {
    const u = r.request().url(), m = r.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/rest\/v1\/waste_weighings/.test(u)) {
      const dec = decodeURIComponent(u);
      if (m === 'POST') {
        const b = JSON.parse(r.request().postData() || '{}');
        posted.push(b);
        const row = Object.assign({ id: 'new' + posted.length }, b);
        row.net_kg = Number(b.gross_kg) - Number(b.tare_kg);
        db.rows.unshift(row);
        return J([row]);
      }
      if (m === 'PATCH') {
        const id = (dec.match(/id=eq\.([^&]+)/) || [])[1];
        db.rows = db.rows.filter(x => x.id !== id);
        return J([]);
      }
      // 重複の確認
      const man = (dec.match(/manifest_no=eq\.([^&]+)/) || [])[1];
      if (man) return J(db.rows.filter(x => x.manifest_no === man));
      const d = (dec.match(/weighed_on=eq\.([^&]+)/) || [])[1];
      const t = (dec.match(/weighed_time=eq\.([^&]+)/) || [])[1];
      const v = (dec.match(/vehicle_no=eq\.([^&]+)/) || [])[1];
      if (d && t && v) return J(db.rows.filter(x => x.weighed_on === d && x.weighed_time === t && x.vehicle_no === v));
      // 一覧
      const gte = (dec.match(/weighed_on=gte\.([^&]+)/) || [])[1];
      let rows = db.rows.slice();
      if (gte) rows = rows.filter(x => x.weighed_on >= gte);
      rows.sort((a, b) => (a.weighed_on < b.weighed_on ? 1 : a.weighed_on > b.weighed_on ? -1 : 0));
      return J(rows);
    }
    return J([]);
  });

  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(700);

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  await page.click('.tab-btn[data-tab="waste"]');
  await page.waitForTimeout(800);

  // ── 1) 一覧と集計 ──
  const body = await page.$eval('#wst-body', el => el.textContent.replace(/\s+/g, ' '));
  T('計量票が一覧に出る', /2026-06-20/.test(body) && /9434/.test(body), body.slice(0, 70));
  T('正味が出る', /430/.test(body) && /650/.test(body), '');
  T('新しい順に並ぶ',
    (await page.$$eval('#wst-body tr td:first-child', els => els.map(e => e.textContent)))[0] === '2026-06-20', '');
  const sum = await page.$eval('#wst-summary', el => el.textContent.replace(/\s+/g, ' '));
  T('枚数と合計が出る', /6枚/.test(sum) && /2,550 kg/.test(sum), sum.slice(0, 90));
  T('月ごとに出る', /2026-06/.test(sum) && /1,140 kg/.test(sum), '');
  T('年度は4月はじまり（3月は前年度）',
    /令和8年度（2026）/.test(sum) && /令和7年度（2025）/.test(sum), sum.slice(-220));

  // ── 2) 正味は入力させず、その場で計算して見せる ──
  T('正味の入力欄は無い（計算で出す）',
    await page.evaluate(() => !document.querySelector('input#wst-net')), '');
  await page.fill('#wst-gross', '1270');
  await page.fill('#wst-tare', '810');
  await page.waitForTimeout(150);
  T('総重と風袋を入れると正味が出る',
    (await page.$eval('#wst-net', el => el.textContent)) === '460 kg',
    await page.$eval('#wst-net', el => el.textContent));
  await page.fill('#wst-tare', '1400');
  await page.waitForTimeout(150);
  T('風袋が総重より重いと知らせる',
    /風袋が総重より重く/.test(await page.$eval('#wst-net-warn', el => el.textContent)), '');

  // ── 3) 和暦を出す（票は令和で書かれている） ──
  await page.fill('#wst-date', '2026-06-20');
  await page.waitForTimeout(150);
  T('入れた日付を令和で見せる',
    (await page.$eval('#wst-wareki', el => el.textContent)) === '令和8年6月20日',
    await page.$eval('#wst-wareki', el => el.textContent));

  // ── 4) 打ち間違いを保存前に止める ──
  asked.length = 0; posted.length = 0;
  await page.fill('#wst-gross', '800'); await page.fill('#wst-tare', '1000');
  await page.click('button[onclick="wstSave()"]');
  await page.waitForTimeout(300);
  T('風袋＞総重は保存しない', posted.length === 0 && asked.some(a => /風袋が総重より重く/.test(a)), asked.join(' / '));

  asked.length = 0;
  await page.evaluate(() => { document.getElementById('wst-date').value = ''; });
  await page.fill('#wst-gross', '1270'); await page.fill('#wst-tare', '810');
  await page.click('button[onclick="wstSave()"]');
  await page.waitForTimeout(300);
  T('搬出日が無ければ保存しない', posted.length === 0 && asked.some(a => /搬出日を入れて/.test(a)), asked.join(' / '));

  // ── 5) 同じ票を二度入れない ──
  asked.length = 0;
  await page.evaluate(() => {
    document.getElementById('wst-date').value = '2026-06-20';
    document.getElementById('wst-time').value = '08:58';
    document.getElementById('wst-vehicle').value = '9434';
    document.getElementById('wst-gross').value = '1510';
    document.getElementById('wst-tare').value = '1080';
  });
  await page.click('button[onclick="wstSave()"]');
  await page.waitForTimeout(500);
  T('同じ日時・車番の票は保存前に止める',
    posted.length === 0 && asked.some(a => /既に入っています/.test(a)), asked.join(' / ').slice(0, 80));

  // ── 6) ふつうに1枚入れる → 続けて入れられる状態になる ──
  asked.length = 0; posted.length = 0;
  await page.evaluate(() => {
    document.getElementById('wst-date').value = '2026-07-03';
    document.getElementById('wst-time').value = '11:20';
    document.getElementById('wst-vehicle').value = '709';
    document.getElementById('wst-trip').value = '7';
    document.getElementById('wst-gross').value = '1350';
    document.getElementById('wst-tare').value = '810';
    document.getElementById('wst-vendor').value = '杉田建材株式会社 環境事業本部';
    document.getElementById('wst-site').value = '市原サーマルセンター';
    document.getElementById('wst-by').value = 'テスト';
  });
  await page.click('button[onclick="wstSave()"]');
  await page.waitForTimeout(700);
  T('1枚保存できる', posted.length === 1, JSON.stringify(posted[0] || {}).slice(0, 90));
  T('正味は送らない（DB側で計算する）',
    posted.length === 1 && !('net_kg' in posted[0]), Object.keys(posted[0] || {}).join(','));
  T('総重・風袋・車番・回数を送る',
    posted[0].gross_kg === 1350 && posted[0].tare_kg === 810 && posted[0].vehicle_no === '709' && posted[0].trip_no === 7, '');
  T('保存したら日付と重さは消える',
    (await page.$eval('#wst-gross', el => el.value)) === '' && (await page.$eval('#wst-tare', el => el.value)) === '', '');
  T('処理業者と搬入先は残る（続けて入れやすく）',
    (await page.$eval('#wst-vendor', el => el.value)).includes('杉田建材')
    && (await page.$eval('#wst-site', el => el.value)) === '市原サーマルセンター', '');
  T('入れた結果を画面に出す',
    /540kg を記録しました/.test(await page.$eval('#wst-msg', el => el.textContent)),
    await page.$eval('#wst-msg', el => el.textContent));
  T('一覧にすぐ出る', /2026-07-03/.test(await page.$eval('#wst-body', el => el.textContent)), '');

  // ── 7) 消したものは一覧から消える（追える形で残す） ──
  asked.length = 0;
  await page.evaluate(() => wstDelete('w5'));
  await page.waitForTimeout(600);
  T('削除は確認してから', asked.some(a => /削除しますか/.test(a)), asked.join(' / ').slice(0, 60));
  T('消したら一覧から消える', !/2026-04-20/.test(await page.$eval('#wst-body', el => el.textContent)), '');

  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
