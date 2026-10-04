// 買取金額（buyback.html）: 提出時（通知書）と同じ「買取内容」の表を、印刷せずに画面で大きく見る（2026-10-04）
//
//   きっかけ
//     捕獲者さん（石渡さん）に買取料金を聞かれ、計算タブの一覧を見せたが、文字が小さく見にくかった。
//     一覧には他の人の名前・金額・口座も並ぶ。提出する通知書と同じ表を、その人の分だけ大きく見せたい。
//
//   ここで測ること（実際に描画した文字の大きさを px で測る）
//     1. 計算タブの行の「👁 表で見る」で、その人の表が全画面で開く
//     2. 表の文字は 18px 以上（一覧の明細は 12.5px）。Ａ＋で大きくなり、Ａ−で戻る
//     3. 表の中身は印刷する通知書の表と同じ（個体番号・買取価格・合計の行）
//     4. その人の分だけ: 他の支払先の名前・口座番号は出ない
//     5. 確定前は「現時点の計算」、精肉待ちがあれば頭数を出す
//     6. 行をクリックしたときの明細の開閉は起きない（ボタンは行のクリックと別）
//     7. Esc・閉じるで閉じる。スマホ幅（390px）でも画面全体は横にはみ出さない（表だけ横スクロール）
//     8. 通知書タブ: 人を選んで「画面で見る」。全員のままなら案内を出す
const pw = (() => { try { return require('/opt/node22/lib/node_modules/playwright'); } catch (e) { return require('playwright'); } })();
const path = require('path');

const RULES = { boar:{ female_rank_unit:{'並':100,'上':200,'極上':300}, male_unit:100, yield_ranks:[{rank:'A',min_pct:30,ratio:1,label:'3割以上'},{rank:'B',min_pct:20,ratio:0.5,label:'2〜3割'},{rank:'C',min_pct:10,ratio:0.3,label:'1〜2割'},{rank:'D',min_pct:0,ratio:0,label:'1割未満'}], weight_floor:true, min_weight_kg:20 }, deer:{unit:100,use_yield:true}, small:{price:1000,species:['キョン','アライグマ','ハクビシン','タヌキ','ノウサギ']}, pickup_fee:3000, source:'テスト' };
const HUNTERS = [
  { id:'h1', name:'石渡　裕', furigana:'いしわたゆたか', bank_name:'ＪＡ安房', bank_branch:'館野支店', account_type:'普通', account_number:'1234567', payee_no:4 },
  { id:'h2', name:'山田千代子', furigana:'やまだちよこ', bank_name:'千葉銀行', bank_branch:'館山支店', account_type:'普通', account_number:'7654321', payee_no:11 },
];
const INDS = [
  { id:'a1', label_id:'TGC-08-T301', species:'イノシシ', capture_date:'2026-09-02', capture_city:'館山市', hunter_name:'石渡裕', sex:'メス', weight_total:40, meat_rank:'上', stopkill_pickup:false, intake_method:'搬入', processing_done_at:'2026-09-05T02:00:00Z' },
  { id:'a2', label_id:'TGC-08-T302', species:'イノシシ', capture_date:'2026-09-10', capture_city:'館山市', hunter_name:'石渡裕', sex:'オス', weight_total:35, meat_rank:'並', stopkill_pickup:false, intake_method:'搬入', processing_done_at:'2026-09-12T02:00:00Z' },
  { id:'a3', label_id:'TGC-08-T303', species:'イノシシ', capture_date:'2026-09-20', capture_city:'館山市', hunter_name:'石渡裕', sex:'メス', weight_total:30, meat_rank:'並', stopkill_pickup:false, intake_method:'搬入', processing_done_at:null },
  { id:'b1', label_id:'TGC-08-M150', species:'イノシシ', capture_date:'2026-09-03', capture_city:'南房総市', hunter_name:'山田千代子', sex:'オス', weight_total:50, meat_rank:'並', stopkill_pickup:false, intake_method:'搬入', processing_done_at:'2026-09-06T02:00:00Z' },
];
const INV = [{ individual_id:'TGC-08-T301', weight:14, weight_kg:14 }, { individual_id:'TGC-08-T302', weight:9, weight_kg:9 }, { individual_id:'TGC-08-M150', weight:16, weight_kg:16 }];

async function open(width) {
  const browser = await pw.chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  await ctx.addInitScript(() => sessionStorage.setItem('tg_role_v1', 'admin'));
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', r => {
    const u = decodeURIComponent(r.request().url()), m = r.request().method();
    if (u.startsWith('file:')) return r.continue();
    if (/fonts\./.test(u)) return r.fulfill({ status: 200, body: '' });
    const J = x => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m !== 'GET') return J([]);
    if (/app_settings/.test(u)) return J([{ key: 'buyback_rules', value: RULES }]);
    if (/\/hunters/.test(u)) return J(HUNTERS);
    if (/\/individuals/.test(u)) return J(INDS);
    if (/\/inventory/.test(u)) return J(INV);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../buyback.html'));
  await page.waitForTimeout(700);
  await page.selectOption('#fYear', '8'); await page.selectOption('#fHalf', 'H1');
  await page.evaluate(() => { document.getElementById('fFrom').value = '2026-09-01'; document.getElementById('fTo').value = '2026-09-30'; return runCalc(); });
  await page.waitForTimeout(600);
  return { browser, page, errors };
}

