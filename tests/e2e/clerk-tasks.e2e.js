// 事務作業タブ（確認リスト・日報）（2026-10-11）
//
//   きっかけ: バイトに事務作業（精肉の記録の確認・顧客名簿・捕獲者名簿）を任せたい。
//     記録を自動で直したり、足りないと断定したりせず、「候補を出す→資料と照らす→既存の画面で直す／要確認→日報」にする。
//
//   ここで測ること（すべて架空のデータ。本番には触らない）
//     ① 精肉: 「完了印あり・部位0件」「完了印なし・部位0件（判定不能）」「部位あり・完了印なし」に分ける。部位ありで完了済みは出さない
//        画面を開いただけでは何も書き込まない
//     要確認: 既存の気になる点フラグ（data_flags）に記録。6桁以上の数字（口座番号など）は記録しない。保存失敗は画面に出し件数に数えない
//     ② 顧客: ふりがな・住所・郵便番号・電話の空欄、同じ電話・同じ名前の重複候補、注文の届け先と住所の違い
//        スタッフキーが無ければ読まない（権限外）
//        編集→保存: 開いた後に別の人が変えていたら上書きしない（同時編集）。通常は1回だけ保存
//     ③ 捕獲者: ふりがな・振込先の空欄、口座番号の桁（先頭0の7桁は正常）。口座番号を画面に出さない。編集ボタンが無い
//     日報: 作業内容／確認件数／更新件数／要確認の対象と理由／次回の続き。口座番号らしい数字はコピーさせない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

const INDS = [
  { label_id: 'TGC-08-T901', species: 'イノシシ', capture_date: '2026-09-01', weight_total: 40, processing_done_at: '2026-09-10T00:00:00Z' }, // 完了・部位0
  { label_id: 'TGC-08-T902', species: 'イノシシ', capture_date: '2026-10-08', weight_total: 30, processing_done_at: null },                 // 部位0・最近
  { label_id: 'TGC-08-T903', species: 'シカ', capture_date: '2026-09-05', weight_total: 25, processing_done_at: null },                     // 部位あり・未完了
  { label_id: 'TGC-08-T904', species: 'イノシシ', capture_date: '2026-09-06', weight_total: 35, processing_done_at: '2026-09-12T00:00:00Z' }, // 正常
];
const INV = [{ individual_id: 'TGC-08-T903', tier: 2 }, { individual_id: 'TGC-08-T904', tier: 2 }, { individual_id: 'TGC-08-T904', tier: 2 }, { individual_id: 'TGC-08-T901', tier: 3 }];
const CUSTS = [
  { id: 'u1', code: 'C9001', name: 'テスト食堂', kana: null, phone: '0470-11-2222', address: '〒294-0000 千葉県館山市1', is_active: true },
  { id: 'u2', code: 'C9002', name: 'テスト食堂', kana: 'てすとしょくどう', phone: '0470112222', address: '千葉県館山市1', is_active: true },
  { id: 'u3', code: 'C9003', name: '山田商店', kana: 'やまだしょうてん', phone: null, address: null, is_active: true },
  { id: 'u4', code: 'C9004', name: '海の家', kana: 'うみのいえ', phone: '0470-99-0000', address: '〒294-0001 千葉県南房総市2', is_active: true },
  { id: 'u5', code: 'C9005', name: '完全な店', kana: 'かんぜんなみせ', phone: '0470-55-6666', address: '〒294-0002 千葉県館山市3', is_active: true },
];
const ORDS = [{ customer_id: 'u4', delivery_postal: '1000001', delivery_address: '東京都千代田区9-9', order_date: '2026-09-20' }];
const HUNTERS = [
  { id: 'h1', name: '猟師一郎', furigana: 'りょうしいちろう', bank_name: 'テスト銀行', bank_branch: '本店', account_type: '普通', account_number: '0123456', account_holder: 'ﾘｮｳｼ ｲﾁﾛｳ' }, // 正常（先頭0）
  { id: 'h2', name: '猟師二郎', furigana: null, bank_name: 'テスト銀行', bank_branch: '本店', account_type: '普通', account_number: '123456', account_holder: 'リョウシ ジロウ' },
  { id: 'h3', name: '猟師三郎', furigana: 'りょうしさぶろう', bank_name: null, bank_branch: null, account_type: null, account_number: null, account_holder: null },
  { id: 'h4', name: '猟師四郎', furigana: 'りょうししろう', bank_name: 'テスト銀行', bank_branch: '本店', account_type: '定期', account_number: '7654321', account_holder: '猟師四郎' },
];

