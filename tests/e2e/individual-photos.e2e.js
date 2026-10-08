// 個体の写真を見る（2026-10-08「個体写真のうち、サーバーに入ってるのってどうやって見られる？」）
//
//   capture-photos バケットに79枚（9/16〜）あるのに、個体一覧・「🌿 一生」に写真を出す場所が無かった。
//
//   ここで測ること
//     1. 写真のある個体だけ、一覧の個体番号の横に 📷 が出る
//     2. 「🌿 一生」の いのち 欄に写真が並ぶ（URLはそのまま／パスは capture-photos の公開URLにする／JSON配列も読む）
//     3. 写真をタップすると原寸を新しいタブで開くリンク。写真が無い個体は「写真はありません」
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); sessionStorage.setItem('tg_role_v1', 'admin'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const IMG = 'https://clpdyrehdgzgiidbfucj.supabase.co/storage/v1/object/public/capture-photos/TGC-08-_067/ar-board-1.jpg';
  const INDS = [
    { label_id: 'TGC-08-キ067', species: 'キョン', capture_date: '2026-10-01', image_url: IMG, deleted_at: null },
    { label_id: 'TGC-08-T370', species: 'イノシシ', capture_date: '2026-10-07', image_url: null, photo_tail_before: 'TGC-08-T370/tail-before.jpg', photo_extra: '["TGC-08-T370/a.jpg","TGC-08-T370/b.jpg"]', deleted_at: null },
    { label_id: 'TGC-08-T369', species: 'イノシシ', capture_date: '2026-10-07', image_url: null, deleted_at: null },
  ];
  await page.route('**/*', r => {
    const u = r.request().url();
    if (/\.jpg/.test(u)) return r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"/>' });
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    const qs = decodeURIComponent(u.split('?')[1] || '');
    if (/\/rest\/v1\/individuals/.test(u)) { const m = /label_id=eq\.([^&]+)/.exec(qs); return J(m ? INDS.filter(i => i.label_id === m[1]) : INDS); }
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(600);
  await page.evaluate(() => { const b = document.querySelector('[data-tab="individuals"]'); if (b) b.click(); });
  await page.waitForTimeout(400);
  await page.evaluate(() => (typeof loadIndividuals === 'function') && loadIndividuals());
  await page.waitForTimeout(600);
  const results = []; const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  const marks = await page.evaluate(() => [...document.querySelectorAll('.ind-photo-mark')].map(m => m.closest('td').textContent.trim()));
  T('写真のある2頭だけ 📷（キ067・T370）', marks.length === 2 && marks.some(t => /キ067/.test(t)) && marks.some(t => /T370/.test(t)), JSON.stringify(marks));

  await page.evaluate(() => indLifeOpen('TGC-08-キ067'));
  await page.waitForTimeout(500);
  const a = await page.evaluate(() => [...document.querySelectorAll('#ind-life-body .ind-photos a')].map(x => ({ href: x.href, img: x.querySelector('img').src, t: x.textContent.trim(), tgt: x.target })));
  T('キ067: 立ち会い写真がURLのまま出て、新しいタブで原寸', a.length === 1 && a[0].img.endsWith('TGC-08-_067/ar-board-1.jpg') && a[0].href === a[0].img && a[0].tgt === '_blank' && a[0].t === '立ち会い写真', JSON.stringify(a));

  await page.evaluate(() => indLifeOpen('TGC-08-T370'));
  await page.waitForTimeout(500);
  const b = await page.evaluate(() => [...document.querySelectorAll('#ind-life-body .ind-photos a')].map(x => [x.querySelector('img').src.replace(/^.*capture-photos\//, ''), x.textContent.trim()]));
  T('T370: パスは capture-photos の公開URLに、JSON配列も読む（3枚）', JSON.stringify(b) === JSON.stringify([['TGC-08-T370/tail-before.jpg', '尻尾（切る前）'], ['TGC-08-T370/a.jpg', 'その他'], ['TGC-08-T370/b.jpg', 'その他']]), JSON.stringify(b));
  const loaded = await page.evaluate(() => [...document.querySelectorAll('#ind-life-body .ind-photos img')].every(i => i.complete && i.naturalWidth > 0));
  T('画像が読み込まれる', loaded, '');

  await page.evaluate(() => indLifeOpen('TGC-08-T369'));
  await page.waitForTimeout(500);
  const none = await page.evaluate(() => document.getElementById('ind-life-body').textContent);
  T('写真が無い個体は「写真はありません」', /写真はありません/.test(none), '');

  // ダウンロード（市役所提出用）: ファイル名は 個体番号_種類(_連番)
  // file:// では Playwright の suggestedFilename が 'download' になるので、a.download の値を記録して測る
  await page.evaluate(() => { window.__dl = []; const c = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) window.__dl.push(this.download); return c.call(this); }; });
  const names = await page.evaluate(() => indPhotoFiles(indCache.get('TGC-08-T370')).map(f => f.name));
  T('ファイル名: 個体番号_種類（同じ種類は連番）', JSON.stringify(names) === JSON.stringify(['TGC-08-T370_尻尾切る前.jpg', 'TGC-08-T370_その他_1.jpg', 'TGC-08-T370_その他_2.jpg']), JSON.stringify(names));
  const dlBtns = await page.evaluate(() => { indLifeOpen('TGC-08-T370'); return new Promise(r => setTimeout(() => r([...document.querySelectorAll('#ind-life-body button')].map(b => b.textContent.trim()).filter(t => /⬇/.test(t))), 400)); });
  T('一生に1枚ずつの ⬇ と「まとめてZIP」', dlBtns.length === 4 && dlBtns.includes('⬇ まとめてZIP'), JSON.stringify(dlBtns));
  const [d1] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => indPhotoDownload('TGC-08-キ067', 0))]);
  const n1 = await page.evaluate(() => window.__dl.slice(-1)[0]);
  T('1枚ダウンロード: TGC-08-キ067_立ち会い写真.jpg', n1 === 'TGC-08-キ067_立ち会い写真.jpg' && !!d1, n1);
  // 月で絞ってZIP（チェックなし）
  await page.evaluate(() => { document.getElementById('ind-photo-month').value = '2026-10'; window.confirm = () => true; });
  const [dz] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => indPhotosZip())]);
  const zp = await dz.path(); const buf = require('fs').readFileSync(zp);
  const zipNames = []; for (let o = 0; o + 4 < buf.length; o++) { if (buf.readUInt32LE(o) === 0x02014b50) { const nl = buf.readUInt16LE(o + 28); zipNames.push(buf.slice(o + 46, o + 46 + nl).toString('utf8')); } }
  const nz = await page.evaluate(() => window.__dl.slice(-1)[0]);
  T('月（2026-10）でZIP: 2頭4枚・名前は個体番号から', nz === '個体写真_2026-10_4枚.zip' && zipNames.length === 4 && zipNames.includes('TGC-08-キ067_立ち会い写真.jpg'), nz + ' ' + JSON.stringify(zipNames));
  // チェックした個体が優先
  await page.evaluate(() => { document.querySelectorAll('.ind-chk').forEach(c => { c.checked = c.dataset.id === 'TGC-08-キ067'; }); });
  const [dz2] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => indPhotosZip())]);
  const nz2 = await page.evaluate(() => window.__dl.slice(-1)[0]);
  T('チェックした個体だけ（1枚）', /_1枚\.zip$/.test(nz2) && !!dz2, nz2);

  T('pageerrorなし', errors.length === 0, errors.join(' / '));
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
