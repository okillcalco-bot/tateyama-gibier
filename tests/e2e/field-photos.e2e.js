// 📷 現場からの写真: 共用スマホ（打刻ページ）から送った写真が、出荷管理の受け箱に届いて対応済みにできるか
//
//   きっかけ（2026-09-16）
//     出荷でバーコードが読めなかった袋や重量物の写真を、チャットに送って手作業で出荷に足していた
//     （1日で21枚）。打刻ページに「写真を送る」を置き、出荷管理の先頭に「未処理の写真」として並べる。
//     誰が出荷処理をしても同じ手順で拾えるよう、両方の画面に説明書きを置く。
//
//   ここで測ること（punch.html）
//     1. 「写真を送る」ボタンがあり、開くと使い方・種類・名前・写真ボタンが出る
//     2. 名前を選ばずに送ると止まり、理由が画面に出る（サイレント失敗を作らない）
//     3. 写真2枚を送ると storage に2回アップロードされ、field_photos に2行入る（種類・名前・一言・パス）
//     4. アップロードが失敗したら赤で画面に出て、写真は残る
//   ここで測ること（index.html 出荷管理）
//     5. 出荷タブの先頭に「現場からの写真」と説明書きが出て、未処理の件数が合う
//     6. 「対応済み」を押すと resolved_at・resolved_note が PATCH される
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

