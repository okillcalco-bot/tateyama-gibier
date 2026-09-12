// 産廃搬出 最終チェック表（出発前）をスマホから記録する
//
//   きっかけ（2026-09-12）
//     「産廃搬出ルール」（9/10制定・9/11改訂）で出発前に紙の最終チェック表を記入することになったが、
//     搬出担当者がその場でスマホから残せるよう、清掃記録(HACCP)の下に同じ10項目の入力欄を置いた。
//     紙と同じく「1項目でもOKでなければ搬出しない」ので、全部チェックするまで記録できない。
//
//   ここで測ること
//     1. index.html?tab=cleaning&sec=waste-checklist で清掃記録タブが開き、入力欄が出る
//     2. 項目は紙のチェック表と文言・順序が完全に一致する（10項目）
//     3. 9/10 では STOP 表示で記録ボタンが押せない。10/10 で OK になる
//     4. 記録すると waste_checklists に 10項目・all_ok=true・担当者 が保存され、一覧に出る
//     5. 記録後は入力がリセットされる（次の人のチェックが残らない）
//     6. sanpai.html（ルールのページ）から入力欄へのリンクがある
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
const fs = require('fs');

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
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));

  const db = { rows: [] };
  const posted = [];
  await page.route('**/*', r => {
    const u = r.request().url(), m = r.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/rest\/v1\/waste_checklists/.test(u)) {
      if (m === 'POST') {
        const b = JSON.parse(r.request().postData() || '{}');
        posted.push(b);
        db.rows.unshift(Object.assign({ id: 'wc' + posted.length, created_at: new Date().toISOString() }, b));
        return J([db.rows[0]]);
      }
      return J(db.rows);
    }
    return J([]);
  });

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  await page.goto('file://' + path.resolve(__dirname, '../../index.html') + '?tab=cleaning&sec=waste-checklist');
  await page.waitForTimeout(900);

  // 1) 深いリンクで清掃記録タブが開き、入力欄が出る
  T('?tab=cleaning で清掃記録タブが開く', await page.$eval('#panel-cleaning', el => el.classList.contains('active')), '');
  T('産廃搬出チェック表の入力欄がある', await page.$('#waste-checklist') !== null, '');
  await page.waitForTimeout(1200);
  const secTop = await page.$eval('#waste-checklist', el => Math.round(el.getBoundingClientRect().top));
  T('&sec=waste-checklist で入力欄まで自動で下がる（画面上端から120px以内）', secTop >= -5 && secTop <= 120, String(secTop));

  // 2) 項目は紙と同じ
  const items = await page.$$eval('#wc-items label', els => els.map(e => e.textContent.replace(/^\s*\d+\s*/, '').trim()));
  T('10項目', items.length === 10, String(items.length));
  T('紙のチェック表と文言・順序が完全一致', JSON.stringify(items) === JSON.stringify(PAPER_ITEMS), items.join(' / ').slice(0, 120));

  // 3) 9/10 では記録できない
  await page.evaluate(() => { PM_OPERATORS = ['沖浩志', '大和田薫']; wasteChecklistInit(); });
  const boxes = await page.$$('.wc-chk');
  for (let i = 0; i < 9; i++) await boxes[i].click();
  await page.waitForTimeout(100);
  T('9/10 は STOP 表示', /STOP/.test(await page.$eval('#wc-gate', el => el.textContent)), await page.$eval('#wc-gate', el => el.textContent));
  T('9/10 では記録ボタンが押せない', await page.$eval('#wc-save', el => el.disabled), '');
  await boxes[9].click();
  await page.waitForTimeout(100);
  T('10/10 で OK 表示', /確認OK/.test(await page.$eval('#wc-gate', el => el.textContent)), '');
  T('10/10 で記録ボタンが押せる', !(await page.$eval('#wc-save', el => el.disabled)), '');

  // 4) 記録する
  await page.selectOption('#wc-staff', '大和田薫');
  await page.fill('#wc-vehicle', '軽トラ 709');
  await page.fill('#wc-note', '液漏れの袋を二重にした');
  await page.click('#wc-save');
  await page.waitForTimeout(500);
  const p = posted[0] || {};
  T('waste_checklists に保存される', posted.length === 1, String(posted.length));
  T('10項目すべて ok=true で保存', Array.isArray(p.items) && p.items.length === 10 && p.items.every(i => i.ok === true), JSON.stringify(p.items || []).slice(0, 80));
  T('項目の文言も一緒に保存（後から紙と突き合わせられる）', Array.isArray(p.items) && p.items[0].text === PAPER_ITEMS[0], '');
  T('all_ok=true', p.all_ok === true, String(p.all_ok));
  T('担当者・車両・是正内容が保存', p.staff_name === '大和田薫' && p.vehicle === '軽トラ 709' && p.correction_note === '液漏れの袋を二重にした', JSON.stringify([p.staff_name, p.vehicle, p.correction_note]));
  T('搬出日が入る', /^\d{4}-\d{2}-\d{2}$/.test(p.checked_on || ''), p.checked_on);
  const recent = await page.$eval('#wc-recent', el => el.textContent.replace(/\s+/g, ' '));
  T('一覧に出る', /大和田薫/.test(recent) && /全項目OK/.test(recent), recent.slice(0, 100));

  // 5) 記録後はリセット
  const after = await page.evaluate(() => ({
    checked: [...document.querySelectorAll('.wc-chk')].filter(b => b.checked).length,
    note: document.getElementById('wc-note').value, staff: document.getElementById('wc-staff').value
  }));
  T('記録後はチェックが全部外れる', after.checked === 0, String(after.checked));
  T('記録後は是正内容・担当者が消える', after.note === '' && after.staff === '', JSON.stringify(after));

  // 6) スマホ幅で横に溢れない
  const of = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  T('スマホ幅で横スクロールしない', of <= 1, String(of));

  // 7) ルールのページからリンクがある
  const sanpai = fs.readFileSync(path.resolve(__dirname, '../../sanpai.html'), 'utf8');
  T('sanpai.html から入力欄へのリンクがある', /index\.html\?tab=cleaning&amp;sec=waste-checklist/.test(sanpai), '');

  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