async function open(browser, opts) {
  const ctx = await browser.newContext({ timezoneId: 'Asia/Tokyo' });
  await ctx.addInitScript(o => { try { if (o.key) localStorage.setItem('tg_staff_key', 'k'); sessionStorage.setItem('tg_access_v1', 'ok'); if (o.admin) sessionStorage.setItem('tg_role_v1', 'admin'); } catch (e) {} }, opts || {});
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date('2026-10-11T03:00:00Z'));
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const st = { writes: [], flags: [], failFlag: false, custNow: null, prompts: [] };
  page.on('dialog', d => { if (d.type() === 'prompt') { const a = st.prompts.length ? st.prompts.shift() : ''; return a === null ? d.dismiss() : d.accept(a); } d.accept(); });
  await page.route('**/rest/v1/**', async rt => {
    const req = rt.request(); const url = decodeURIComponent(req.url()); const m = req.method();
    const J = (x, s) => rt.fulfill({ status: s || 200, contentType: 'application/json', body: JSON.stringify(x) });
    if (m !== 'GET') st.writes.push({ m, url, body: req.postData() });
    if (/\/data_flags\b/.test(url)) { if (m === 'POST') { if (st.failFlag) return rt.fulfill({ status: 500, body: '{"message":"boom"}' }); st.flags.push(JSON.parse(req.postData())); return J([{}], 201); } return J([]); }
    if (/\/individuals\b/.test(url)) return J(INDS);
    if (/\/inventory\b/.test(url)) return J(INV);
    if (/\/hunters\b/.test(url)) return J(HUNTERS);
    if (/\/orders\b/.test(url)) return J(ORDS);
    if (/\/customers\b/.test(url)) {
      if (m === 'PATCH') return J([{}]);
      if (/id=eq\./.test(url)) { const id = url.match(/id=eq\.([^&]+)/)[1]; const c = { ...CUSTS.find(x => x.id === id), ...(st.custNow || {}) }; return J([c]); }
      return J(CUSTS);
    }
    if (/rpc\/staff_key_ok/.test(url)) return J(true);
    return J([]);
  });
  await page.goto('file://' + path.resolve(__dirname, '../../index.html'));
  await page.waitForTimeout(800);
  st.writes = [];
  await page.evaluate(() => { document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active')); document.getElementById('panel-clerk').classList.add('active'); });
  return { page, ctx, errors, st };
}
const txt = (page, sel) => page.$eval(sel, e => e.textContent.replace(/\s+/g, ' '));

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const results = []; const ck = (n, c, g) => results.push([n, !!c, g == null ? '' : String(g)]);

  // ① 精肉
  {
    const { page, ctx, errors, st } = await open(browser, { key: true });
    ck('「事務作業」の入口がナビにある', await page.$('.tab-btn[data-tab="clerk"]') !== null, '');
    await page.evaluate(() => clerkShow('meat')); await page.waitForTimeout(400);
    const g = await page.evaluate(() => ({ done0: clkData.meat.done0.map(i => i.label_id), none: clkData.meat.none.map(i => i.label_id), noflag: clkData.meat.noflag.map(i => i.label_id) }));
    ck('① 3つに分ける（完了・部位0＝T901／部位0・判定不能＝T902／部位あり・未完了＝T903）。正常なT904は出さない。加工品(tier3)は部位に数えない',
      JSON.stringify(g) === JSON.stringify({ done0: ['TGC-08-T901'], none: ['TGC-08-T902'], noflag: ['TGC-08-T903'] }), JSON.stringify(g));
    const t = await txt(page, '#clk-body');
    ck('① 「判定できません」と書き、未記録と断定しない。歩留まりで足りないと判断しない旨を出す', /記録だけでは判定できません/.test(t) && /歩留まりで「足りない」とは判断しません/.test(t) && /熟成中かも/.test(t), '');
    ck('① 画面を開いただけでは何も書き込まない', st.writes.length === 0, JSON.stringify(st.writes));

    // 要確認
    st.prompts = ['通帳の口座 1234567 を確認'];
    await page.evaluate(() => clkFlag('TGC-08-T901', '完了印あり・部位の記録0件')); await page.waitForTimeout(200);
    ck('要確認: 6桁以上の数字（口座番号など）は記録しない', st.flags.length === 0, '');
    st.failFlag = true; st.prompts = ['精肉メモに記載なし'];
    await page.evaluate(() => clkFlag('TGC-08-T901', '完了印あり・部位の記録0件')); await page.waitForTimeout(300);
    ck('要確認: 保存に失敗したら件数に数えない（画面に出す）', (await page.evaluate(() => clkStats.flags.length)) === 0 && /記録できませんでした/.test(await page.$eval('#toasts', e => e.textContent)), '');
    st.failFlag = false; st.prompts = ['精肉メモに記載なし'];
    await page.evaluate(() => clkFlag('TGC-08-T901', '完了印あり・部位の記録0件')); await page.waitForTimeout(300);
    ck('要確認: 既存の気になる点フラグに「未対応」で記録（作業者名つき）', st.flags.length === 1 && st.flags[0].target === 'TGC-08-T901' && st.flags[0].status === '未対応' && /【事務作業】完了印あり・部位の記録0件／精肉メモに記載なし/.test(st.flags[0].comment), JSON.stringify(st.flags[0]));
    await page.evaluate(() => clkCheck('meat:TGC-08-T902', true));
    ck('pageerrorなし（①）', errors.length === 0, errors.join(' / '));

    // 日報（同じ端末の続き）
    await page.evaluate(() => clerkShow('report')); await page.waitForTimeout(200);
    const rep = await page.$eval('#clk-report', e => e.value);
    ck('日報: 作業内容／確認件数／更新件数／要確認（対象と理由）／次回の続き', /【作業内容】精肉の記録の確認（1件）/.test(rep) && /【確認件数】1件/.test(rep) && /【更新件数】0件/.test(rep) && /・TGC-08-T901: 完了印あり・部位の記録0件/.test(rep) && /【次回の続き】/.test(rep), rep);
    await page.evaluate(() => { window.__c = null; navigator.clipboard.writeText = t => { window.__c = t; return Promise.resolve(); }; document.getElementById('clk-report').value += '\n口座 0123456'; clkReportCopy(); });
    ck('日報: 口座番号らしい数字があるとコピーさせない', (await page.evaluate(() => window.__c)) === null, '');
    await page.evaluate(() => { document.getElementById('clk-report').value = document.getElementById('clk-report').value.replace('\n口座 0123456', ''); clkReportCopy(); });
    await page.waitForTimeout(100);
    ck('日報: 消せばコピーできる（日付の20261011は口座番号と見なさない）', !!(await page.evaluate(() => window.__c)), '');
    await ctx.close();
  }

  // ② 顧客（スタッフキーなし＝権限外）
  {
    const { page, ctx, st } = await open(browser, { key: false });
    st.prompts = [null];
    await page.evaluate(() => clerkShow('cust')); await page.waitForTimeout(400);
    ck('② スタッフキーが無ければ顧客名簿を読まない（権限外）', /スタッフキーが必要/.test(await txt(page, '#clk-body')) && !(await page.evaluate(() => (clkData.cust || []).length)), '');
    await ctx.close();
  }
  {
    const { page, ctx, errors, st } = await open(browser, { key: true, admin: true });
    await page.evaluate(() => clerkShow('cust')); await page.waitForTimeout(500);
    const rows = await page.evaluate(() => clkData.cust.map(r => ({ code: r.c.code, miss: r.miss, dup: r.dup.length, diff: !!r.diff })));
    const R = c => rows.find(r => r.code === c) || {};
    ck('② ふりがな空欄（C9001）・郵便番号なし（C9002）・住所と電話の空欄（C9003）', R('C9001').miss.join() === 'ふりがな' && R('C9002').miss.join() === '郵便番号' && R('C9003').miss.join() === '住所,電話', JSON.stringify(rows));
    ck('② 重複の候補: 同じ電話（表記違い）・同じ名前の C9001⇔C9002', R('C9001').dup >= 1 && R('C9002').dup >= 1, JSON.stringify(rows));
    ck('② 注文の届け先と名簿の住所が違う（C9004）は候補に出す。問題のないC9005は出さない', R('C9004').diff === true && !rows.some(r => r.code === 'C9005'), JSON.stringify(rows));
    ck('② 一覧を出しただけでは何も書き込まない（自動上書き・自動統合しない）', st.writes.length === 0, JSON.stringify(st.writes));
    // 編集 → 同時編集で止まる
    await page.evaluate(() => clkCustEdit('u1')); await page.waitForTimeout(300);
    await page.fill('#cst-f-kana', 'てすとしょくどう');
    st.custNow = { phone: '0470-00-0000' };   // 開いた後に別の人が電話を変えた
    await page.evaluate(() => custRegSave()); await page.waitForTimeout(300);
    ck('② 同時編集: 開いた後に別の人が変えていたら上書きしない', !st.writes.some(w => w.m === 'PATCH') && /別の人が「phone」を変更/.test(await page.$eval('#toasts', e => e.textContent)), JSON.stringify(st.writes));
    st.custNow = null;
    await page.evaluate(() => clkCustEdit('u1')); await page.waitForTimeout(300);
    await page.fill('#cst-f-kana', 'てすとしょくどう');
    await page.evaluate(() => custRegSave()); await page.waitForTimeout(400);
    const pw = st.writes.filter(w => w.m === 'PATCH');
    ck('② 通常の保存は1回だけ・ふりがなが入る・日報の更新件数に数える', pw.length === 1 && /id=eq\.u1/.test(pw[0].url) && JSON.parse(pw[0].body).kana === 'てすとしょくどう' && (await page.evaluate(() => clkStats.updated)) === 1, JSON.stringify(pw));
    ck('pageerrorなし（②）', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  // ③ 捕獲者
  {
    const { page, ctx, errors, st } = await open(browser, { key: true });
    await page.evaluate(() => clerkShow('hunt')); await page.waitForTimeout(400);
    const rows = await page.evaluate(() => clkData.hunt.map(r => ({ name: r.h.name, miss: r.miss, fmt: r.fmt })));
    const R = n => rows.find(r => r.name === n) || {};
    ck('③ 先頭0の7桁（0123456）は正常として出さない', !rows.some(r => r.name === '猟師一郎'), JSON.stringify(rows));
    ck('③ ふりがな空欄・口座番号が6桁（猟師二郎）', R('猟師二郎').miss.join() === 'ふりがな' && /口座番号が6桁/.test(R('猟師二郎').fmt.join()), JSON.stringify(R('猟師二郎')));
    ck('③ 振込先が全部空欄（猟師三郎）', R('猟師三郎').miss.join() === '振込先（全部）', JSON.stringify(R('猟師三郎')));
    ck('③ 口座種別が普通・当座以外／名義がカナ以外（猟師四郎）', /口座種別/.test(R('猟師四郎').fmt.join()) && /口座名義がカナ以外/.test(R('猟師四郎').fmt.join()), JSON.stringify(R('猟師四郎')));
    const body = await txt(page, '#clk-body');
    ck('③ 口座番号を画面に出さない', !/0123456|123456|7654321/.test(body), '');
    ck('③ 振込先を変える入力欄・編集ボタンが無い（責任者が捕獲者台帳で入力）', !(await page.$('#clk-body input:not([type=checkbox])')) && !/>編集</.test(await page.$eval('#clk-body', e => e.innerHTML)) && /この画面からは変更できません/.test(body), '');
    ck('③ 何も書き込まない', st.writes.length === 0, JSON.stringify(st.writes));
    ck('pageerrorなし（③）', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  let pass = 0;
  for (const [n, ok, g] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (g ? '  [' + g + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  await browser.close();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
