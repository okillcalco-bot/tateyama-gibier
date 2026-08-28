// 「この肉の物語」を個体番号でも開けること（出店シートのQRの行き先）
//   ・?c=8桁（パックのラベル）… 従来どおり
//   ・?i=個体番号（出店シート）… パックではなく一頭を見出しにする
//   感想の投稿先も、開き方によって正しく切り替わること。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const IND = {
  individual_label: 'TGC-08-T276',
  product: null,
  individual: {
    label: 'TGC-08-T276', species: 'イノシシ', sex: 'メス', weight_total: 26.3,
    capture_date: '2026/08/17', place: '館山市 洲宮', method: 'くくり罠', is_juvenile: false,
    radiation_date: '2026/08/22', radiation_result: '検出下限値以下',
    processed_date: '2026/08/21', aging_days: 4
  },
  parts: [{ part: '唐揚げ用', kg: 0.83 }, { part: 'ロース', kg: 1.2 }],
  voices: [{ nickname: '館山の田中', rating: 5, dish: 'ぼたん鍋', comment: 'やわらかかった', at: '2026/08/25' }]
};
const PACK = {
  scan_code: '10000702',
  product: { name: '唐揚げ用', kg: 0.83, ident: 'TGC-08-T276-KG' },
  individual: IND.individual, parts: IND.parts, voices: []
};

async function open(query, opts) {
  const o = opts || {};
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
      const res = o.reply ? o.reply(m[1], body) : undefined;
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

  // ── 1) 個体番号で開く ──
  {
    const { browser, page, errors, calls } = await open('?i=TGC-08-T276', {
      reply: fn => fn === 'story_get_individual' ? IND : null
    });
    T('個体用のRPCを呼ぶ', calls.some(c => c.fn === 'story_get_individual' && c.body.p_label === 'TGC-08-T276'),
      JSON.stringify(calls[0] || {}));
    T('パック用のRPCは呼ばない', !calls.some(c => c.fn === 'story_get'), '');
    const txt = await page.$eval('#main', el => el.textContent);
    T('獲れた場所を見出しにする', /館山市 洲宮 の一頭/.test(txt), txt.slice(0, 40));
    T('個体番号が出る', txt.includes('TGC-08-T276'), '');
    T('種別と体重が出る', /イノシシ（メス） 26.3 kg/.test(txt), '');
    T('パックの重さは見出しにしない', !/0\.830 kg/.test(await page.$eval('.prod', el => el.textContent)), '');
    T('精肉した日とねかせた日数が出る', /精肉した日/.test(txt) && /2026\/08\/21/.test(txt) && /4日ねかせて/.test(txt), '');
    T('放射能検査の結果が出る', /検出下限値以下/.test(txt), '');
    T('採れた部位が出る', /唐揚げ用/.test(txt) && /ロース/.test(txt), '');
    T('公開済みの感想が出る', /館山の田中/.test(txt) && /やわらかかった/.test(txt), '');
    T('説明文が一頭向けになる', /この一頭が、どこで生まれてどう届いたか/.test(await page.$eval('header .sub', el => el.textContent)), '');
    T('pageerrorなし(1)', errors.length === 0, errors.join(' / '));
    await browser.close();
  }

  // ── 2) 個体番号のまま感想を送る ──
  {
    const { browser, page, errors, calls } = await open('?i=TGC-08-T276', {
      reply: (fn) => fn === 'story_get_individual' ? IND
        : fn === 'story_add_voice_individual' ? { ok: true } : null
    });
    await page.click('#stars button[data-n="4"]');
    await page.fill('#comment', 'とても美味しかった');
    await page.fill('#nickname', 'テスト');
    await page.click('#send');
    await page.waitForTimeout(400);
    const post = calls.find(c => c.fn === 'story_add_voice_individual');
    T('個体あての投稿RPCを呼ぶ', !!post, calls.map(c => c.fn).join(','));
    T('個体番号を渡す', post && post.body.p_label === 'TGC-08-T276', post && post.body.p_label);
    T('星と感想を渡す', post && post.body.p_rating === 4 && post.body.p_comment === 'とても美味しかった', '');
    T('パック用の投稿RPCは呼ばない', !calls.some(c => c.fn === 'story_add_voice'), '');
    T('承認してから載ることを伝える', /センターで確認のうえ掲載します/.test(await page.$eval('#msg', el => el.textContent)),
      await page.$eval('#msg', el => el.textContent));
    T('pageerrorなし(2)', errors.length === 0, errors.join(' / '));
    await browser.close();
  }

  // ── 3) 従来のパック経路が壊れていない ──
  {
    const { browser, page, errors, calls } = await open('?c=10000702', {
      reply: fn => fn === 'story_get' ? PACK : null
    });
    T('パック用のRPCを呼ぶ', calls.some(c => c.fn === 'story_get' && c.body.p_code === '10000702'), '');
    T('個体用のRPCは呼ばない', !calls.some(c => c.fn === 'story_get_individual'), '');
    const prod = await page.$eval('.prod', el => el.textContent);
    T('商品名と重さを見出しにする', /唐揚げ用/.test(prod) && /0\.830 kg/.test(prod), prod.replace(/\s+/g, ' ').trim());
    T('識別コードが出る', /TGC-08-T276-KG/.test(prod), '');
    T('パックでも精肉日が出る', /4日ねかせて/.test(await page.$eval('#main', el => el.textContent)), '');
    T('pageerrorなし(3)', errors.length === 0, errors.join(' / '));
    await browser.close();
  }

  // ── 4) 見つからないとき・引数が無いとき ──
  {
    const { browser, page, errors } = await open('?i=TGC-08-ZZZZ', { reply: () => null });
    T('無い個体番号は理由を出す', /この個体番号が見つかりませんでした/.test(await page.$eval('#main', el => el.textContent)),
      await page.$eval('#main', el => el.textContent));
    T('pageerrorなし(4)', errors.length === 0, errors.join(' / '));
    await browser.close();
  }
  {
    const { browser, page, errors, calls } = await open('', { reply: () => null });
    T('引数が無ければ案内だけ出す', /QRコードから開いてください/.test(await page.$eval('#main', el => el.textContent)), '');
    T('引数が無ければ問い合わせない', calls.length === 0, calls.map(c => c.fn).join(','));
    T('pageerrorなし(5)', errors.length === 0, errors.join(' / '));
    await browser.close();
  }

  // ── 5) 変な文字を混ぜても壊さない ──
  {
    const { browser, page, errors, calls } = await open("?i=TGC-08-%E3%82%B7010'%22%3Cscript%3E", {
      reply: () => null
    });
    const sent = (calls[0] || {}).body || {};
    T('全角の個体番号は残す', String(sent.p_label).startsWith('TGC-08-シ010'), sent.p_label);
    T('記号は落とす', !/['"<>]/.test(String(sent.p_label)), sent.p_label);
    T('pageerrorなし(6)', errors.length === 0, errors.join(' / '));
    await browser.close();
  }

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
