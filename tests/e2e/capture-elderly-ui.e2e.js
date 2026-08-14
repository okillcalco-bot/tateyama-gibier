// 捕獲票入力の高齢者向け改修:
// 白地テーマ / 文字大 / 体重キーパッド / 必須マーク / 処理区分・市役所票用の削除 / 捕獲者→地区の自動入力
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/capture-form.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9076);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(String(e)));
  await p.route('**/rest/v1/**', async route => {
    const url = decodeURIComponent(route.request().url());
    const j = x => route.fulfill({ contentType: 'application/json', body: JSON.stringify(x) });
    if (url.includes('/area_master')) return j([
      { city: '館山市', district: '豊房', oaza: '神余', address_label: '神余' },
      { city: '館山市', district: '館山', oaza: '館山', address_label: '館山' },
    ]);
    return j([]);
  });
  await p.goto('http://localhost:9076/capture-form.html'); await p.waitForTimeout(600);

  // 1) 白地テーマ
  const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ck('白地背景（body=白）', bg === 'rgb(255, 255, 255)', bg);
  const htmlFs = await p.evaluate(() => getComputedStyle(document.documentElement).fontSize);
  ck('基準文字が大きい（html≥18px）', parseFloat(htmlFs) >= 18, htmlFs);

  // 2) 必須マーク
  const reqCount = await p.evaluate(() => document.querySelectorAll('.req-badge').length);
  ck('必須マークが付いている（複数）', reqCount >= 6, String(reqCount));
  const reqLabels = await p.evaluate(() => [...document.querySelectorAll('.form-label')]
    .filter(l => l.querySelector('.req-badge')).map(l => l.textContent.replace('必須', '').trim()));
  ck('体重に必須マーク', reqLabels.some(t => t.includes('体重')), reqLabels.join(','));
  ck('捕獲者名に必須マーク', reqLabels.some(t => t.includes('捕獲者名')));
  ck('種別に必須マーク', reqLabels.some(t => t.includes('種別')));

  // 3) 体重キーパッド（「.」の切替不要）
  const wt = await p.evaluate(() => {
    document.getElementById('weight').value = '';
    ['4', '2', '.', '5'].forEach(k => wtKey(k));
    return document.getElementById('weight').value;
  });
  ck('数字ボタンで 42.5 が入る', wt === '42.5', wt);
  const wtDel = await p.evaluate(() => { wtKey('del'); return document.getElementById('weight').value; });
  ck('⌫で末尾を消せる', wtDel === '42.', wtDel);
  const padKeys = await p.evaluate(() => document.querySelectorAll('.wt-pad .wt-key').length);
  ck('キーパッドのボタンが12個', padKeys === 12, String(padKeys));

  // 4) 削除された項目
  ck('処理区分（分割/背割り）が無い', await p.evaluate(() => !document.querySelector('[data-field="processing_type"]')));
  ck('市役所票用「体長」入力が無い', await p.evaluate(() => !document.getElementById('bodyLength')));
  ck('市役所票用「処理方法」入力が無い', await p.evaluate(() => !document.getElementById('disposalMethod')));
  ck('市役所票用「わな設置日」が無い', await p.evaluate(() => !document.getElementById('trapSetDate')));
  ck('「市役所の調査票も作る」欄が無い', await p.evaluate(() => !document.getElementById('surveyOn')));
  ck('捕獲場所の地図（市役所票用）が無い', await p.evaluate(() => !document.getElementById('capMapWrap')));

  // 5) 捕獲者→地区の自動入力
  const auto = await p.evaluate(() => {
    const el = document.getElementById('hunterName');
    el.value = '加藤茂';
    onHunterPicked();
    return {
      area: document.getElementById('captureArea').value,
      oldTown: document.getElementById('captureOldTown').value,
      city: state.capture_city,
      hint: document.getElementById('hunterAreaHint').textContent,
      hintShown: document.getElementById('hunterAreaHint').style.display !== 'none',
    };
  });
  ck('加藤茂 → 大字「神余」を自動入力', auto.area === '神余', JSON.stringify(auto));
  ck('加藤茂 → 市町村「館山市」', auto.city === '館山市', auto.city);
  ck('加藤茂 → 地区「豊房」を補完', auto.oldTown === '豊房', auto.oldTown);
  ck('「いつもの場所」ヒント表示', auto.hintShown && auto.hint.includes('神余'), auto.hint);

  // 空白ゆらぎ（岩浪 優 / 岩浪優）でも引ける
  const norm = await p.evaluate(() => hunterUsualArea('岩浪 優'));
  ck('氏名の空白ゆらぎでも紐付く（岩浪 優）', !!norm && norm.area === '宮下', JSON.stringify(norm));

  // 既に地区が入っていれば自動上書きしない（別の捕獲者を選んでも尊重）
  const noOverride = await p.evaluate(() => {
    document.getElementById('captureArea').value = '手入力の場所';
    const el = document.getElementById('hunterName'); el.value = '沖浩志'; onHunterPicked();
    return document.getElementById('captureArea').value;
  });
  ck('入力済みの捕獲場所は自動上書きしない', noOverride === '手入力の場所', noOverride);

  ck('JSエラーなし', errs.length === 0, errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
