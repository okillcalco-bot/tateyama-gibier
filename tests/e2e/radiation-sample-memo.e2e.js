// 個体一覧（index.html）: 放射能検査の検体メモ印刷（A4普通紙・3列×8段=24枚）
//   手書きの検体メモ（10/13・604・T383・鈴木政孝）と同じ4行を、一覧から印刷する。
//   実寸で描画して、1枚に24個・各メモ66.7×35.9mm（周囲5mmはプリンタが刷れないので空ける）・文字がはみ出さないことを測る。
const pw = (() => { try { return require('/opt/node22/lib/node_modules/playwright'); } catch (e) { return require('playwright'); } })();
const { chromium } = pw;
const path = require('path');

const mk = (n, extra = {}) => ({ label_id: `TGC-08-T${n}`, serial_number: 220 + n, species: 'イノシシ', capture_date: '2026-10-13', hunter_name: '鈴木政孝', ...extra });
const INDS = [
  mk(383, { serial_number: 604 }),
  ...Array.from({ length: 25 }, (_, k) => mk(384 + k, { capture_date: k < 20 ? '2026-10-14' : '2026-10-15' })),
  mk(410, { hunter_name: '長い名前の捕獲者さん', capture_date: '2026-10-14' }),
  { label_id: 'TGC-08-M210', serial_number: 99, species: 'シカ', capture_date: '2026-10-14', hunter_name: null },
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext(); await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_role_v1', 'admin'); localStorage.setItem('tg_staff_key', 'TESTKEY'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let promptAns = '2026-10-14';
  page.on('dialog', d => d.accept(promptAns));
  await page.route('**/*', r => {
    const u = decodeURIComponent(r.request().url());
    if (u.startsWith('file:')) return r.continue();
    if (/fonts\./.test(u)) return r.fulfill({ status: 200, body: '' });
    const J = x => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (/\/individuals/.test(u) && r.request().method() === 'GET' && !/intake_status=eq/.test(u)) return J(INDS);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(800);
  const results = []; const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  await page.evaluate(() => indLoad());
  await page.waitForTimeout(500);
  T('個体一覧に「🧪 検体メモ印刷」ボタンがある', await page.evaluate(() => [...document.querySelectorAll('#panel-individuals button')].some(b => /検体メモ印刷/.test(b.textContent))), '');

  const grab = () => page.evaluate(() => { let out = ''; const orig = window.open; window.open = () => ({ document: { write: h => { out += h; }, close(){} } }); try { indPrintRadMemos(); } finally { window.open = orig; } return out; });

  // ① チェックした個体だけ（T383）
  await page.evaluate(() => { document.querySelectorAll('.ind-chk').forEach(c => c.checked = c.dataset.id === 'TGC-08-T383'); });
  const one = await grab();
  T('チェックした1頭: 10/13・604・T383・鈴木政孝 の4行', /<div class="dt">10\/13<\/div><div class="sn">604<\/div><div class="id">T383<\/div><div class="hn"[^>]*>鈴木政孝<\/div>/.test(one), (one.match(/class="memo"/g) || []).length);

  // ② チェックなし → 捕獲日 2026-10-14 を指定（22頭: T384〜T403の20頭 + T410 + M210）
  await page.evaluate(() => { document.querySelectorAll('.ind-chk').forEach(c => c.checked = false); });
  const day = await grab();
  T('捕獲日指定: 10/14 の22頭だけ（10/13・10/15 は入らない）', (day.match(/class="memo"/g) || []).length === 22 && !/>10\/13</.test(day) && !/>10\/15</.test(day), (day.match(/class="memo"/g) || []).length);
  T('通し番号順に並ぶ（M210=99 が先頭）', day.indexOf('M210') < day.indexOf('T384'), '');
  T('捕獲者なしは「捕獲者未記入」と出る（空欄にしない）', /捕獲者未記入/.test(day), '');

  // ③ 期間指定 10/13〜10/15 → 28頭 = A4 2枚
  promptAns = '2026-10-13〜2026-10-15';
  const range = await grab();
  T('期間指定: 28頭 → A4 2枚（24＋4）', (range.match(/class="memo"/g) || []).length === 28 && (range.match(/class="sheet"/g) || []).length === 2, (range.match(/class="sheet"/g) || []).length);

  // ④ 実寸で描画して測る
  const mp = await ctx.newPage();
  await mp.setContent(range.replace(/<script>[\s\S]*?<\/script>/, ''));
  await mp.emulateMedia({ media: 'print' });
  const m = await mp.evaluate(() => {
    const PX = 96 / 25.4;
    const sh = document.querySelector('.sheet').getBoundingClientRect();
    const memos = [...document.querySelectorAll('.sheet')[0].querySelectorAll('.memo')];
    const rs = memos.map(e => e.getBoundingClientRect());
    // 文字の実際の描画範囲（Range）で測る。flexの中央寄せは上にもはみ出すため上下左右とも見る
    const inkOut = (e, c) => { const r = document.createRange(); r.selectNodeContents(c); const b = r.getBoundingClientRect(), m = e.getBoundingClientRect(); return b.left < m.left - 0.5 || b.right > m.right + 0.5 || b.top < m.top - 0.5 || b.bottom > m.bottom + 0.5; };
    const over = [...document.querySelectorAll('.memo')].filter(e => [...e.children].some(c => inkOut(e, c))).map(e => e.querySelector('.id').textContent);
    const pt = sel => parseFloat(getComputedStyle(document.querySelector(sel)).fontSize) * 72 / 96;
    const minHn = Math.min(...[...document.querySelectorAll('.memo')].map(e => parseFloat(getComputedStyle(e.querySelector('.hn')).fontSize) * 72 / 96));
    // 全シートの文字が用紙の端から何mm離れているか（家庭用プリンタの非印字域 3〜5mm を避ける）
    let edge = 99;
    document.querySelectorAll('.sheet').forEach(shEl => { const S = shEl.getBoundingClientRect(); shEl.querySelectorAll('.memo > div').forEach(c => { const r = document.createRange(); r.selectNodeContents(c); const b = r.getBoundingClientRect(); edge = Math.min(edge, (b.left - S.left) / PX, (S.right - b.right) / PX, (b.top - S.top) / PX, (S.bottom - b.bottom) / PX); }); });
    return { edge, sw: sh.width / PX, shh: sh.height / PX, n: memos.length, w: rs[0].width / PX, h: rs[0].height / PX, lastBottom: (rs[23].bottom - sh.top) / PX, lastRight: (rs[23].right - sh.left) / PX, over, idPt: pt('.id'), hnPt: pt('.hn'), minHn };
  });
  T('用紙はA4（210×297mm）', Math.abs(m.sw - 210) < 0.5 && Math.abs(m.shh - 297) < 0.5, `${m.sw.toFixed(1)}×${m.shh.toFixed(1)}`);
  T('1枚目に24個・各66.7×35.9mm', m.n === 24 && Math.abs(m.w - 200 / 3) < 0.3 && Math.abs(m.h - 35.875) < 0.3, `${m.n} ${m.w.toFixed(2)}×${m.h.toFixed(2)}`);
  T('24個目の枠が右下5mmの余白の内側（205×292mm 以内）', m.lastRight <= 205.3 && m.lastBottom <= 292.3, `${m.lastRight.toFixed(1)},${m.lastBottom.toFixed(1)}`);
  T('文字は用紙の端から5mm以上離れている（プリンタで切れない）', m.edge >= 5, `${m.edge.toFixed(1)}mm`);
  T('どのメモも文字が上下左右にはみ出さない（長い捕獲者名を含む）', m.over.length === 0, m.over.join(','));
  T('文字はできるだけ大きく: 日付・通し番号・個体番号 22pt以上、普通の名前（4字）も22pt以上', m.idPt >= 22 && m.hnPt >= 22, `${m.idPt}pt / ${m.hnPt}pt`);
  T('10字の長い名前でも 16pt 以上は保つ（縮めすぎない）', m.minHn >= 16, `${m.minHn.toFixed(1)}pt`);
  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [nm, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + nm + (got ? '  [' + String(got).slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
