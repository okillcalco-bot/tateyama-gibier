// お弁当・イベントの感想QR（s.html?m=）（2026-10-10）
//
//   きっかけ: 10/11 のイベントのジビエ弁当（からあげ・シュウマイ）で、食べた人の感想を集めたい。
//     ラベルの無い料理からは感想を送れなかった（パックの8桁か個体番号が必要だった）。
//
//   ここで測ること
//     1. s.html?m=コード で料理ごとに★とスタンプ（選択式）が出る
//     2. 何も押さずに送ると止めて理由を出す（黙って送らない）
//     3. 押した料理の数だけ感想を送る。ひとことは最初の料理に1回だけ（同じ文を重ねない）
//     4. 送った後はお礼と、料理ごとの人数・★・スタンプの集計が出る（文章は出さない）
//     5. 送信に失敗したら画面に出し、ボタンを戻す
//     6. 職員画面: 料理の入力（1行1品・「名前／説明／個体番号」）を読める
//     7. 実寸: 印刷したカード（91×55mm）のQRが読めて、正しいURLになる。ポスターのQRも読める
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');

const MENU = { menu: { code: 'm1011bt', title: 'ジビエ弁当', date: '2026年10月11日', venue: null },
  dishes: [{ name: 'からあげ', note: 'ジビエのからあげ', members: [], count: 0, avg: null, stamps: {} },
           { name: 'シュウマイ', note: 'ジビエのシュウマイ', members: [{ label: 'TGC-08-T340', place: '館山市 神余', capture_date: '2026/09/20' }], count: 0, avg: null, stamps: {} }],
  voice_count: 0 };