(async () => {
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);
  {
    const { browser, page, errors } = await open(1280);
    const idx = await page.evaluate(() => D.result.payees.findIndex(p => p.payee.replace(/\s|　/g, '') === '石渡裕'));
    const listPx = await page.evaluate(() => { toggleDetail(0); const td = document.querySelector('.detail-row table td'); const px = parseFloat(getComputedStyle(td).fontSize); toggleDetail(0); return px; });
    await page.click(`#payeeBody tr.payee-row:nth-of-type(${idx * 2 + 1}) .nv-open`);
    await page.waitForTimeout(200);
    T('「👁 表で見る」で全画面の表が開く', await page.$eval('#noticeView', el => el.classList.contains('on') && el.getBoundingClientRect().width >= 1200), '');
    T('ボタンを押しても行の明細は開かない（行のクリックと別）', await page.$eval(`#det-${idx}`, el => el.style.display === 'none'), '');
    const px = await page.$eval('#nvBody tbody td', el => parseFloat(getComputedStyle(el).fontSize));
    T(`表の文字は 18px 以上（一覧の明細は ${listPx}px）`, px >= 18 && px > listPx, px);
    await page.click('#noticeView button:has-text("Ａ＋")'); await page.click('#noticeView button:has-text("Ａ＋")');
    const px2 = await page.$eval('#nvBody tbody td', el => parseFloat(getComputedStyle(el).fontSize));
    await page.click('#noticeView button:has-text("Ａ−")'); await page.click('#noticeView button:has-text("Ａ−")'); await page.click('#noticeView button:has-text("Ａ−")');
    const px3 = await page.$eval('#nvBody tbody td', el => parseFloat(getComputedStyle(el).fontSize));
    T('Ａ＋で大きく、Ａ−で戻る（最小 18px）', px2 > px && px3 === 18, `${px}→${px2}→${px3}`);
    const view = await page.$eval('#nvBody', el => el.innerText);
    T('名前・期間・合計金額が出る', /石渡　?裕　様/.test(view) && /令和8年度上半期/.test(view) && /買取合計金額/.test(view), view.slice(0, 120));
    // 印刷する通知書の表と同じ中身か
    const printed = await page.evaluate(p => { let out = ''; const o = window.open; window.open = () => ({ document: { write: h => { out += h; }, close(){} } });
      document.getElementById('nOne').value = p; printNotices(); window.open = o; document.getElementById('nOne').value = ''; return out; }, await page.evaluate(i => D.result.payees[i].payee, idx));
    const viewRows = await page.$$eval('#nvBody tbody tr', trs => trs.map(t => [...t.cells].map(c => c.textContent.trim()).join('|')));
    const printRows = await page.evaluate(h => { const d = new DOMParser().parseFromString(h, 'text/html'); return [...d.querySelectorAll('tbody tr')].map(t => [...t.cells].map(c => c.textContent.trim()).join('|')); }, printed);
    T('表の行は印刷する通知書と同じ（個体番号・買取価格・合計）', viewRows.length === 4 && JSON.stringify(viewRows) === JSON.stringify(printRows), JSON.stringify(viewRows));
    T('その人の分だけ（他の支払先の名前・口座番号は出ない）', !/山田/.test(view) && !/M150/.test(view) && !/1234567|7654321/.test(view), '');
    T('確定前は「現時点の計算」、精肉待ち1頭を表示', /現時点の計算/.test(view) && /精肉待ちの個体が 1頭/.test(view) && /確定分/.test(view), '');
    await page.keyboard.press('Escape');
    T('Esc で閉じる', await page.$eval('#noticeView', el => !el.classList.contains('on')) && await page.evaluate(() => document.body.style.overflow === ''), '');
    // 通知書タブ
    await page.evaluate(() => showTab('notice'));
    await page.click('button:has-text("選んだ人の表を画面で見る")');
    T('通知書タブ: 全員のままだと開かずに案内', await page.$eval('#noticeView', el => !el.classList.contains('on')) && /選んでください/.test(await page.$eval('#statusBar', el => el.textContent)), '');
    await page.selectOption('#nOne', { index: 2 });
    await page.click('button:has-text("選んだ人の表を画面で見る")');
    const who = await page.$eval('#nvBody .nv-name', el => el.textContent);
    T('通知書タブ: 選んだ人の表が開く', await page.$eval('#noticeView', el => el.classList.contains('on')) && who.includes(await page.$eval('#nOne', s => s.value)), who);
    await page.click('#noticeView button:has-text("閉じる")');
    T('閉じるボタンで閉じる', await page.$eval('#noticeView', el => !el.classList.contains('on')), '');
    T('pageerror なし', errors.length === 0, errors.join(' / '));
    await browser.close();
  }
  {
    const { browser, page, errors } = await open(390);
    await page.evaluate(() => noticeViewOpen(0));
    await page.waitForTimeout(200);
    const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth, nv: document.getElementById('noticeView').scrollWidth, px: parseFloat(getComputedStyle(document.querySelector('#nvBody tbody td')).fontSize) }));
    T('スマホ幅（390px）: 画面全体は横にはみ出さず、表だけ横スクロール・文字18px', m.doc <= m.vw && m.nv <= m.vw && m.px >= 18, JSON.stringify(m));
    T('スマホ幅: pageerror なし', errors.length === 0, errors.join(' / '));
    await browser.close();
  }
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
