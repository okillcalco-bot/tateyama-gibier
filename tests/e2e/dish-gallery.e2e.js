// ジビエ料理ギャラリー（2026-10-05）: 公開ページ dishes.html・お店の投稿（order.html「🍽 料理」）・センターの公開（order-admin.html）
//
//   線の最後の区間（料理になった姿）をつなぐ機能。ここで測ること:
//   公開ページ
//     1. 公開済みの料理がカードで出る（料理名・お店・地域・説明・使った個体の 捕獲月/市/方法）
//     2. 捕獲者名・電話・緯度経度など、渡していない項目は出ない（そもそもRPCが返さない前提で、画面が勝手に足さない）
//     3. 料理名に仕込んだHTMLは文字として出る（XSSしない）。javascript: のURLはリンクにしない
//     4. 獣種で絞り込める。0件なら「準備中」、読み込み失敗は画面に出す（無言で空にしない）
//     5. スマホ幅（390px）で横にはみ出さない
//   お店の投稿
//     6. 紹介を保存するまで投稿欄は出ない。同意なしでは保存も投稿もしない（RPCを呼ばない）
//     7. 写真は縮めてJPEGで p/<uuid>.jpg にアップロード → その path と選んだ個体で portal_dish_post を呼ぶ
//     8. アップロードに失敗したら投稿RPCを呼ばず、理由を画面に出す
//     9. 取り下げボタンで portal_dish_withdraw を呼ぶ
//   センター
//    10. 料理ギャラリータブは staff_dish_list をスタッフキー付きで読み、「公開する」で staff_dish_set_status を呼ぶ
//    11. 注文ページの案内文（LINE・メール・カード・発行直後のコピー）にギャラリーのURLが入る
const pw = (() => { try { return require('/opt/node22/lib/node_modules/playwright'); } catch (e) { return require('playwright'); } })();
const path = require('path');
const CHROME = process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAYAAAC09K7GAAAAFklEQVR42mP8z8Dwn4GBgYmBgYGBAQAk6gJ5Vb7m7wAAAABJRU5ErkJggg==', 'base64');

const GALLERY = [
  { id: 'g1', dish_name: '猪肩ロースのロースト<img src=x onerror="window.__xss=1">', description: '低温でじっくり', photo_path: 'p/11111111-1111-1111-1111-111111111111.jpg', published_at: '2026-10-05T01:00:00Z',
    shop: { name: 'ビストロ館山', description: '館山の猪を季節のソースで', area: '東京都江東区', url: 'javascript:alert(1)', instagram: '@bistro.tateyama' },
    individuals: [{ label_id: 'TGC-08-M181', species: 'イノシシ', sex: 'メス', capture_month: '2026年8月', capture_city: '南房総市', capture_method: 'くくり罠' }] },
  { id: 'g2', dish_name: '鹿モモのタルタル', description: null, photo_path: 'p/22222222-2222-2222-2222-222222222222.jpg', published_at: '2026-10-04T01:00:00Z',
    shop: { name: '和食しか', description: null, area: null, url: 'https://example.com/shika', instagram: null },
    individuals: [{ label_id: 'TGC-08-シ009', species: 'シカ', sex: 'オス', capture_month: '2026年9月', capture_city: '館山市', capture_method: '箱罠' }] },
];

async function launch(width) {
  const browser = await pw.chromium.launch({ executablePath: CHROME });
  const ctx = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  return { browser, ctx, page, errors };
}
const J = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

