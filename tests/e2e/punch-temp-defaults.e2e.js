// 出退勤: 退勤時の庫内温度は基準の値が最初から入っていて、違うときだけ直す
//
//   きっかけ（2026-09-16）
//     HACCP提出セットの冷蔵・冷凍庫温度記録が 0件 だった。温度欄が空のまま退勤しても
//     何も起きないため、誰も入れていなかった。
//     「基本的に範囲内で自動で入力して、おかしな数値があったときだけ手入力する」という運用に合わせ、
//     施設チェック表の温度項目（7つ）と清掃「冷蔵・冷凍庫」の温度欄に基準の値を入れておく。
//
//   ここで測ること
//     1. 施設チェック表の温度項目に基準の値（-1 / -18 / -20 / -60）が入っている
//     2. 清掃「冷蔵・冷凍庫」の温度欄にも既定値が入っている
//     3. そのまま退勤すると facility_check_logs に温度の値が入って保存される
//     4. 1か所だけ直すと、その値だけ変わり他は既定値のまま
//     5. 清掃の温度は cleaning_logs に入る（冷蔵・冷凍庫の行だけ）
//     6. 温度欄は描き直し（清掃の場所を押して外す）で消えない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const TODAY = ymd(new Date());
const STAFF = [{ id: 's1', name: '吉田友美', default_break_min: 60 }];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', async d => { await d.accept(); });
  const posted = [];
  await page.route('**/*', r => {
    const u = r.request().url(), m = r.request().method();
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/rest\/v1\/staff/.test(u)) { if (m === 'PATCH') return J([{}]); return J(STAFF); }
    if (/\/rest\/v1\/attendance/.test(u)) {
      if (m === 'PATCH') { posted.push({ t: 'attendance', body: JSON.parse(r.request().postData() || '{}') }); return J([{ id: 'a1' }]); }
      return J([{ id: 'a1', staff_id: 's1', staff_name: '吉田友美', work_date: TODAY, clock_in: '08:00', clock_out: null, break_minutes: 60 }]);
    }
    if (/\/rest\/v1\/(cleaning_logs|facility_check_logs)/.test(u)) {
      const t = /cleaning_logs/.test(u) ? 'cleaning_logs' : 'facility_check_logs';
      posted.push({ t, body: JSON.parse(r.request().postData() || '[]') }); return J([{}]);
    }
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../punch.html'));
  await page.waitForTimeout(600);

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  await page.click('.name-btn');
  await page.waitForTimeout(500);

  // 1) 施設チェック表の温度項目に基準の値
  const temps = await page.$$eval('.fc-temp', els => els.map(e => e.value));
  T('温度項目が7つある', temps.length === 7, temps.join(','));
  T('基準の値が入っている（-1,-18,-20,-20,-60,-20,-20）', temps.join(',') === '-1,-18,-20,-20,-60,-20,-20', temps.join(','));

  // 2) 清掃「冷蔵・冷凍庫」の温度欄
  const roomTemp = await page.$eval('#temp-input', e => e.value);
  T('清掃の冷蔵・冷凍庫にも既定値が入っている', roomTemp === '冷蔵-1 / 冷凍-20', roomTemp);

  // 6) 描き直しで消えない（別の清掃場所を押して外す→戻す）
  await page.evaluate(() => { toggleRoom('トイレ'); toggleRoom('トイレ'); });
  const roomTemp2 = await page.$eval('#temp-input', e => e.value);
  T('清掃の場所を押し直しても温度欄が消えない', roomTemp2 === '冷蔵-1 / 冷凍-20', roomTemp2);

  // 4) 1か所だけ直す（冷凍ストッカー1 を -12 に）
  const inputs = await page.$$('.fc-temp');
  await inputs[2].fill('-12');
  await page.waitForTimeout(100);

  // 3) そのまま退勤 → 保存内容
  await page.evaluate(() => punchOut());
  await page.waitForTimeout(800);
  const fc = posted.find(p => p.t === 'facility_check_logs');
  T('退勤で施設チェック表が保存される', !!fc, '');
  const tempRows = fc ? fc.body.filter(r => r.value != null) : [];
  T('温度の値が入った行が7つある', tempRows.length === 7, String(tempRows.length));
  const byItem = {}; tempRows.forEach(r => byItem[r.item] = r.value);
  T('直した項目だけ変わる（冷凍ストッカー1=-12）', byItem['冷凍ストッカー1'] === '-12', JSON.stringify(byItem));
  T('他は既定値のまま（ユニット冷蔵庫=-1、-60℃=-60、大型冷凍庫2=-20）',
    byItem['ユニット冷蔵庫'] === '-1' && byItem['冷凍ストッカー(-60℃)'] === '-60' && byItem['大型冷凍庫2'] === '-20', JSON.stringify(byItem));

  // 5) 清掃の温度
  const cl = posted.find(p => p.t === 'cleaning_logs');
  const fridge = cl ? cl.body.find(r => r.room === '冷蔵・冷凍庫') : null;
  T('清掃記録の冷蔵・冷凍庫に温度が入る', !!fridge && fridge.temperature === '冷蔵-1 / 冷凍-20', fridge && fridge.temperature);
  T('他の部屋には温度を付けない', cl && cl.body.filter(r => r.room !== '冷蔵・冷凍庫').every(r => r.temperature == null), '');

  T('ページエラーなし', errors.length === 0, errors.join(' / '));

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
