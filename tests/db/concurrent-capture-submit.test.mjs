// tests/db/concurrent-capture-submit.test.mjs
// Codex 4巡目 P1-4 (8): 同一 client_request_id を2セッションから同時送信しても個体は1件だけ・
// 両レスポンス同一id、同ID別payloadは拒否（冪等の同時実行）。
// 実行後は service_role で individuals/individual_audit/request_log/submission_tokens を完全清掃し、
// 残骸ゼロを実測する（論理削除では「残骸ゼロ」としない）。
//
// 実行前提（本番を接続先にしない・テスト専用プロジェクトを使う）: 次を全て明示指定すること。
//   TG_TEST_URL         … Supabase URL（テスト/検証プロジェクト）
//   TG_TEST_ANON_KEY    … anon キー（公開登録の実クライアント想定）
//   TG_TEST_STAFF_TOKEN … dt_ 端末トークン（スタッフ経路の確認・任意操作用）
//   TG_TEST_SERVICE_KEY … service_role キー（計数と完全清掃に使用。テスト専用環境のみ）
// いずれか未設定なら「SKIP」（PASSとしては扱わない）。
// 本番プロジェクト ref を検出したら「REFUSE」で異常終了する。

const URL = process.env.TG_TEST_URL;
const ANON = process.env.TG_TEST_ANON_KEY;
const STAFF = process.env.TG_TEST_STAFF_TOKEN;
const SERVICE = process.env.TG_TEST_SERVICE_KEY;
const PROD_REF = 'clpdyrehdgzgiidbfucj';   // 館山ジビエ本番。テストで接続先にしてはならない。

// 本番 ref は明示拒否（誤って本番へ service_role で清掃をかけない）
if (URL && URL.includes(PROD_REF)) {
  console.error(`REFUSE: 本番プロジェクト(${PROD_REF})はこのテストの接続先にできません。`);
  process.exit(3);
}
// 必須環境変数（STAFF・SERVICE含む）が欠けたら実行しない。SKIP は PASS ではない。
const missing = ['TG_TEST_URL', 'TG_TEST_ANON_KEY', 'TG_TEST_STAFF_TOKEN', 'TG_TEST_SERVICE_KEY']
  .filter(k => !process.env[k]);
if (missing.length) {
  console.log('SKIP: 未設定の環境変数のため実行しません（SKIP≠PASS）: ' + missing.join(', '));
  process.exit(0);
}

const anonH = { apikey: ANON, Authorization: `Bearer ${ANON}`, 'Content-Type': 'application/json' };
const svcH = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json' };

async function rpc(fn, args, headers = anonH) {
  const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
  const t = await r.text(); if (!r.ok) throw new Error(t || ('HTTP ' + r.status)); return t ? JSON.parse(t) : null;
}
async function svcCount(pathAndQuery) {
  const r = await fetch(`${URL}/rest/v1/${pathAndQuery}`, { headers: { ...svcH, Prefer: 'count=exact' } });
  const t = await r.json(); return Array.isArray(t) ? t.length : 0;
}
async function svcDelete(pathAndQuery) {
  await fetch(`${URL}/rest/v1/${pathAndQuery}`, { method: 'DELETE', headers: svcH });
}
const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));

(async () => {
  const reqId = 'concurrent-' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  const payload = { species: 'シカ', hunter_name: '同時実行テスト', capture_city: '館山市' };
  let iid = null, label = null;
  try {
    const [a, b] = await Promise.allSettled([
      rpc('public_capture_submit', { p_payload: payload, p_request_id: reqId }),
      rpc('public_capture_submit', { p_payload: payload, p_request_id: reqId }),
    ]);
    const va = a.status === 'fulfilled' ? a.value : null;
    const vb = b.status === 'fulfilled' ? b.value : null;
    ck('両方成功', !!(va && vb), JSON.stringify([a.reason?.message, b.reason?.message]));
    ck('両レスポンスの id が一致', !!(va && vb && va.id === vb.id), JSON.stringify([va?.id, vb?.id]));
    iid = va?.id; label = va?.label_id;
    ck('label は仮番号', /^仮-/.test(label || ''), label);

    // service_role で実測: individuals=1 / audit=1 / request_log=1
    ck('individuals は1件だけ作成', (await svcCount(`individuals?id=eq.${iid}&select=id`)) === 1, iid);
    ck('individual_audit は1件（submit）', (await svcCount(`individual_audit?target_id=eq.${iid}&action=eq.submit&select=id`)) === 1, iid);
    ck('request_log は1件（同一reqId）', (await svcCount(`request_log?client_request_id=eq.${encodeURIComponent(reqId)}&select=client_request_id`)) === 1, reqId);

    let rejected = false;
    try { await rpc('public_capture_submit', { p_payload: { species: 'イノシシ' }, p_request_id: reqId }); }
    catch (e) { rejected = /内容が異なります/.test(e.message); }
    ck('同ID別payloadは拒否', rejected);
  } finally {
    // service_role で完全清掃（論理削除ではなく物理削除）
    if (iid) {
      await svcDelete(`submission_tokens?individual_id=eq.${iid}`);
      await svcDelete(`individual_audit?target_id=eq.${iid}`);
      await svcDelete(`request_log?client_request_id=eq.${encodeURIComponent(reqId)}`);
      await svcDelete(`individuals?id=eq.${iid}`);
      // 残骸ゼロを実測
      const rem =
        (await svcCount(`individuals?id=eq.${iid}&select=id`)) +
        (await svcCount(`individual_audit?target_id=eq.${iid}&select=id`)) +
        (await svcCount(`submission_tokens?individual_id=eq.${iid}&select=id`)) +
        (await svcCount(`request_log?client_request_id=eq.${encodeURIComponent(reqId)}&select=client_request_id`));
      ck('清掃後の残骸ゼロ（individuals/audit/request_log/submission_tokens）', rem === 0, 'remaining=' + rem);
    }
  }

  console.log(out.join('\n'));
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.error('テスト実行エラー:', e.message); process.exit(2); });