(async () => {
  const results = []; const T = (n, ok, got) => results.push([n, !!ok, got == null ? '' : String(got)]);

  // ── 公開ページ ──
  {
    const { browser, page, errors } = await launch(1280);
    await page.route('**/*', r => {
      const u = r.request().url();
      if (u.startsWith('file:')) return r.continue();
      if (/rpc\/public_dish_gallery/.test(u)) return J(r, GALLERY);
      if (/storage\/v1\/object\/public\/dish-photos/.test(u)) return r.fulfill({ status: 200, contentType: 'image/png', body: PNG });
      return J(r, []);
    });
    await page.goto('file://' + path.resolve(__dirname, '../../dishes.html'));
    await page.waitForTimeout(500);
    const n = await page.$$eval('.card', els => els.length);
    T('公開済みの料理が2件カードで出る', n === 2, n);
    const t = await page.$eval('#grid', el => el.innerText);
    T('料理名・お店・地域・説明が出る', /ビストロ館山/.test(t) && /東京都江東区/.test(t) && /低温でじっくり/.test(t), '');
    T('使った個体: 種・性別・捕獲月・市・方法・個体番号', /イノシシ・メス/.test(t) && /2026年8月　南房総市　くくり罠/.test(t) && /TGC-08-M181/.test(t), '');
    T('捕獲者名・電話・緯度経度の欄は無い', !/捕獲者|電話|緯度|経度/.test(t), '');
    T('料理名のHTMLは文字として出る（XSSしない）', /<img src=x/.test(t) && !(await page.evaluate(() => window.__xss)) && !(await page.$('.dn img')), '');
    const hrefs = await page.$$eval('.links a', as => as.map(a => a.getAttribute('href')));
    T('javascript: のURLはリンクにせず、Instagramは公式URLにする', !hrefs.some(h => /^javascript/i.test(h)) && hrefs.includes('https://www.instagram.com/bistro.tateyama/') && hrefs.includes('https://example.com/shika'), JSON.stringify(hrefs));
    await page.click('.filters button:has-text("シカ")');
    T('獣種で絞り込める（シカ→1件）', (await page.$$eval('.card', els => els.length)) === 1 && /鹿モモ/.test(await page.$eval('#grid', el => el.innerText)), '');
    T('pageerror なし', errors.length === 0, errors.join(' / '));
    await browser.close();
  }
  {
    const { browser, page } = await launch(390);
    await page.route('**/*', r => r.request().url().startsWith('file:') ? r.continue()
      : /rpc\/public_dish_gallery/.test(r.request().url()) ? J(r, GALLERY) : r.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
    await page.goto('file://' + path.resolve(__dirname, '../../dishes.html'));
    await page.waitForTimeout(500);
    const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: innerWidth, h1: parseFloat(getComputedStyle(document.querySelector('h1')).fontSize), dd: parseFloat(getComputedStyle(document.querySelector('.dd')).fontSize) }));
    T('スマホ幅390px: 横にはみ出さない・本文13px以上', m.doc <= m.vw && m.dd >= 13, JSON.stringify(m));
    await browser.close();
  }
  for (const [label, handler, re] of [
    ['0件なら「準備中」を出す', r => J(r, []), /準備中/],
    ['読み込み失敗は画面にエラーを出す（無言で空にしない）', r => J(r, { message: 'boom' }, 500), /読み込みに失敗/],
  ]) {
    const { browser, page } = await launch(800);
    await page.route('**/*', r => r.request().url().startsWith('file:') ? r.continue() : handler(r));
    await page.goto('file://' + path.resolve(__dirname, '../../dishes.html'));
    await page.waitForTimeout(400);
    const st = await page.$eval('#state', el => el.hidden ? '' : el.innerText);
    T(label, re.test(st), st);
    await browser.close();
  }

  // ── お店の投稿（order.html） ──
  {
    const { browser, page, errors } = await launch(390);
    const calls = []; let mine = { shop: null, customer_name: 'ビストロ館山', posts: [], labels: [{ label_id: 'TGC-08-M181', species: 'イノシシ', parts: 'ロース', last_date: '2026-09-10' }, { label_id: 'TGC-08-T265', species: 'イノシシ', parts: '肩ロース', last_date: '2026-09-01' }] };
    let uploadStatus = 200;
    await page.route('**/*', async r => {
      const u = r.request().url(), req = r.request();
      if (u.startsWith('file:')) return r.continue();
      if (/storage\/v1\/object\/dish-photos\//.test(u)) {
        calls.push({ fn: 'upload', path: u.split('/dish-photos/')[1], type: req.headers()['content-type'], upsert: req.headers()['x-upsert'], size: (req.postDataBuffer() || []).length });
        return uploadStatus === 200 ? J(r, { Key: 'ok' }) : J(r, { message: 'new row violates row-level security policy' }, uploadStatus);
      }
      if (/storage\/v1\/object\/public/.test(u)) return r.fulfill({ status: 200, contentType: 'image/png', body: PNG });
      const m = u.match(/rpc\/([a-z_0-9]+)/); const fn = m && m[1];
      const args = (() => { try { return JSON.parse(req.postData() || '{}'); } catch (e) { return {}; } })();
      if (fn) calls.push({ fn, args });
      if (fn === 'portal_me') return J(r, [{ name: 'ビストロ館山', honorific: '様' }]);
      if (fn === 'portal_dish_mine') return J(r, mine);
      if (fn === 'portal_dish_shop_save') { mine = { ...mine, shop: { display_name: args.p_display_name, description: args.p_description, consent_at: '2026-10-05T00:00:00Z' } }; return J(r, null); }
      if (fn === 'portal_dish_post') { mine.posts = [{ id: 'p1', dish_name: args.p_dish_name, photo_path: args.p_photo_path, status: '確認待ち', created_at: '2026-10-05T02:00:00Z', individuals: [] }]; return J(r, 'p1'); }
      if (fn === 'portal_dish_withdraw') { mine.posts[0].status = '非公開'; return J(r, null); }
      return J(r, []);
    });
    await page.addInitScript(() => sessionStorage.setItem('tg_ptoken', 'T'));
    await page.goto('file://' + path.resolve(__dirname, '../../order.html'));
    await page.waitForTimeout(600);
    await page.click('button:has-text("🍽 料理")');
    await page.waitForTimeout(400);
    T('「🍽 料理」で投稿画面が開く', !(await page.$eval('#scr-dish', el => el.classList.contains('hidden'))), '');
    T('紹介を保存するまで投稿欄は出ない', await page.$eval('#dp-form', el => el.classList.contains('hidden')), '');
    T('お店の名前は顧客名が初期値', (await page.inputValue('#ds-name')) === 'ビストロ館山', await page.inputValue('#ds-name'));
    await page.fill('#ds-desc', '館山の猪を季節のソースで');
    await page.click('#ds-save');
    await page.waitForTimeout(200);
    T('同意なしでは保存しない（RPCを呼ばず理由を出す）', !calls.some(c => c.fn === 'portal_dish_shop_save') && /同意/.test(await page.$eval('#ds-msg', el => el.textContent)), '');
    await page.check('#ds-consent');
    await page.click('#ds-save');
    await page.waitForTimeout(500);
    const save = calls.find(c => c.fn === 'portal_dish_shop_save');
    T('同意ありで保存 → 投稿欄が出る', save && save.args.p_consent === true && save.args.p_description === '館山の猪を季節のソースで' && !(await page.$eval('#dp-form', el => el.classList.contains('hidden'))), JSON.stringify(save && save.args));
    T('届いた個体が選択肢に出る', (await page.$$eval('.dp-lab', els => els.map(e => e.value))).join(',') === 'TGC-08-M181,TGC-08-T265', '');

    await page.setInputFiles('#dp-photo', { name: 'dish.png', mimeType: 'image/png', buffer: PNG });
    await page.fill('#dp-name', '猪肩ロースのロースト');
    await page.check('.dp-lab[value="TGC-08-M181"]');
    await page.click('#dp-send');
    await page.waitForTimeout(400);
    T('同意なしでは投稿しない（アップロードもしない）', !calls.some(c => c.fn === 'upload' || c.fn === 'portal_dish_post') && /同意/.test(await page.$eval('#dp-msg', el => el.textContent)), '');

    await page.check('#dp-consent');
    uploadStatus = 400;
    await page.click('#dp-send');
    await page.waitForTimeout(800);
    T('アップロード失敗 → 投稿RPCを呼ばず理由を画面に出す', calls.some(c => c.fn === 'upload') && !calls.some(c => c.fn === 'portal_dish_post') && /写真をアップロードできませんでした/.test(await page.$eval('#dp-msg', el => el.textContent)), await page.$eval('#dp-msg', el => el.textContent));

    uploadStatus = 200;
    await page.click('#dp-send');
    await page.waitForTimeout(900);
    const up = calls.filter(c => c.fn === 'upload').pop(), post = calls.find(c => c.fn === 'portal_dish_post');
    T('写真は p/<uuid>.jpg にJPEGで追加のみ（上書きなし）', up && /^p\/[0-9a-f-]{36}\.jpg$/.test(up.path) && up.type === 'image/jpeg' && up.upsert === 'false' && up.size > 0, JSON.stringify(up));
    T('投稿RPCに アップロードした path・料理名・選んだ個体・同意 を渡す', post && post.args.p_photo_path === up.path && post.args.p_dish_name === '猪肩ロースのロースト' && JSON.stringify(post.args.p_label_ids) === '["TGC-08-M181"]' && post.args.p_consent === true, JSON.stringify(post && post.args));
    T('投稿後は「確認待ち」で一覧に出る・完了の案内', /センター確認待ち/.test(await page.$eval('#dish-mine', el => el.innerText)) && /確認してから公開/.test(await page.$eval('#dp-msg', el => el.textContent)), '');

    page.once('dialog', d => d.accept());
    await page.click('#dish-mine .wd');
    await page.waitForTimeout(500);
    T('取り下げで portal_dish_withdraw を呼ぶ', calls.some(c => c.fn === 'portal_dish_withdraw' && c.args.p_post_id === 'p1'), '');
    const m = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: innerWidth }));
    T('スマホ幅390px: 投稿画面が横にはみ出さない', m.doc <= m.vw, JSON.stringify(m));
    T('pageerror なし（投稿画面）', errors.length === 0, errors.join(' / '));
    await browser.close();
  }

  // ── センター（order-admin.html） ──
  {
    const { browser, page, errors } = await launch(1280);
    const calls = [];
    let posts = [{ id: 'q1', customer_id: 'c1', customer_name: 'ビストロ館山', shop_name: 'ビストロ館山', shop_consent: true, dish_name: '猪のロースト', description: null, photo_path: 'p/11111111-1111-1111-1111-111111111111.jpg', status: '確認待ち', source: 'お店', consent_by: 'お店', created_at: '2026-10-05T02:00:00Z', individuals: [] },
                 { id: 'q2', customer_id: 'c1', customer_name: 'ビストロ館山', shop_name: 'ビストロ館山', shop_consent: true, dish_name: '取り下げた料理', status: '非公開', source: 'お店', withdrawn_at: '2026-10-05T03:00:00Z', created_at: '2026-10-04T02:00:00Z', photo_path: 'p/22222222-2222-2222-2222-222222222222.jpg', individuals: [] }];
    await page.addInitScript(() => { localStorage.setItem('tg_staff_key', 'K'); sessionStorage.setItem('tg_role_v1', 'admin'); });
    page.on('dialog', d => d.accept());
    await page.route('**/*', r => {
      const u = r.request().url(), req = r.request();
      if (u.startsWith('file:')) return r.continue();
      if (/storage\/v1\/object\/public/.test(u)) return r.fulfill({ status: 200, contentType: 'image/png', body: PNG });
      const m = u.match(/rpc\/([a-z_0-9]+)/); const fn = m && m[1];
      if (fn && /^staff_dish/.test(fn)) {
        const args = JSON.parse(req.postData() || '{}'); calls.push({ fn, args, key: req.headers()['x-staff-key'] });
        if (fn === 'staff_dish_list') return J(r, { posts, shops: [] });
        if (fn === 'staff_dish_set_status') { posts = posts.map(p => p.id === args.p_post_id ? { ...p, status: args.p_status } : p); return J(r, null); }
      }
      if (/\/customers/.test(u)) return J(r, [{ id: 'c1', code: 'C0001', name: 'ビストロ館山', honorific: '様', is_active: true }]);
      return J(r, []);
    });
    await page.goto('file://' + path.resolve(__dirname, '../../order-admin.html'));
    await page.waitForTimeout(800);
    await page.click('.tab[data-tab="dishes"]');
    await page.waitForTimeout(600);
    const list = calls.find(c => c.fn === 'staff_dish_list');
    T('料理ギャラリータブは staff_dish_list をスタッフキー付きで読む', list && list.key === 'K', JSON.stringify(list));
    T('既定は「確認待ち」だけ表示', (await page.$$eval('#dishAdminList .dcard', els => els.length)) === 1, '');
    await page.click('#dishAdminList button:has-text("公開する")');
    await page.waitForTimeout(500);
    const st = calls.find(c => c.fn === 'staff_dish_set_status');
    T('「公開する」で staff_dish_set_status(公開)', st && st.args.p_post_id === 'q1' && st.args.p_status === '公開' && st.key === 'K', JSON.stringify(st && st.args));
    await page.selectOption('#dishFilter', '非公開');
    T('お店が取り下げた投稿には「公開する」が出ない', /お店が取り下げ/.test(await page.$eval('#dishAdminList', el => el.innerText)) && !(await page.$('#dishAdminList button:has-text("公開する")')), '');
    const msgs = await page.evaluate(() => { const c = { name: 'ビストロ館山', honorific: '様', code: 'C0001', __issuedPw: '123456' };
      return ['line', 'card', 'mail'].map(ch => buildPortalMsg(c, ch)); });
    T('案内文（LINE・カード・メール）にギャラリーのURL', msgs.every(t => t.includes('https://tateyama-gibier.vercel.app/dishes.html')), '');
    T('pageerror なし（管理画面）', errors.length === 0, errors.join(' / '));
    await browser.close();
  }

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 220) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
