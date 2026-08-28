// 公開ページ: 出店の一覧QR（?e=）と、混ざっている商品の見せ方
//   ・出店 → 一覧で見られるQR
//   ・小分けパック → 個別QR。ただし「どの一頭か」は言わず、入っている頭を全部出す
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const EVENT = {
  event: { title: '夏の出店', venue: '枇杷倶楽部', date: '2026/08/29', end_date: '2026/08/30' },
  individuals: [
    { label: 'TGC-08-M169', species: 'イノシシ', sex: 'オス', weight_total: 41.1,
      capture_date: '2026/08/13', place: '南房総市 川谷', method: '箱罠',
      radiation_date: '2026/08/21', radiation_result: '検出下限値以下',
      processed_date: '2026/08/27', aging_days: 14, parts: ['唐揚げ用', 'ロース'] },
    { label: 'TGC-08-M168', species: 'イノシシ', sex: 'メス', weight_total: 29.2,
      capture_date: '2026/08/13', place: '南房総市 下堀', method: '箱罠',
      radiation_date: '2026/08/20', radiation_result: '検出下限値以下',
      processed_date: '2026/08/27', aging_days: 14, parts: ['唐揚げ用'] }
  ],
  lots: [
    { name: 'スライス肉（3mm）', qty: 7, members: [
      { label: 'TGC-08-M159', place: '南房総市 白浜町', capture_date: '2026/08/01' },
      { label: 'TGC-08-M160', place: '館山市 神余',     capture_date: '2026/08/02' },
      { label: 'TGC-08-M161', place: '館山市 山本',     capture_date: '2026/08/03' }
    ] },
    { name: 'ジビエカレー', qty: 20, members: [] }
  ]
};

const BLEND = {
  scan_code: '10000795',
  product: { name: 'スライス肉（3mm）', kg: 0.3, ident: 'TGC-SL-20260825-001' },
  individual: null,
  blend: [
    { label: 'TGC-08-M159', species: 'イノシシ', sex: 'オス', capture_date: '2026/08/01', place: '南房総市 白浜町', method: '箱罠', radiation_result: '検出下限値以下' },
    { label: 'TGC-08-M160', species: 'イノシシ', sex: 'メス', capture_date: '2026/08/02', place: '館山市 神余', method: 'くくり罠', radiation_result: '検出下限値以下' }
  ],
  parts: [],
  voices: [{ nickname: '常連', rating: 5, dish: 'しゃぶしゃぶ', comment: 'よかった', at: '2026/08/26' }]
};

const SINGLE = {
  scan_code: '10000702',
  product: { name: '唐揚げ用', kg: 0.83, ident: 'TGC-08-T276-KG' },
  individual: { label: 'TGC-08-T276', species: 'イノシシ', sex: 'メス', weight_total: 26.3,
    capture_date: '2026/08/17', place: '館山市 洲宮', method: 'くくり罠',
    radiation_date: '2026/08/22', radiation_result: '検出下限値以下',
    processed_date: '2026/08/21', aging_days: 4 },
  blend: null, parts: [{ part: '唐揚げ用', kg: 0.83 }], voices: []
};

async function open(query, reply) {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newContext().then(c => c.newPage());
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const calls = [];
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith('file:')) return r.continue();
    const m = u.match(/\/rest\/v1\/rpc\/(\w+)/);
    if (m) {
      let body = {}; try { body = JSON.parse(r.request().postData() || '{}'); } catch (e) {}
      calls.push({ fn: m[1], body });
      const res = reply ? reply(m[1], body) : null;
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res === undefined ? null : res) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
  });
  await page.goto('file://' + path.resolve(__dirname, '../../s.html') + query);
  await page.waitForTimeout(500);
  return { browser, page, errors, calls };
}

