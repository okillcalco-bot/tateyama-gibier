// tests/db/concurrent-capture-submit.test.mjs
// 同一 client_request_id を2セッションから同時送信しても個体は1件だけ・両レスポンス同一id、
// 同ID別payloadは拒否（P1-1/冪等の同時実行）。実行後に作成物を後片付けする。
//
// 実行前提（本番を既定接続先にしない）: 次を明示指定すること。
//   TG_TEST_URL       … Supabase URL（例: テスト/検証プロジェクト）
//   TG_TEST_ANON_KEY  … anon キー
//   TG_TEST_STAFF_TOKEN … 後片付け用の dt_ 端末トークン（作成個体を論理削除する）
// いずれか未設定ならスキップ（本番へ誤接続しない）。
//
// 注: individuals は anon で SELECT 可のため件数を実測できる。audit/request_log は RLS の
//     ため anon から検証不可（service_role ランナーで別途）。ここでは individuals=1 を実測する。

const URL = process.env.TG_TEST_URL;
const KEY = process.env.TG_TEST_ANON_KEY;
const STAFF = process.env.TG_TEST_STAFF_TOKEN;
if (!URL || !KEY) {
  console.log('SKIP: TG_TEST_URL / TG_TEST_ANON_KEY 未設定（本番へ誤接続しないためスキップ）');
  process.exit(0);
}
const h = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
async function rpc(fn, args) {
  const r = await fetch(`${URL}/rest/v1/rpc/${fn}`, { method: 'POST', headers: h, body: JSON.stringify(args) });
  const t = await r.text(); if (!r.ok) throw new Error(t || ('HTTP ' + r.status)); return t ? JSON.parse(t) : null;
}
async function selCount(label) {
  const r = await fetch(`${URL}/rest/v1/individuals?label_id=eq.${encodeURIComponent(label)}&select=id`, { headers: h });
  return (await r.json()).length;
}
const out = []; const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));

(async () => {
  const reqId = 'concurrent-' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  const payload = { species: 'シカ', hunter_name: '同時実行テスト', capture_city: '館山市' };
  const [a, b] = await Promise.allSettled([
    rpc('public_capture_submit', { p_payload: payload, p_request_id: reqId }),
    rpc('public_capture_submit', { p_payload: payload, p_request_id: reqId }),
  ]);
  const va = a.status === 'fulfilled' ? a.value : null;
  const vb = b.status === 'fulfilled' ? b.value : null;
  ck('両方成功', va && vb, JSON.stringify([a.reason?.message, b.reason?.message]));
  ck('両レスポンスの id が一致', va && vb && va.id === vb.id, JSON.stringify([va?.id, vb?.id]));
  const label = va?.label_id;
  ck('label は仮番号', /^仮-/.test(label || ''), label);
  ck('individuals は1件だけ作成', (await selCount(label)) === 1, label);

  let rejected = false;
  try { await rpc('public_capture_submit', { p_payload: { species: 'イノシシ' }, p_request_id: reqId }); }
  catch (e) { rejected = /内容が異なります/.test(e.message); }
  ck('同ID別payloadは拒否', rejected);

  // 後片付け（作成個体を論理削除）
  if (STAFF && va?.id) {
    try { await rpc('staff_individual_soft_delete', { p_staff_key: STAFF, p_id: va.id, p_reason: '同時実行テストの後片付け' }); ck('後片付け(論理削除)成功', true); }
    catch (e) { ck('後片付け(論理削除)成功', false, e.message); }
  } else {
    out.push('WARN 後片付けスキップ（TG_TEST_STAFF_TOKEN未設定）。作成した仮個体は手動削除してください: ' + (va?.id || ''));
  }

  console.log(out.join('\n'));
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.error('テスト実行エラー:', e.message); process.exit(2); });
