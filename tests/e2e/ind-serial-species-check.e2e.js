// 個体タブ(index.html)の保存前チェック：通し番号の重複は「獣種ごと」に見る。
//   イノシシだけ館山T・南房総Mで共通。別の獣種の同番は止めない・同獣種の同番は止めて続き番号を案内。
//   （capture-form 側の採番＝獣種ごと独立、に検証を合わせた回帰防止）
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9095);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const ctx = await b.newContext({ viewport: { width: 1200, height: 900 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));

  // 疑似的な individuals テーブル
  const DATA = [
    { label_id: 'TGC-08-キ015', serial_number: 15, species: 'キョン',     capture_date: '2026-05-25', hunter_name: '加藤茂' },
    { label_id: 'TGC-08-ア017', serial_number: 17, species: 'アライグマ', capture_date: '2026-08-31', hunter_name: '川口哲雄' },
    { label_id: 'TGC-08-T100', serial_number: 100, species: 'イノシシ',   capture_date: '2026-08-01', hunter_name: '沖浩志' },
    { label_id: 'TGC-08-M050', serial_number: 50,  species: 'イノシシ',   capture_date: '2026-08-02', hunter_name: '沖浩志' },
  ];
  // PostgREST風の簡易フィルタ
  await p.route('**/rest/v1/individuals**', route => {
    const url = route.request().url();
    const params = new URLSearchParams(url.split('?')[1] || '');
    let rows = DATA.slice();
    for (const [k, v] of params) {
      if (k === 'serial_number' && v.startsWith('eq.')) rows = rows.filter(r => String(r.serial_number) === v.slice(3));
      else if (k === 'serial_number' && v === 'not.is.null') rows = rows.filter(r => r.serial_number != null);
      else if (k === 'species' && v.startsWith('eq.')) rows = rows.filter(r => r.species === v.slice(3));
      else if (k === 'label_id' && v.startsWith('eq.')) rows = rows.filter(r => r.label_id === v.slice(3));
      else if (k === 'label_id' && v.startsWith('like.')) { const pat = v.slice(5).replace(/\*/g, ''); rows = rows.filter(r => r.label_id.startsWith(pat)); }
    }
    const order = params.get('order');
    if (order && order.includes('serial_number.desc')) rows.sort((a, b) => (b.serial_number || 0) - (a.serial_number || 0));
    const limit = parseInt(params.get('limit') || '0', 10);
    if (limit) rows = rows.slice(0, limit);
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(rows) });
  });
  await p.route('**/auth/**', route => route.fulfill({ contentType: 'application/json', body: '{}' }));

  await p.goto('http://localhost:9095/index.html'); await p.waitForTimeout(600);

  const R = await p.evaluate(async () => {
    const V = (label, serial, species, editing) => indValidateNumbers(label, serial, editing || null, species);
    return {
      // 別の獣種の同番（キョン15）は アライグマ15 を止めない
      crossOk:      await V('TGC-08-ア015', 15, 'アライグマ'),
      // 同じ獣種の同番（アライグマ17）は止める＋続き番号案内
      sameSpecies:  await V('TGC-08-ア099', 17, 'アライグマ'),
      // イノシシは T と M で通し番号共通：M で T100 の番号は止める
      boarShared:   await V('TGC-08-M099', 100, 'イノシシ'),
      // イノシシの新しい番号は通る
      boarNew:      await V('TGC-08-T101', 101, 'イノシシ'),
      // 自分自身の編集は止めない
      editSelf:     await V('TGC-08-キ015', 15, 'キョン', 'TGC-08-キ015'),
      // 別獣種で同番の新規（ハクビシン15）も通る
      hakubi15:     await V('TGC-08-ハ015', 15, 'ハクビシン'),
    };
  });

  ck('別獣種の同番は止めない（アライグマ15 ← キョン15）', R.crossOk === null, JSON.stringify(R.crossOk));
  ck('同獣種の同番は止める（アライグマ17）', typeof R.sameSpecies === 'string' && R.sameSpecies.includes('17'), R.sameSpecies);
  ck('同獣種の重複時に続き番号(18)を案内', typeof R.sameSpecies === 'string' && R.sameSpecies.includes('18'), R.sameSpecies);
  ck('イノシシはT/M共通で止める（M←T100）', typeof R.boarShared === 'string' && R.boarShared.includes('100'), R.boarShared);
  ck('イノシシ重複時に続き番号(101)を案内', typeof R.boarShared === 'string' && R.boarShared.includes('101'), R.boarShared);
  ck('イノシシの新番号は通る（T101）', R.boarNew === null, JSON.stringify(R.boarNew));
  ck('自分自身の編集は止めない', R.editSelf === null, JSON.stringify(R.editSelf));
  ck('別獣種の同番は通る（ハクビシン15）', R.hakubi15 === null, JSON.stringify(R.hakubi15));

  ck('JSエラーなし', !errs.some(e => /indValidateNumbers/.test(e)), errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
