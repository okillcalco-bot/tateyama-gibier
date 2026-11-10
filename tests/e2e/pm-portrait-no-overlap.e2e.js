// 精肉モード: 縦持ち（タブレット縦・スマホ）で部位ボタンと計量パネルが重ならない・右にはみ出さない
// （2026-11-10 全画面の見直し）
//
//   きっかけ（全画面を スマホ390・タブレット820・PC1366 の幅で測った）
//     ・縦持ちでは1列に並べるが、横持ち用の行の高さ（grid-template-rows:minmax(0,1fr)）が1行目に残っていて、
//       部位ボタンの列が潰れ、下の計量パネル（重さ・「登録」・「ラベル印刷」）の上に重なっていた。
//       実測 820×844: 部位ボタン28個が計量パネルに重なる。「登録」の真ん中を押すと部位ボタンに当たる
//     ・スマホ幅（390）では「骨をまとめる」「内臓をまとめる」が画面の右へ切れて押せなかった。
//       冷凍庫の名前が長いと、選択欄の幅で列ごと画面より広がっていた
//     ・押す場所が小さい: 登録済みチップの 🖨 / ✕ が 20×14・21×16 px
//
//   ここで測ること（個体・部位は架空）
//     1. 縦持ちで、部位ボタンが計量パネル・登録済み一覧に重ならない。「登録」を押すと「登録」に当たる
//     2. 精肉モードの中身が画面の右へはみ出さない（冷凍庫の名前が長くても）
//     3. 指で押す端末では、登録済みチップの 🖨 / ✕ が 36px 以上
//     4. 横持ち（1180×620）は今までどおり2列で、右の列は内側で送れる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium' });
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);
  const PARTS = ['モモ', 'ロース', 'バラ', 'ヒレ', 'カタ', '肩ロース', 'スネ', 'ネック', 'ミンチ用', '味肉用'];

  for (const [w, h, label] of [[820, 1180, 'タブレット縦'], [820, 844, 'タブレット縦（低い）'], [768, 1024, 'タブレット縦（小）'], [390, 844, 'スマホ'], [1180, 620, '横持ち']]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true });
    await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', rt => { const u = rt.request().url(); if (u.startsWith('file:')) return rt.continue(); if (/\/rest\/v1\//.test(u)) return rt.fulfill({ contentType: 'application/json', body: '[]' }); return rt.fulfill({ status: 200, contentType: 'text/plain', body: '' }); });
    await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
    await page.waitForTimeout(500);
    await page.evaluate((PARTS) => {
      pmIndividual = { label_id: 'TGC-08-T900', species: 'イノシシ', weight_total: 40 };
      pmRetail = false; pmSelectedPart = null;
      pmCompletedParts = Array.from({ length: 12 }, (_, i) => ({ part_name: PARTS[i % PARTS.length], weight_kg: Math.round((0.3 + i * 0.05) * 100) / 100, lot_code: 'L' + i, ident_code: 'TGC-08-T900-' + i, grade: '並', bone_in: false }));
      document.getElementById('pmOverlay').classList.add('active');
      document.getElementById('pmSetup').style.display = 'none';
      document.getElementById('pmMain').style.display = 'flex';
      // 冷凍庫の名前が長いとき（選択欄が列の幅を押し広げていた）
      const sel = document.getElementById('pmLocationSel');
      ['F1 架空の冷凍庫（とても長い名前のテスト用・奥の棚の上から三段目の右側）', 'F2 架空'].forEach(n => { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); });
      pmRenderParts(); pmRenderCompleted();
    }, PARTS);
    await page.waitForTimeout(250);

    const m = await page.evaluate(() => {
      const vw = innerWidth; const body = document.querySelector('.pm-body');
      const rect = e => e.getBoundingClientRect();
      const ov = (a, b) => { const x = Math.min(a.right, b.right) - Math.max(a.left, b.left), y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top); return x > 2 && y > 2; };
      const parts = [...document.querySelectorAll('#pmPartsGrid .part-btn')];
      const weight = document.querySelector('.pm-weight-section'), done = document.querySelector('.pm-completed-section');
      const wr = rect(weight), dr = rect(done);
      const overlapW = parts.filter(p => ov(rect(p), wr)).length, overlapD = parts.filter(p => ov(rect(p), dr)).length;
      // 「登録」を画面の中へ送って、真ん中を押したら何に当たるか
      const reg = [...weight.querySelectorAll('button')].find(b => /^\s*登録\s*$/.test(b.textContent)) || weight.querySelector('button');
      reg.scrollIntoView({ block: 'center' });
      const rr = rect(reg); const hit = document.elementFromPoint(rr.left + rr.width / 2, rr.top + rr.height / 2);
      body.scrollTop = 0;
      const inside = [...document.querySelectorAll('#pmMain *')].filter(e => { const r = rect(e); return r.width > 0 && r.height > 0 && r.right > vw + 1; }).map(e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + ' →' + Math.round(rect(e).right - vw));
      const toggles = ['pmBoneBtn', 'pmRetailBtn', 'pmBoneLotBtn', 'pmOrganLotBtn'].map(id => { const r = rect(document.getElementById(id)); return r.left >= 0 && r.right <= vw && r.width > 30; });
      const chipBtns = [...document.querySelectorAll('.pm-completed-chip button')].map(b => { const r = rect(b); return Math.round(Math.min(r.width, r.height)); });
      const cols = getComputedStyle(body).gridTemplateColumns.split(' ').length;
      const right = document.querySelector('.pm-right');
      return { parts: parts.length, overlapW, overlapD, hitOk: !!hit && (hit === reg || reg.contains(hit)), hit: hit ? hit.tagName + '.' + hit.className : 'null', regText: reg.textContent.trim(),
        inside, toggles, chipMin: chipBtns.length ? Math.min(...chipBtns) : -1, chipN: chipBtns.length, cols, bodyScroll: body.scrollHeight > body.clientHeight + 2, rightOverflowY: getComputedStyle(right).overflowY,
        sel: Math.round(rect(document.getElementById('pmLocationSel')).right), coarse: matchMedia('(pointer:coarse)').matches };
    });
    const pfx = `${label} ${w}×${h}: `;
    if (label !== '横持ち') {
      T(pfx + '1列に並ぶ', m.cols === 1, m.cols);
      T(pfx + '1. 部位ボタンが計量パネルに重ならない', m.parts > 10 && m.overlapW === 0, `${m.overlapW}/${m.parts}個が重なる`);
      T(pfx + '1. 部位ボタンが登録済み一覧に重ならない', m.overlapD === 0, `${m.overlapD}/${m.parts}個が重なる`);
      T(pfx + '1. 「登録」の真ん中を押すと「登録」に当たる', m.hitOk && m.regText === '登録', m.hit);
      T(pfx + '1. 全体を縦に送れる（中身が切れない）', m.bodyScroll || h >= 1100, m.bodyScroll);
    } else {
      T(pfx + '4. 今までどおり2列', m.cols === 2, m.cols);
      T(pfx + '4. 右の列は内側で送れる（overflow-y:auto）', m.rightOverflowY === 'auto', m.rightOverflowY);
      T(pfx + '4. 「登録」の真ん中を押すと「登録」に当たる', m.hitOk, m.hit);
    }
    T(pfx + '2. 精肉モードの中身が右へはみ出さない', m.inside.length === 0, m.inside.slice(0, 4).join(' ; '));
    T(pfx + '2. 骨付き・小売・骨をまとめる・内臓をまとめる が4つとも画面の中', m.toggles.every(Boolean), JSON.stringify(m.toggles));
    T(pfx + '2. 冷凍庫の選択欄は名前が長くても画面の中', m.sel <= w, m.sel);
    T(pfx + '3. 登録済みチップの 🖨 / ✕ は 36px 以上（指で押す端末）', m.coarse && m.chipN >= 12 && m.chipMin >= 36, `最小${m.chipMin}px / ${m.chipN}個 / coarse=${m.coarse}`);
    T(pfx + 'ページエラーなし', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
