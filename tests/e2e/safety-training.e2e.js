// 安全・衛生（マダニ対策）教育モジュール — manual-app.html
//
//   きっかけ（2026-09-07）
//     スタッフ向け「マダニ安全教育」機能の追加指示書に基づき、manual-app.html に
//     新画面「安全・衛生」を追加した（教材／今日のチェック／見つけたら／理解チェック）。
//     受講記録は training_completions テーブルに RPC 経由でのみ書き込む
//     （anon から直接テーブルへは読み書きできない設計）。
//
//   ここで測ること
//     1. ホームから「安全・衛生」画面に遷移できる
//     2. 4つのタブが切り替わる
//     3. 「今日のチェック」のチェックは各グループ独立に、当日の日付キーで
//        localStorage に保存される
//     4. 「見つけたら」画面に医療機関判断の免責文言が必ず表示される
//     5. 理解チェック：全問回答するまで受講完了ボタンは押せない、
//        正解数が正しく数えられる
//     6. 氏名を選ぶと training_my_completions が呼ばれ、既受講なら
//        バナーに反映される
//     7. 受講完了ボタンで training_submit_completion が正しい本文
//        （module_slug/module_version/staff_name/score/total_questions）で呼ばれる
//     8. 通信に失敗しても画面が壊れず、失敗が画面上に表示される（サイレント失敗にしない）
//     9. 既存の他画面（現場ルール・ジビエ弁当）が退行していない
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const path = require('path');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const results = [];
  const t = (name, ok, got) => results.push([name, ok, got]);

  const browser = await chromium.launch({ executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

  // ── ページ1: 通常系（スタッフ一覧・受講履歴取得は成功） ──────────
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const rpcCalls = [];

    // Playwright はルートを「後から登録したものほど先に評価する」ため、
    // 汎用の catch-all を先に登録し、個別モックを後から登録して優先させる。
    await page.route('**/*', route => {
      const u = route.request().url();
      if (u.startsWith('file:')) return route.continue();
      if (u.includes('/rest/v1/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    });
    await page.route('**/rest/v1/staff*', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
        { id: 's1', name: '今泉貴雄' }, { id: 's2', name: '沖浩志' },
      ]) }));
    await page.route('**/rest/v1/rpc/**', async route => {
      const fn = route.request().url().split('/rpc/')[1].split('?')[0];
      let body = {}; try { body = JSON.parse(route.request().postData() || '{}'); } catch (e) {}
      rpcCalls.push({ fn, body });
      if (fn === 'training_my_completions') {
        if (body.p_staff_name === '今泉貴雄') {
          return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
            { module_slug: 'tick-safety', module_version: '1.0', score: 3, total_questions: 4, completed_at: '2026-09-01 10:00' },
          ]) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
      if (fn === 'training_submit_completion') {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, id: 'new-id' }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('file://' + path.join(root, 'manual-app.html'));
    await page.waitForTimeout(300);

    // 1. ホームから遷移できる
    await page.click('.home-card >> text=安全・衛生（マダニ対策）');
    await page.waitForTimeout(100);
    t('安全画面がactiveになる', await page.$eval('#safety', el => el.classList.contains('active')));

    // 2. タブ切り替え
    await page.click('#safetyTabs .tab-btn:nth-child(2)');
    t('タブ1（今日のチェック）に切り替わる', await page.$eval('#safety-1', el => el.classList.contains('active')));
    t('タブ0（教材）は非activeになる', await page.$eval('#safety-0', el => !el.classList.contains('active')));

    // 3. チェックリストの保存
    const beforeBoxes = await page.$$('#sfChkBefore input[type=checkbox]');
    t('作業前チェックが3件描画される', beforeBoxes.length === 3, String(beforeBoxes.length));
    await page.check('#sfc-before-0');
    const savedBefore = await page.evaluate(() => {
      const d = new Date();
      const ymd = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
      return JSON.parse(localStorage.getItem(`tg_safety_chk_before_${ymd}`) || '{}');
    });
    t('チェックが当日キーでlocalStorageに保存される', savedBefore['0'] === true, JSON.stringify(savedBefore));
    const duringChecked = await page.$eval('#sfc-during-0', el => el.checked);
    t('別グループ（作業中）のチェックには影響しない', duringChecked === false);

    // 4. 見つけたら画面の免責文言
    await page.click('#safetyTabs .tab-btn:nth-child(3)');
    const emText = await page.$eval('#safety-2', el => el.textContent);
    t('「診断を行うものではありません」の文言がある', emText.includes('診断を行うものではありません'));
    t('「医療機関」への言及がある', emText.includes('医療機関'));
    await page.click('.em-btn >> text=まだ皮膚に付いている（吸着中）');
    t('吸着中の詳細が開く', await page.$eval('#sfEm0', el => el.classList.contains('active')));
    t('「無理に引き抜かない」の案内がある', emText.includes('無理に引き抜かない') || (await page.$eval('#sfEm0', el => el.textContent)).includes('無理に引き抜かない'));

    // 5. 理解チェック：全問回答するまで送信不可
    await page.click('#safetyTabs .tab-btn:nth-child(4)');
    let btnDisabled = await page.$eval('#sfSubmitBtn', el => el.disabled);
    t('氏名未選択の時点では受講完了ボタンは無効', btnDisabled === true);

    await page.selectOption('#sfStaffName', '今泉貴雄');
    await page.waitForTimeout(150);
    t('training_my_completionsが選んだ氏名で呼ばれる',
      rpcCalls.some(c => c.fn === 'training_my_completions' && c.body.p_staff_name === '今泉貴雄'));
    const statusText = await page.$eval('#sfMyStatus', el => el.textContent);
    t('既受講なら受講済みバナーが出る', statusText.includes('受講済み') && statusText.includes('1.0'), statusText);

    const quizOpts = await page.$$('#sfQuizList .quiz-card');
    t('クイズが4問描画される', quizOpts.length === 4, String(quizOpts.length));

    btnDisabled = await page.$eval('#sfSubmitBtn', el => el.disabled);
    t('回答前は受講完了ボタンが無効', btnDisabled === true);

    // 正解2問・不正解2問を選ぶ（各設問の1番目=正解番号なので、0/1問目は正解、2/3問目はわざと不正解にする）
    await page.click('#sfOpt0 button:nth-child(1)'); // 正解
    await page.click('#sfOpt1 button:nth-child(1)'); // 正解
    await page.click('#sfOpt2 button:nth-child(2)'); // 不正解
    await page.click('#sfOpt3 button:nth-child(2)'); // 不正解
    btnDisabled = await page.$eval('#sfSubmitBtn', el => el.disabled);
    t('全問回答後は受講完了ボタンが有効になる', btnDisabled === false);

    // 二重回答できない（クリック済みの設問は再選択不可）
    const opt0Disabled = await page.$$eval('#sfOpt0 button', bs => bs.every(b => b.disabled));
    t('回答済みの設問はボタンが無効化される', opt0Disabled === true);

    // 7. 受講完了の送信
    await page.click('#sfSubmitBtn');
    await page.waitForTimeout(150);
    const submitCall = rpcCalls.find(c => c.fn === 'training_submit_completion');
    t('training_submit_completionが呼ばれる', !!submitCall);
    if (submitCall) {
      t('module_slugがtick-safety', submitCall.body.p_module_slug === 'tick-safety', submitCall.body.p_module_slug);
      t('module_versionが1.0', submitCall.body.p_module_version === '1.0', submitCall.body.p_module_version);
      t('staff_nameが選んだ氏名', submitCall.body.p_staff_name === '今泉貴雄', submitCall.body.p_staff_name);
      t('total_questionsが4', submitCall.body.p_total_questions === 4, String(submitCall.body.p_total_questions));
      t('scoreが正解数(2)と一致', submitCall.body.p_score === 2, String(submitCall.body.p_score));
    }
    const msgText = await page.$eval('#sfSubmitMsg', el => el.textContent);
    t('保存成功メッセージが出る', msgText.includes('保存しました'), msgText);

    // 9. 既存画面の回帰確認
    await page.click('#safety .back-btn');
    await page.click('.home-card >> text=現場ルール・改善履歴');
    t('現場ルール画面は引き続き開ける', await page.$eval('#rules', el => el.classList.contains('active')));
    await page.click('#rules .back-btn');
    await page.click('.home-card >> text=ジビエ弁当づくり');
    t('ジビエ弁当画面は引き続き開ける', await page.$eval('#bento', el => el.classList.contains('active')));

    t('ページエラーが無い（通常系）', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  // ── ページ2: 通信失敗系（サイレント失敗にしないことの確認） ──────
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));

    await page.route('**/*', route => {
      const u = route.request().url();
      if (u.startsWith('file:')) return route.continue();
      if (u.includes('/rest/v1/')) return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
    });
    await page.route('**/rest/v1/staff*', route => route.fulfill({ status: 500, body: 'error' }));
    await page.route('**/rest/v1/rpc/**', route => route.fulfill({ status: 500, body: 'error' }));

    await page.goto('file://' + path.join(root, 'manual-app.html'));
    await page.waitForTimeout(300);
    await page.click('.home-card >> text=安全・衛生（マダニ対策）');
    await page.waitForTimeout(200);

    // スタッフ一覧が取れなくても画面は開いたまま、失敗が表示される
    await page.click('#safetyTabs .tab-btn:nth-child(4)');
    const failStatus = await page.$eval('#sfMyStatus', el => el.textContent);
    t('スタッフ一覧取得失敗が画面に表示される', failStatus.includes('読み込めませんでした'), failStatus);

    t('通信失敗時もページエラーは起きない', errors.length === 0, errors.join(' / '));
    await ctx.close();
  }

  await browser.close();
  let pass = 0;
  for (const [n, ok, got] of results) { console.log((ok ? 'PASS' : 'FAIL') + ' : ' + n + (got ? '  [' + got + ']' : '')); if (ok) pass++; }
  console.log(`\n${pass}/${results.length} passed`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
