// 精肉: 消した識別コードを採り直さない／保存に失敗したら黙らない
//
//   事故（2026-08-28 TGC-08-T282-BA）
//     バラ 1.550kg を登録 → 骨付きに直そうとして削除 → 入れ直したら
//     inventory.ident_code の UNIQUE（削除済みも含む）に当たって登録が落ちた。
//     ラベルは保存より先に出るので、ラベルだけ出て在庫が無い状態になった。
//     失敗はトーストだけだったので、現場では気づけなかった。
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const IND = { label_id: 'TGC-08-T282', species: 'イノシシ', weight_total: 48, capture_date: '2026-08-19' };

async function boot() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { sessionStorage.setItem('tg_access_v1', 'ok'); } catch (e) {} });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));

  // 在庫テーブルの代わり。ident_code は削除済みも含めて一意（本番と同じ）。
  const db = { rows: [] };
  const posted = [];
  await page.route('**/*', r => {
    const u = r.request().url(), m = r.request().method();
    if (u.includes('jsdelivr') || u.includes('cdn')) return r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.JsBarcode=function(){};' });
    if (u.startsWith('file:')) return r.continue();
    const J = (b, st) => r.fulfill({ status: st || 200, contentType: 'application/json', body: JSON.stringify(b) });
    const dec = decodeURIComponent(u);
    if (/\/rest\/v1\/inventory/.test(u)) {
      if (m === 'POST') {
        const b = JSON.parse(r.request().postData() || '{}');
        posted.push(b);
        if (db.rows.some(x => x.ident_code === b.ident_code)) {
          return J({ code: '23505', message: 'duplicate key value violates unique constraint "inventory_ident_code_key"' }, 409);
        }
        db.rows.push(Object.assign({ deleted_at: null }, b));
        return J([b], 201);
      }
      if (m === 'PATCH') {
        const ic = (dec.match(/ident_code=eq\.([^&]+)/) || [])[1];
        const row = db.rows.find(x => x.ident_code === ic && !x.deleted_at);
        if (row) row.deleted_at = new Date().toISOString();
        return J([]);
      }
      const ind = (dec.match(/individual_id=eq\.([^&]+)/) || [])[1];
      if (ind) return J(db.rows.filter(x => x.individual_id === ind));
      return J([]);
    }
    if (/\/rest\/v1\/individuals/.test(u)) return J([IND]);
    if (/\/rest\/v1\/staff/.test(u)) return J([{ name: '白石秀一' }]);
    if (/\/rpc\/reserve_scan_codes/.test(u)) return J([]);   // 数字キーは取れない前提（本番でもよくある）
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(700);
  return { browser, page, errors, db, posted };
}

(async () => {
  const results = [];
  const T = (n, ok, got) => results.push([n, ok, got == null ? '' : String(got)]);
  const { browser, page, errors, db, posted } = await boot();

  const asked = [];
  let answerConfirm = true;
  page.on('dialog', async d => { asked.push(d.message()); answerConfirm ? await d.accept() : await d.dismiss(); });

  // 印刷は実際に出さず、出た内容だけ記録する
  await page.evaluate(() => {
    window.__printed = [];
    window.pmPrintLabel = (w, lot, ident, part) => { window.__printed.push({ ident, part, w }); };
  });

  // 精肉モードに入る
  await page.evaluate(async () => {
    pmCurrentOperator = '白石秀一';
    await pmSelectIndividual('TGC-08-T282');
    pmSelectedPart = { part_name: 'バラ', barcode_num: 'BA', price_standard: 3100 };
  });
  await page.waitForTimeout(400);

  // ── 1) 1件目: バラ 1.550kg ──
  await page.evaluate(() => pmRequestRegister(1.55));
  await page.waitForTimeout(500);
  T('1件目が登録される', db.rows.length === 1 && db.rows[0].ident_code === 'TGC-08-T282-BA',
    db.rows.map(r => r.ident_code).join(','));
  T('ラベルも同じ番号で出る',
    (await page.evaluate(() => window.__printed.map(p => p.ident).join(','))) === 'TGC-08-T282-BA',
    await page.evaluate(() => window.__printed.map(p => p.ident).join(',')));
  T('部位名は「バラ」', db.rows[0].part_name === 'バラ', db.rows[0].part_name);

  // ── 2) 骨付きに直すため削除 ──
  asked.length = 0;
  await page.evaluate(async () => { await pmDeleteCompleted(0); });
  await page.waitForTimeout(500);
  T('削除の確認が出る', asked.some(a => /登録を取り消して在庫から削除/.test(a)), asked.join(' / ').slice(0, 50));
  T('DBでは削除済みになる（行は残る）',
    db.rows.length === 1 && !!db.rows[0].deleted_at, JSON.stringify(db.rows.map(r => [r.ident_code, !!r.deleted_at])));
  T('登録済み一覧からは消える',
    (await page.evaluate(() => pmCompletedParts.length)) === 0, '');
  T('使った番号は覚えている',
    await page.evaluate(() => pmUsedIdents.has('TGC-08-T282-BA')), '');

  // ── 3) 骨付きで入れ直す（ここが事故った操作） ──
  asked.length = 0; posted.length = 0;
  await page.evaluate(() => { pmBoneIn = true; });
  await page.evaluate(() => pmRequestRegister(1.55));
  await page.waitForTimeout(700);
  T('入れ直しが登録される（ラベルだけ出て終わらない）',
    db.rows.filter(r => !r.deleted_at).length === 1,
    db.rows.map(r => r.ident_code + (r.deleted_at ? '(削除)' : '')).join(','));
  const live = db.rows.find(r => !r.deleted_at);
  T('消した番号は採り直さない', live && live.ident_code === 'TGC-08-T282-BA-2', live && live.ident_code);
  T('骨付きとして入る', live && live.part_name === '骨付き バラ', live && live.part_name);
  T('重量はそのまま', live && Number(live.weight) === 1.55, live && live.weight);
  T('重複エラーは1度も起きていない', posted.length === 1, `POST ${posted.length}回`);
  T('ラベルも新しい番号で出る',
    (await page.evaluate(() => window.__printed[window.__printed.length - 1].ident)) === 'TGC-08-T282-BA-2',
    await page.evaluate(() => window.__printed[window.__printed.length - 1].ident));
  T('番号がずれた注意は出さない（ずれていないので）',
    !asked.some(a => /識別コードが/.test(a)), asked.join(' / ').slice(0, 60));

  // ── 4) それでも番号が重なったら、ずらして必ず登録し、刷り直しを伝える ──
  asked.length = 0; posted.length = 0;
  await page.evaluate(() => {
    // 別の端末が先に -3 を使った状態を作る（こちらの台帳には無い）
    pmUsedIdents.delete('TGC-08-T282-BA-3');
  });
  await page.evaluate(() => {
    window.__extra = true;
  });
  // 先に -3 をDBへ入れておく（この画面は知らない）
  await page.evaluate(async () => {
    await sb('POST', 'inventory', {
      individual_id: 'TGC-08-T282', individual_code: 'TGC-08-T282', species: 'イノシシ',
      part_name: 'バラ', barcode_num: 'BA', ident_code: 'TGC-08-T282-BA-3',
      weight: 0.9, weight_kg: 0.9, status: '在庫', tier: 2
    });
    pmUsedIdents.delete('TGC-08-T282-BA-3');   // 画面の台帳からは消して「知らない」状態にする
    pmCompletedParts = pmCompletedParts.filter(c => c.ident_code !== 'TGC-08-T282-BA-3');
  });
  await page.evaluate(() => pmRequestRegister(1.20));
  await page.waitForTimeout(900);
  const live2 = db.rows.filter(r => !r.deleted_at && Number(r.weight) === 1.2);
  T('番号が重なっても必ず在庫に入る', live2.length === 1, db.rows.filter(r => !r.deleted_at).map(r => r.ident_code).join(','));
  T('ずらした番号で入る', live2.length === 1 && live2[0].ident_code === 'TGC-08-T282-BA-4', live2[0] && live2[0].ident_code);
  T('番号が変わったことを必ず知らせる',
    asked.some(a => /識別コードが/.test(a) && /ラベル/.test(a)), asked.join(' / ').slice(0, 100));

  // ── 5) 保存が落ちたら、消えるトーストで済ませない ──
  asked.length = 0; answerConfirm = false;   // 「もう一度登録しますか？」にキャンセル
  await page.route('**/rest/v1/inventory*', r => {
    if (r.request().method() === 'POST') {
      return r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'サーバーエラー' }) });
    }
    return r.fallback();
  });
  await page.evaluate(() => pmRequestRegister(0.80));
  await page.waitForTimeout(900);
  T('保存が落ちたら手を止める（確認ダイアログ）',
    asked.some(a => /在庫に登録できませんでした/.test(a)), asked.join(' / ').slice(0, 80));
  T('ラベルが出たことも伝える', asked.some(a => /ラベルは出ましたが/.test(a)), '');
  T('捨てるように書く', asked.some(a => /ラベルを捨てて/.test(a)), '');
  T('落ちた分は在庫に入っていない',
    db.rows.filter(r => !r.deleted_at && Number(r.weight) === 0.8).length === 0, '');

  T('pageerrorなし', errors.length === 0, errors.join(' / '));

  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