// 8x8 の赤いPNG（縮小処理を通すため実画像を使う）
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFklEQVR4nGP8z4AAjEwMDAwMDAwMDAAcAQYB1o8j1QAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  /* ───── punch.html: 写真を送る ───── */
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const uploads = [], posted = [];
    let storageFail = false;
    await page.route('**/*', r => {
      const u = r.request().url(), m = r.request().method();
      if (u.startsWith('file:') || u.startsWith('blob:')) return r.continue();
      const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (/\/storage\/v1\/object\/field-photos\//.test(u)) {
        if (storageFail) return r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"boom"}' });
        uploads.push({ u, ct: r.request().headers()['content-type'] }); return J({ Key: 'ok' });
      }
      if (/\/rest\/v1\/staff/.test(u)) return J([{ id: 's1', name: '吉田友美' }, { id: 's2', name: '白石秀一' }]);
      if (/\/rest\/v1\/field_photos/.test(u) && m === 'POST') {
        const body = JSON.parse(r.request().postData() || '[]'); posted.push(body);
        return r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(body.map((x, i) => ({ id: 'fp' + i, ...x }))) });
      }
      if (/\/rest\/v1\/attendance/.test(u)) return J([]);
      return J([]);
    });
    await page.goto('file://' + path.resolve(__dirname, '../../punch.html'));
    await page.waitForTimeout(600);

    T('「写真を送る」ボタンがある', await page.$('#photo-open-btn') !== null, '');
    await page.click('#photo-open-btn');
    await page.waitForTimeout(200);
    const boxText = await page.textContent('#photo-box');
    T('開くと使い方が書いてある', /使い方/.test(boxText) && /現場からの写真/.test(boxText), '');
    T('種類の選択肢が3つ', (await page.$$('#photo-kinds .chip')).length === 3, '');
    T('名前の選択肢にスタッフが入る', (await page.$$('#photo-staff option')).length === 3, '');

    // 2) 名前を選ばずに送る → 止まる
    await page.setInputFiles('#photo-files', [{ name: 'a.png', mimeType: 'image/png', buffer: PNG }]);
    await page.waitForTimeout(200);
    await page.click('#photo-send-btn');
    await page.waitForTimeout(300);
    const r1 = await page.$eval('#photo-result', e => ({ shown: e.style.display !== 'none', err: e.classList.contains('err'), txt: e.textContent }));
    T('名前なしで送ると止まり、理由が赤で出る', r1.shown && r1.err && /名前/.test(r1.txt), r1.txt);
    T('止まったときは何も送られない', uploads.length === 0 && posted.length === 0, '');

    // 3) 2枚送る
    await page.selectOption('#photo-staff', '吉田友美');
    await page.fill('#photo-note', 'にくひろ カタ');
    await page.click('#photo-kinds .chip:nth-child(2)');   // 重量物
    await page.setInputFiles('#photo-files', [{ name: 'b.png', mimeType: 'image/png', buffer: PNG }]);
    await page.waitForTimeout(200);
    T('写真が2枚並ぶ', (await page.$$('#photo-previews img')).length === 2, '');
    await page.click('#photo-send-btn');
    await page.waitForTimeout(1500);
    T('storageに2回アップロードされる', uploads.length === 2, String(uploads.length));
    T('JPEGに縮小して送る', uploads.every(x => x.ct === 'image/jpeg'), uploads.map(x => x.ct).join(','));
    const rows = posted[0] || [];
    T('field_photos に2行入る', rows.length === 2, JSON.stringify(rows).slice(0, 200));
    T('種類・名前・一言・パスが入る', rows.every(x => x.kind === '重量物' && x.staff_name === '吉田友美' && x.note === 'にくひろ カタ' && /\.jpg$/.test(x.photo_path)), JSON.stringify(rows[0]));
    const r2 = await page.$eval('#photo-result', e => ({ err: e.classList.contains('err'), txt: e.textContent }));
    T('送れたことが緑で出る', !r2.err && /2枚/.test(r2.txt), r2.txt);
    T('送った後は写真が消える', (await page.$$('#photo-previews img')).length === 0, '');

    // 4) 失敗は赤で出て写真が残る
    storageFail = true;
    await page.setInputFiles('#photo-files', [{ name: 'c.png', mimeType: 'image/png', buffer: PNG }]);
    await page.waitForTimeout(200);
    await page.click('#photo-send-btn');
    await page.waitForTimeout(1200);
    const r3 = await page.$eval('#photo-result', e => ({ err: e.classList.contains('err'), txt: e.textContent }));
    T('失敗したら赤で理由が出る', r3.err && /送れませんでした/.test(r3.txt), r3.txt);
    T('失敗した写真は画面に残る', (await page.$$('#photo-previews img')).length === 1, '');
    T('punch.html ページエラーなし', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  /* ───── index.html: 出荷管理の受け箱 ───── */
  {
    const ctx = await browser.newContext();
    await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_role_v1', 'admin'); sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', async d => { await d.accept('DIR-20260916-091037 に追加'); });
    const patched = [];
    const PHOTOS = [
      { id: 'p1', kind: '読めなかったラベル', note: 'にくひろ', staff_name: '吉田友美', photo_path: '2026-09-16/a.jpg', taken_at: '2026-09-16T01:00:00Z', resolved_at: null },
      { id: 'p2', kind: '重量物', note: null, staff_name: '白石秀一', photo_path: '2026-09-16/b.jpg', taken_at: '2026-09-16T02:00:00Z', resolved_at: null },
    ];
    await page.route('**/*', r => {
      const u = r.request().url(), m = r.request().method();
      if (u.startsWith('file:')) return r.continue();
      const J = b => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
      if (/\/storage\/v1\/object\/public\//.test(u)) return r.fulfill({ status: 200, contentType: 'image/png', body: PNG });
      if (!/\/rest\/v1\//.test(u)) return r.fulfill({ status: 200, body: '[]' });
      if (/\/field_photos/.test(u)) {
        if (m === 'PATCH') { patched.push({ u: decodeURIComponent(u), body: JSON.parse(r.request().postData() || '{}') }); return J([{}]); }
        return J(PHOTOS);
      }
      if (m !== 'GET') return J([]);
      return J([]);
    });
    await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
    await page.waitForTimeout(600);
    await page.evaluate(() => { document.querySelector('[data-tab="shipping"]').click(); });
    await page.waitForTimeout(700);

    const box = await page.$('#field-photo-box');
    T('出荷タブに「現場からの写真」がある', box !== null, '');
    const first = await page.$eval('#panel-shipping .section', e => e.id);
    T('出荷タブのいちばん上に出る', first === 'field-photo-box', first);
    const txt = await page.textContent('#field-photo-box');
    T('説明書き（これは何？・対応の手順）がある', /これは何/.test(txt) && /対応済み/.test(txt) && /識別コード/.test(txt), '');
    T('未処理の件数が2', (await page.textContent('#fp-count')) === '2', await page.textContent('#fp-count'));
    T('写真カードが2枚出る', (await page.$$('.fp-card')).length === 2, '');
    T('種類と送った人が出る', /読めなかったラベル/.test(txt) && /吉田友美/.test(txt) && /重量物/.test(txt), '');

    await page.click('.fp-card[data-id="p1"] .fp-resolve');
    await page.waitForTimeout(400);
    T('対応済みで field_photos に PATCH される', patched.length === 1 && /id=eq\.p1/.test(patched[0].u), JSON.stringify(patched));
    T('resolved_at と何をしたかが入る', patched[0] && !!patched[0].body.resolved_at && patched[0].body.resolved_note === 'DIR-20260916-091037 に追加' && patched[0].body.resolved_by === '管理者', JSON.stringify(patched[0] && patched[0].body));
    T('index.html ページエラーなし', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got.slice(0, 200) + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
