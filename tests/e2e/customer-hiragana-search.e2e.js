// 出荷先・顧客の予測変換がひらがなでも効く／候補の上限で顧客が抜けない
//
//   きっかけ（2026-09-15）
//     キョンを Oobanburumai に出したが出荷先の候補に無く、手入力したため台帳（炭火ジビエ&ワイン Oobanburumai）と
//     紐付かない注文になった。原因は候補の問い合わせが limit=300 で、名前順301件目以降（有効820件中218件）が
//     出ていなかったこと。あわせて「おおばんぶるまい」のようにひらがなで打っても候補に出るようにする。
//
//   ここで測ること（index.html 直販出荷）
//     1. 顧客の問い合わせに limit=300 が無く、有効な顧客だけ・ふりがな・エイリアス付きで取る
//     2. datalist の候補に「ふりがな／エイリアス／店名のひらがな読み」が label で付く
//     3. ひらがな・別名・一部だけ打って確定しても、台帳の正式名に置き換わる（複数に当たるときは変えない）
//   （order-admin.html）
//     4. 顧客台帳の検索・手入力注文・請求書の顧客欄がひらがなでカタカナ名／エイリアスに当たる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const CUSTOMERS = [
  { id: 'c1', code: 'C0611', name: '炭火ジビエ&ワイン Oobanburumai', kana: null, address: '千葉県浦安市北栄3-28-28', is_active: true, search_aliases: ['オオバンブルマイ', 'おおばんぶるまい', 'Oobanbrumai'] },
  { id: 'c2', code: 'C0100', name: 'ビストロムジカ', kana: null, address: '千葉県館山市北条1', is_active: true, search_aliases: null },
  { id: 'c3', code: 'C0101', name: '山海亭', kana: 'さんかいてい', address: '千葉県館山市2', is_active: true, search_aliases: [] },
  { id: 'c4', code: 'C0102', name: '山海亭 本店', kana: 'さんかいてい ほんてん', address: '千葉県館山市3', is_active: true, search_aliases: [] },
  { id: 'c5', code: 'C0900', name: '休眠のお店', kana: 'きゅうみん', address: '', is_active: false, search_aliases: [] },
];

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); localStorage.setItem('tg_staff_key', 'TESTKEY'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const custReqs = [];
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/rest\/v1\/customers/.test(u)) {
      const qs = decodeURIComponent(u.split('?')[1] || '');
      custReqs.push(qs);
      return J(/is_active=not\.is\.false/.test(qs) ? CUSTOMERS.filter(c => c.is_active !== false) : CUSTOMERS);
    }
    return J([]);
  });

  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  // ── index.html 直販出荷 ──
  await page.goto('file://' + path.resolve(__dirname, '../../index.html') + '?tab=shipping');
  await page.waitForTimeout(900);
  const q = custReqs.find(s => /select=name/.test(s)) || '';
  T('顧客の問い合わせに limit=300 が無く、有効顧客のみ・kana・search_aliases 付き', !/limit=300\b/.test(q) && /is_active=not\.is\.false/.test(q) && /kana/.test(q) && /search_aliases/.test(q), q);
  const opts = await page.$$eval('#shipCustDatalist option', els => els.map(o => ({ v: o.value, l: o.getAttribute('label') || '' })));
  T('候補は有効な顧客4件（休眠は出ない）', opts.length === 4 && !opts.some(o => /休眠/.test(o.v)), JSON.stringify(opts.map(o => o.v)));
  const ob = opts.find(o => /Oobanburumai/.test(o.v));
  T('Oobanburumai の label にエイリアス（ひらがな・カタカナ）が付く', ob && /おおばんぶるまい/.test(ob.l) && /オオバンブルマイ/.test(ob.l) && /Oobanbrumai/.test(ob.l), ob && ob.l);
  const mj = opts.find(o => o.v === 'ビストロムジカ');
  T('カタカナの店名はひらがな読みが label に付く', mj && /びすとろむじか/.test(mj.l), mj && mj.l);
  const sk = opts.find(o => o.v === '山海亭');
  T('ふりがな（kana）はひらがな・カタカナ両方が label に付く', sk && /さんかいてい/.test(sk.l) && /サンカイテイ/.test(sk.l), sk && sk.l);

  const typeAndChange = async v => { await page.fill('#ship-direct-cust', v); await page.dispatchEvent('#ship-direct-cust', 'change'); await page.waitForTimeout(150); return page.$eval('#ship-direct-cust', el => el.value); };
  T('「おおばんぶるまい」で確定 → 台帳の正式名に置き換わる', (await typeAndChange('おおばんぶるまい')) === '炭火ジビエ&ワイン Oobanburumai', '');
  T('「Oobanbrumai」（別綴り）でも置き換わる', (await typeAndChange('Oobanbrumai')) === '炭火ジビエ&ワイン Oobanburumai', '');
  T('「びすとろむじか」（ひらがな）でカタカナの店名に置き換わる', (await typeAndChange('びすとろむじか')) === 'ビストロムジカ', '');
  T('一部だけ（おおばん）で1件に絞れれば置き換わる', (await typeAndChange('おおばん')) === '炭火ジビエ&ワイン Oobanburumai', '');
  T('複数に当たる（さんかい）ときは勝手に決めない', (await typeAndChange('さんかい')) === 'さんかい', '');
  T('正式名そのままは変えない', (await typeAndChange('山海亭 本店')) === '山海亭 本店', '');
  T('置き換えたことが画面に出る', /台帳の「/.test(await page.$eval('body', el => el.textContent)), '');

  // ── order-admin.html ──
  const p2 = await ctx.newPage();
  const errors2 = []; p2.on('pageerror', e => errors2.push(e.message));
  await p2.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (/\/rest\/v1\/customers/.test(u)) return J(CUSTOMERS);
    return J([]);
  });
  await p2.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
  await p2.waitForTimeout(900);
  const m = await p2.evaluate(() => ({
    hira: custMatches({ name: 'ビストロムジカ', kana: null, code: 'C0100', search_aliases: null }, 'びすとろ'),
    kataForKana: custMatches({ name: '山海亭', kana: 'さんかいてい', code: 'C0101' }, 'サンカイ'),
    alias: custMatches({ name: '炭火ジビエ&ワイン Oobanburumai', code: 'C0611', search_aliases: ['オオバンブルマイ'] }, 'おおばんぶるまい'),
    zenkaku: custMatches({ name: 'Oobanburumai', code: 'C0611' }, 'Ｏｏｂａｎ'),
    none: custMatches({ name: '山海亭', kana: 'さんかいてい', code: 'C0101' }, 'むじか'),
    label: custReadingLabel({ name: 'ビストロムジカ', kana: null, search_aliases: ['むじか'] }),
  }));
  T('order-admin: ひらがな→カタカナ名／カタカナ→ふりがな／ひらがな→エイリアス／全角英字 が当たる', m.hira && m.kataForKana && m.alias && m.zenkaku && !m.none, JSON.stringify(m));
  T('order-admin: datalist の読み label に店名のひらがな読みとエイリアスが入る', /びすとろむじか/.test(m.label) && /むじか/.test(m.label), m.label);
  // 手入力注文の顧客欄（存在すれば）
  const mo = await p2.evaluate(() => {
    const inp = document.getElementById('moCustomerInput'); if (!inp) return 'skip';
    inp.value = 'おおばんぶるまい'; onMoCustomerInput();
    return document.getElementById('moCustomer').value;
  });
  T('order-admin 手入力注文: 「おおばんぶるまい」で C0611 に確定', mo === 'skip' || mo === 'c1', mo);

  T('pageerrorなし', errors.length === 0 && errors2.length === 0, errors.concat(errors2).join(' / '));
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
