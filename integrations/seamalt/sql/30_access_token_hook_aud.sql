-- ============================================================================
-- Supabase Auth「Custom Access Token Hook」で、シーモルト（ChatGPT）向けの OAuth トークンだけ aud を MCP の URL にする
-- 状態: 【案・本番未適用】10_order_link.sql の後に適用し、ダッシュボード Authentication > Hooks で有効化する（本人の承認後）
-- ============================================================================
-- なぜ: OpenAI 公式は「resource（MCP の URL）をトークンの aud に入れ、MCP は aud を検証」を求める。
--       Supabase OAuth サーバーは aud=authenticated 固定で resource を反映しない（2026-10 時点の公式ドキュメント）。
--       Custom Access Token Hook は OAuth を含む全トークン発行で呼ばれ、client_id を受け取れる（公式ドキュメントに aud 変更の例あり）。
-- 方針: 許可リスト（order_link.oauth_audiences）に載った client_id のトークンだけ aud を差し替える。
--       それ以外（通常のログイン・他のクライアント）は一切変えない。
-- 制約（ドキュメントで確認できた範囲）:
--   * フックには resource パラメータは渡らない → client_id で決める。DCR の client_id は接続して初めて決まるため、
--     接続 → client_id を確認 → この表に1行入れる → 再接続、の順になる。
--   * フックが例外を出すと「全員の」トークン発行が失敗する。本番の Supabase Auth 利用者は本人1名のみ（2026-10-03 確認）で
--     業務画面は Supabase Auth を使っていないため、失敗の影響は本人のログインと OAuth に限られる。
--   * aud を変えたトークンを PostgREST（/rest/v1）が受け付けるかは未確認。受け付けない場合、
--     シーモルト用トークンでは REST を直接叩けない（むしろ望ましい）。
begin;

create table if not exists order_link.oauth_audiences (
  client_id   text primary key,                 -- 接続後に Supabase の OAuth クライアント一覧で確認した ChatGPT の client_id
  aud         text not null check (aud ~ '^https://'),
  note        text,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
alter table order_link.oauth_audiences enable row level security;
revoke all on order_link.oauth_audiences from public, anon, authenticated, seamalt_mcp;

create or replace function order_link.access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = order_link, pg_temp
as $$
declare
  v_claims jsonb := coalesce(event->'claims', '{}'::jsonb);
  v_client text := coalesce(event->>'client_id', v_claims->>'client_id');
  v_aud text;
begin
  if v_client is not null then
    select a.aud into v_aud from order_link.oauth_audiences a where a.client_id = v_client and a.revoked_at is null;
    if v_aud is not null then
      v_claims := jsonb_set(v_claims, '{aud}', to_jsonb(v_aud));
    end if;
  end if;
  return jsonb_build_object('claims', v_claims);
end $$;

-- Supabase Auth はフックを supabase_auth_admin で呼ぶ。それ以外には実行させない
revoke all on function order_link.access_token_hook(jsonb) from public, anon, authenticated, seamalt_mcp;
grant usage on schema order_link to supabase_auth_admin;
grant execute on function order_link.access_token_hook(jsonb) to supabase_auth_admin;
grant select on order_link.oauth_audiences to supabase_auth_admin;
create policy oauth_audiences_auth_admin_read on order_link.oauth_audiences for select to supabase_auth_admin using (true);

commit;
-- 有効化（本人がダッシュボードで）: Authentication > Hooks > Customize Access Token (JWT) Claims → Postgres → order_link.access_token_hook
-- 接続後: insert into order_link.oauth_audiences(client_id, aud, note)
--         values ('<ChatGPTのclient_id>', 'https://clpdyrehdgzgiidbfucj.supabase.co/functions/v1/seamalt-mcp/mcp', 'シーモルト');
-- MCP 側: SEAMALT_AUDIENCES を MCP の URL だけにする（authenticated を外す）
-- 戻し方: ダッシュボードでフックを無効化（表と関数は残してよい）。または update … set revoked_at = now()
