// 精肉完了時の肉ランク既定：イノシシで未選択なら「並」、他獣種は付けない。
//   ・defaultMeatRank(): 純粋関数（イノシシのみ・上/極上は保持・未選択→並・非イノシシ→null）
//   ・procMarkDone(): 完了PATCHの後、イノシシ×肉ランク空欄に絞って並を入れる
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
(async () => {
  const root = '/home/user/tateyama-gibier';
  const srv = http.createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
    r.setHeader('content-type', 'text/html; charset=utf-8');
    try { r.end(fs.readFileSync(path.join(root, p))); } catch (e) { r.statusCode = 404; r.end('nf'); }
  }).listen(9096);
  const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' }).catch(() => chromium.launch());
  const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));
  const ctx = await b.newContext({ viewport: { width: 1200, height: 900 } });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(String(e)));
  p.on('dialog', d => d.accept());   // confirm を自動でOK

  const patches = [];
  await p.route('**/rest/v1/**', route => {
    const req = route.request();
    if (req.method() === 'PATCH') { patches.push({ url: decodeURIComponent(req.url()), body: JSON.parse(req.postData() || '{}') }); }
    route.fulfill({ contentType: 'application/json', body: '[]' });
  });
  await p.route('**/auth/**', route => route.fulfill({ contentType: 'application/json', body: '{}' }));

  await p.goto('http://localhost:9096/index.html'); await p.waitForTimeout(600);

  // ① 純粋関数 defaultMeatRank
  const dm = await p.evaluate(() => ({
    boarNull:   defaultMeatRank('イノシシ', 'TGC-08-T100', null),
    boarBlank:  defaultMeatRank('イノシシ', 'TGC-08-M050', ''),
    boarUe:     defaultMeatRank('イノシシ', 'TGC-08-T100', '上'),
    boarGoku:   defaultMeatRank('イノシシ', 'TGC-08-M050', '極上'),
    sika:       defaultMeatRank('シカ', 'TGC-08-シ014', null),
    kyon:       defaultMeatRank('キョン', 'TGC-08-キ055', '並'),   // 非イノシシは選んでも付けない
    byLabelT:   defaultMeatRank(undefined, 'TGC-08-T077', null),   // speciesが無くてもラベルで判定
    byLabelKa:  defaultMeatRank(undefined, 'TGC-08-ア017', null),
  }));
  ck('イノシシ未選択→並', dm.boarNull === '並', String(dm.boarNull));
  ck('イノシシ空文字→並', dm.boarBlank === '並', String(dm.boarBlank));
  ck('イノシシ上→上を保持', dm.boarUe === '上', String(dm.boarUe));
  ck('イノシシ極上→極上を保持', dm.boarGoku === '極上', String(dm.boarGoku));
  ck('シカ→肉ランクなし(null)', dm.sika === null, String(dm.sika));
  ck('キョンは並を選んでも付けない(null)', dm.kyon === null, String(dm.kyon));
  ck('species無しでもT記号はイノシシ扱い→並', dm.byLabelT === '並', String(dm.byLabelT));
  ck('species無しでア記号は非イノシシ→null', dm.byLabelKa === null, String(dm.byLabelKa));

  // ② procMarkDone（イノシシ）→ 完了PATCH＋並PATCH（イノシシ×空欄に絞る）
  patches.length = 0;
  await p.evaluate(async () => { await procMarkDone('TGC-08-T100'); });
  await p.waitForTimeout(300);
  const donePatch = patches.find(x => 'processing_done_at' in x.body);
  const rankPatch = patches.find(x => x.body.meat_rank === '並');
  ck('完了PATCHが飛ぶ(processing_done_at)', !!donePatch, JSON.stringify(patches.map(x=>Object.keys(x.body))));
  ck('肉ランク並のPATCHが飛ぶ', !!rankPatch, JSON.stringify(patches.map(x=>x.body)));
  ck('並PATCHはイノシシに限定', !!rankPatch && /species=eq\.イノシシ/.test(rankPatch.url), rankPatch ? rankPatch.url : '');
  ck('並PATCHは肉ランク空欄に限定', !!rankPatch && /meat_rank=is\.null/.test(rankPatch.url), rankPatch ? rankPatch.url : '');
  ck('並PATCHは対象個体に限定', !!rankPatch && /label_id=eq\.TGC-08-T100/.test(rankPatch.url), rankPatch ? rankPatch.url : '');

  ck('JSエラーなし', !errs.some(e => /defaultMeatRank|procDefaultBoarRank|procMarkDone/.test(e)), errs.join(' / '));
  console.log(out.join('\n'));
  await b.close(); srv.close();
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})();
