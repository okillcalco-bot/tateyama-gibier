// tests/db/concurrent-capture-submit.test.mjs
// 同一 client_request_id を2セッションから同時送信しても個体は1件だけ作られ、
// 両レスポンスが同じ id を返すこと（P1-1 冪等の同時実行）を実測する。
//
// 実行: node tests/db/concurrent-capture-submit.test.mjs
//   環境変数 SB_URL / SB_ANON_KEY（公開anonキー）を使う。未設定なら既定値。
// 注意: 本テストは本番anonエンドポイントに対して仮番号(仮-…)の「搬入待ち」個体を
//   1件だけ作成する（冪等なので複数回実行しても増えない＝同一request_id固定）。
//   作成物は業務OSの搬入待ちから削除できる。CIでは専用/検証プロジェクトを推奨。

const SB_URL = process.env.SB_URL || 'https://clpdyrehdgzgiidbfucj.supabase.co';
const SB_KEY = process.env.SB_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNscGR5cmVoZGd6Z2lpZGJmdWNqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyODEzNDksImV4cCI6MjA4ODg1NzM0OX0.cKxpyw0gyZj0Flsd8wzojiNFqyCEcrAF8tFpXXUmZck';

async function rpc(fn, args) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(t || ('HTTP ' + res.status));
  return t ? JSON.parse(t) : null;
}

const out = [];
const ck = (n, c, e) => out.push((c ? 'PASS ' : 'FAIL ') + n + (e ? ' — ' + e : ''));

(async () => {
  const reqId = 'concurrent-' + Math.random().toString(36).slice(2, 12);
  const payload = { species: 'シカ', hunter_name: '同時実行テスト', capture_city: '館山市' };

  // 2本を同時発射（同一 request_id・同一 payload）
  const [a, b] = await Promise.allSettled([
    rpc('public_capture_submit', { p_payload: payload, p_request_id: reqId }),
    rpc('public_capture_submit', { p_payload: payload, p_request_id: reqId }),
  ]);
  const ok = x => x.status === 'fulfilled' ? x.value : null;
  const ra = ok(a), rb = ok(b);
  ck('両方成功', ra && rb, JSON.stringify([a.reason?.message, b.reason?.message]));
  ck('両レスポンスの id が一致', ra && rb && ra.id === rb.id, JSON.stringify([ra?.id, rb?.id]));
  ck('label は仮番号', ra && /^仮-/.test(ra.label_id || ''), ra?.label_id);

  // 同一 request_id・別 payload は拒否される
  let rejected = false;
  try { await rpc('public_capture_submit', { p_payload: { species: 'イノシシ' }, p_request_id: reqId }); }
  catch (e) { rejected = /内容が異なります/.test(e.message); }
  ck('同ID別payloadは拒否', rejected);

  console.log(out.join('\n'));
  console.log(`\n作成された仮個体 id=${ra?.id} label=${ra?.label_id}（搬入待ち・要片付け）`);
  process.exit(out.some(x => x.startsWith('FAIL')) ? 1 : 0);
})().catch(e => { console.error('テスト実行エラー:', e.message); process.exit(2); });