(async () => {
  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);
  const EVID = '3f2a1b6c-1111-4222-8333-444455556666';

  // ── 1) 出店の一覧（会場に貼るQRの行き先） ──
  {
    const { browser, page, errors, calls } = await open('?e=' + EVID,
      fn => fn === 'story_get_event' ? EVENT : null);
    T('一覧用のRPCを呼ぶ', calls.some(c => c.fn === 'story_get_event' && c.body.p_event_id === EVID),
      JSON.stringify(calls[0] || {}));
    T('パック用・個体用のRPCは呼ばない',
      !calls.some(c => c.fn === 'story_get' || c.fn === 'story_get_individual'), calls.map(c => c.fn).join(','));
    const txt = await page.$eval('#main', el => el.textContent.replace(/\s+/g, ' '));
    T('見出しが「本日のジビエ」', (await page.$eval('header h1', el => el.textContent)) === '本日のジビエ', '');
    T('会場と日付が出る', /枇杷倶楽部/.test(txt) && /2026\/08\/29/.test(txt) && /2026\/08\/30/.test(txt), txt.slice(0, 70));

    T('一頭ものは頭数つきで出る', /一頭ずつ分かるお肉（2頭）/.test(txt), txt.slice(0, 120));
    const links = await page.$$eval('.lnk', els => els.map(e => e.getAttribute('href')));
    T('個体はタップで詳細へ飛べる',
      links.includes('?i=TGC-08-M169') && links.includes('?i=TGC-08-M168'), links.join(','));
    T('部位も見せる', /唐揚げ用/.test(txt) && /ロース/.test(txt), '');

    T('小分けは別の見出しにする', /小分けパック（2種）/.test(txt), '');
    T('小分けは特定できないと明記する', /どのパックがどの一頭かは特定できません/.test(txt), '');
    T('小分けの個数が出る', /スライス肉（3mm）/.test(txt) && /7個/.test(txt), '');
    T('小分けは入っている頭を出す', /この商品に入っている 3頭/.test(txt), '');
    const lotLinks = await page.$$eval('.chip-a', els => els.map(e => e.getAttribute('href')));
    T('小分けの頭もタップで詳細へ飛べる', lotLinks.includes('?i=TGC-08-M159'), lotLinks.join(','));
    T('原料の記録が無い品はそう書く', /原料の記録は準備中です/.test(txt), '');
    T('小分けを個体カードに混ぜない',
      !links.some(h => /スライス|カレー/.test(h)), links.join(','));
    T('pageerrorなし(1)', errors.length === 0, errors.join(' / '));
    await browser.close();
  }

  // 中身が無い出店
  {
    const { browser, page, errors } = await open('?e=' + EVID,
      fn => fn === 'story_get_event'
        ? { event: { venue: 'テスト', date: '2026/08/29' }, individuals: [], lots: [] } : null);
    T('まだ何も積んでいなければそう書く',
      /まだ登録されていません/.test(await page.$eval('#main', el => el.textContent)), '');
    T('pageerrorなし(2)', errors.length === 0, errors.join(' / '));
    await browser.close();
  }
  {
    const { browser, page, errors } = await open('?e=' + EVID, () => null);
    T('無い出店IDは理由を出す',
      /この出店の一覧が見つかりませんでした/.test(await page.$eval('#main', el => el.textContent)), '');
    T('pageerrorなし(3)', errors.length === 0, errors.join(' / '));
    await browser.close();
  }

  // ── 2) 混ざっている小分けパックの個別QR ──
  {
    const { browser, page, errors } = await open('?c=10000795', fn => fn === 'story_get' ? BLEND : null);
    const txt = await page.$eval('#main', el => el.textContent.replace(/\s+/g, ' '));
    T('商品名と重さは今までどおり', /スライス肉（3mm）/.test(txt) && /0.300 kg/.test(txt), txt.slice(0, 60));
    T('「このお肉になった一頭」を出さない', !/このお肉になった一頭/.test(txt), '');
    T('入っている頭数を出す', /この商品に入っている 2頭/.test(txt), '');
    T('1頭と言わずに特定できないと書く', /このパックがどの一頭かは特定できません/.test(txt), '');
    const links = await page.$$eval('.lnk', els => els.map(e => e.getAttribute('href')));
    T('入っている頭はタップで詳細へ',
      links.includes('?i=TGC-08-M159') && links.includes('?i=TGC-08-M160'), links.join(','));
    T('全頭の検査結果をまとめて出す', /2頭すべて 検出下限値以下/.test(txt), '');
    T('感想の見出しを「この商品」にする', /この商品に感想を残す/.test(txt), '');
    T('寄せられた声も「この商品」にする', /この商品を召し上がった方の声/.test(txt), '');
    T('部位一覧は出さない（混ざると意味が無い）', !/この一頭から採れた部位/.test(txt), '');
    T('pageerrorなし(4)', errors.length === 0, errors.join(' / '));
    await browser.close();
  }

  // ── 3) 1頭だけのパックは今までどおり ──
  {
    const { browser, page, errors } = await open('?c=10000702', fn => fn === 'story_get' ? SINGLE : null);
    const txt = await page.$eval('#main', el => el.textContent.replace(/\s+/g, ' '));
    T('1頭のパックは一頭の記録を出す', /このお肉になった一頭/.test(txt) && /TGC-08-T276/.test(txt), '');
    T('1頭のパックに混在の断りは出さない', !/特定できません/.test(txt), '');
    T('感想の見出しは「この一頭」', /この一頭に感想を残す/.test(txt), '');
    T('部位一覧は出す', /この一頭から採れた部位/.test(txt), '');
    T('pageerrorなし(5)', errors.length === 0, errors.join(' / '));
    await browser.close();
  }

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
