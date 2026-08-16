// auth-gate Edge Function — Codex 4巡目 P0-1
// スタッフキー/回復コード/招待発行の「信頼できる認証境界」。
// ・IP/端末/時間窓で原子的にレート制限（auth_rate_check）してから内部RPCを service_role で呼ぶ。
// ・service_role key はこの関数の実行環境だけが保持し、レスポンス/ログ/クライアントへは一切出さない。
// ・PostgREST 側では staff_key_ok/admin_rotate_staff_key/staff_create_enrollment_token の
//   anon/authenticated EXECUTE を剥奪する（別マイグレーション）。以後ブラウザからは本関数のみ経由可能。
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// action → { scope(レート制限区分), fn(内部RPC名), args(bodyから組み立て) }
type Body = Record<string, unknown>;
const s = (v: unknown, max = 512) => (typeof v === "string" ? v.slice(0, max) : "");

function route(action: string, b: Body): { scope: string; fn: string; args: Record<string, unknown> } | null {
  switch (action) {
    case "staff_key_ok":
      return { scope: "staff_key", fn: "staff_key_ok", args: { p_staff_key: s(b.staff_key) } };
    case "create_enrollment":
      return { scope: "enroll", fn: "staff_create_enrollment_token", args: { p_staff_key: s(b.staff_key), p_label: s(b.label, 80) } };
    case "rotate_key":
      return { scope: "recovery", fn: "admin_rotate_staff_key", args: { p_recovery_code: s(b.recovery_code), p_new_key: s(b.new_key) } };
    default:
      return null;
  }
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<Response> {
  return await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
    },
    body: JSON.stringify(args),
  });
}

function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const action = s(body.action, 40);
  const r = route(action, body);
  if (!r) return json({ error: "unknown action" }, 400);

  const ip = clientIp(req);
  const device = s(body.device, 80) || null;

  // 1) レート制限（成功/失敗に関係なく1試行=1加算）。超過なら内部RPCを呼ばずに429。
  try {
    const rl = await rpc("auth_rate_check", { p_scope: r.scope, p_ip: ip, p_device: device });
    const rlBody = await rl.json().catch(() => null);
    if (!rl.ok) return json({ error: "rate check failed" }, 500);
    if (rlBody && rlBody.allowed === false) {
      return json({ error: "rate_limited", retry_after: rlBody.retry_after ?? 60 }, 429);
    }
  } catch {
    return json({ error: "rate check error" }, 500);
  }

  // 2) 内部RPCを service_role で実行。結果(boolean/object)だけを返す。credentialは返さない。
  try {
    const res = await rpc(r.fn, r.args);
    const data = await res.json().catch(() => null);
    if (!res.ok) return json({ error: "rpc failed" }, 502);
    return json({ result: data });
  } catch {
    return json({ error: "rpc error" }, 500);
  }
});