function decodeQR(png) {
  const py = `import sys, zxingcpp
from PIL import Image
r = zxingcpp.read_barcodes(Image.open(sys.argv[1]))
print('\\n'.join(x.text for x in r))`;
  return execFileSync('python3', ['-I', '-c', py, png]).toString().trim();
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);

  // ── 公開ページ ──
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 840 } });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const sent = []; let after = false, fail = false;
    await page.route('**/rest/v1/**', rt => {
      const url = rt.request().url();
      const J = x => rt.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(x) });
      if (/rpc\/story_get_menu/.test(url)) {
        if (!after) return J(MENU);
        const m = JSON.parse(JSON.stringify(MENU)); m.dishes[0].count = 1; m.dishes[0].avg = 5; m.dishes[0].stamps = { 'うまい！': 1 }; m.dishes[1].count = 1; m.dishes[1].stamps = { 'くさみゼロ': 1 };
        return J(m);
      }
      if (/rpc\/story_add_voice_menu/.test(url)) {
        if (fail) return rt.fulfill({ status: 500, body: 'x' });
        sent.push(JSON.parse(rt.request().postData())); after = true; return J({ ok: true, voice_count: sent.length });
      }
      return J([]);
    });
    await page.goto('file://' + path.resolve(__dirname, '../../s.html') + '?m=M1011BT');
    await page.waitForTimeout(500);
    const t = await page.$eval('#main', e => e.textContent);
    T('料理ごとのカード（からあげ・シュウマイ）と★・スタンプが出る', /からあげ/.test(t) && /シュウマイ/.test(t) && await page.$$eval('.mdish .stars', e => e.length) === 2 && await page.$$eval('#mstamps-0 button', e => e.length) === 6, '');
    T('使ったお肉の一頭が分かる料理は、その一頭へのリンク', await page.$('a.chip-a[href="?i=TGC-08-T340"]') !== null, '');
    T('見出しは「ジビエ料理の感想」', await page.$eval('header h1', e => e.textContent) === 'ジビエ料理の感想', '');

    fail = true;
    await page.click('#send');
    T('何も押さずに送ると止めて理由を出す', sent.length === 0 && /星かスタンプ/.test(await page.$eval('#msg', e => e.textContent)), '');
    await page.click('#mstars-0 button[data-n="5"]');
    await page.click('#mstamps-0 button[data-s="うまい！"]');
    await page.click('#mstamps-1 button[data-s="くさみゼロ"]');
    await page.fill('#comment', '子どもも完食しました');
    await page.click('#send'); await page.waitForTimeout(400);
    T('送信に失敗したら画面に出し、ボタンを戻す', /送信できませんでした/.test(await page.$eval('#msg', e => e.textContent)) && !(await page.$eval('#send', e => e.disabled)), await page.$eval('#msg', e => e.textContent));
    fail = false;
    await page.click('#send'); await page.waitForTimeout(600);
    const a = sent.find(x => x.p_dish === 'からあげ') || {}, b = sent.find(x => x.p_dish === 'シュウマイ') || {};
    T('押した料理の数だけ送る（からあげ★5＋うまい！／シュウマイ くさみゼロ）', sent.length === 2 && a.p_rating === 5 && a.p_stamps[0] === 'うまい！' && b.p_rating === null && b.p_stamps[0] === 'くさみゼロ' && a.p_code === 'm1011bt', JSON.stringify(sent));
    T('ひとことは最初の料理に1回だけ', a.p_comment === '子どもも完食しました' && b.p_comment === '', '');
    const t2 = await page.$eval('#main', e => e.textContent);
    T('送った後: お礼と、料理ごとの人数・★・スタンプの集計（文章は出さない）', /ありがとうございます！からあげ・シュウマイ/.test(t2) && /みんなの声 1人・★5/.test(t2) && /うまい！×1/.test(t2) && !/子どもも完食/.test(t2), t2.slice(0, 200));
    T('pageerrorなし（公開ページ）', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  // ── 職員画面: 入力の読み取りと印刷（実寸でQRを読む）──
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', rt => /^file:/.test(rt.request().url()) ? rt.continue() : rt.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
    await page.waitForTimeout(800);
    const d = await page.evaluate(() => mvParseDishes('からあげ／ジビエのからあげ\nシュウマイ／ジビエのシュウマイ／TGC-08-T340、TGC-08-T345\n\n'));
    T('職員: 料理を1行1品で読む（名前／説明／個体番号）', d.length === 2 && d[0].name === 'からあげ' && d[0].labels.length === 0 && d[1].labels.join() === 'TGC-08-T340,TGC-08-T345', JSON.stringify(d));

    const m = { code: 'm1011bt', title: 'ジビエ弁当', dishes: [{ name: 'からあげ' }, { name: 'シュウマイ' }] };
    const url = 'https://tateyama-gibier.vercel.app/s.html?m=m1011bt';
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mvqr-'));
    for (const kind of ['cards', 'poster']) {
      const h = await page.evaluate(([m, k]) => mvPrintHtml(m, k), [m, kind]);
      const q = await ctx.newPage();
      await q.setViewportSize({ width: 794, height: 1123 });   // A4 @96dpi
      await q.setContent(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${h.css}</style></head><body>${h.body}</body></html>`);
      await q.emulateMedia({ media: 'print' });
      const el = await q.$(kind === 'cards' ? '.cd' : '.po');
      const box = await el.boundingBox();
      if (kind === 'cards') {
        const fit = await q.evaluate(() => { const c = document.querySelector('.cd'); return { sh: c.scrollHeight, ch: c.clientHeight, sw: c.scrollWidth, cw: c.clientWidth, n: document.querySelectorAll('.cd').length, qr: document.querySelector('.cd .qr svg').getBoundingClientRect().width }; });
        T('実寸: カード10枚・文字がはみ出さない・QRは30mm（≈113px）', fit.n === 10 && fit.sh <= fit.ch && fit.sw <= fit.cw && Math.abs(fit.qr - 113.4) < 2, JSON.stringify(fit));
      }
      // 実寸の2倍の解像度で撮って読む（スマホのカメラより厳しめに、余白込みの1枚で）
      const png = path.join(tmp, kind + '.png');
      await el.screenshot({ path: png, scale: 'device' });
      const got = decodeQR(png);
      T(`実寸: ${kind === 'cards' ? 'カード' : 'A4ポスター'}のQRが読めて、URLが正しい`, got.split('\n').includes(url), got || '(読めず)');
      await q.close();
    }
    T('pageerrorなし（職員画面）', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
