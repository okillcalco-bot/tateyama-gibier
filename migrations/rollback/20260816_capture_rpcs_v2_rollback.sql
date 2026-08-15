-- rollback of 20260816_capture_rpcs_v2.sql
-- v2で追加した関数・表を撤去し、直前（individuals_write_rpcs + staff_device_tokens +
-- recovery_ratelimit_fix 適用後）の定義へ戻す。
-- 注意: 直前定義は Codex 指摘の脆弱性を含むため、通常はロールバックしないこと。
--
-- 完全復元は次の順で prior マイグレーションのCREATE OR REPLACE群を再適用してもよい:
--   20260815_individuals_write_rpcs.sql → 20260815_staff_device_tokens.sql →
--   20260815_recovery_ratelimit_fix.sql
-- 以下はそれと等価の最小復元＋v2固有オブジェクトの撤去。

-- v2固有の新規関数・表を撤去
drop function if exists staff_capture_intake(text, jsonb, text);
drop function if exists staff_individual_edit(text, uuid, jsonb, text, text);
drop function if exists staff_token_resolve(text);
drop function if exists _idem_begin(text, text, text);
drop function if exists _idem_store(text, text, text, jsonb);
drop function if exists _capture_validate(jsonb);
drop function if exists _reject_unknown_keys(jsonb, text[]);
drop function if exists _issue_submission_token(uuid);
drop function if exists public_capture_update_survey(text, jsonb, text);      -- v2(submission_token)
drop function if exists public_attach_capture_photo(text, text, text, text);  -- v2(object_path)
drop table if exists submission_tokens cascade;

-- request_log を単一PK形へ戻す（v2で作り直した表を撤去して再作成）
drop table if exists request_log cascade;
create table request_log (
  client_request_id text primary key,
  fn text not null,
  result jsonb,
  created_at timestamptz not null default now()
);
alter table request_log enable row level security;

-- _ind_require_staff を void 版へ戻す
drop function if exists _ind_require_staff(text);
create function _ind_require_staff(p_staff_key text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if staff_token_ok(p_staff_key) then return; end if;
  if staff_key_ok(p_staff_key) then return; end if;
  raise exception 'スタッフキーが違います' using errcode = '28000';
end; $$;
revoke all on function _ind_require_staff(text) from public;

-- staff_device_register を接頭辞なしへ戻す
create or replace function staff_device_register(p_staff_key text, p_label text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_token text; v_exp timestamptz;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います' using errcode = '28000'; end if;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_exp := now() + interval '30 days';
  insert into staff_device_tokens (token_sha256, label, expires_at)
  values (encode(extensions.digest(v_token,'sha256'),'hex'), left(coalesce(p_label,''),80), v_exp);
  insert into security_events (event, detail) values ('device_registered', left(coalesce(p_label,''),80));
  return jsonb_build_object('token', v_token, 'expires_at', v_exp);
end; $$;
grant execute on function staff_device_register(text, text) to anon, authenticated;

-- 公開/スタッフ関数を v1（individuals_write_rpcs.sql）へ戻すには当該ファイルの
-- CREATE OR REPLACE 群を再適用すること（本ファイルでは省略：撤去と構造復元のみ）。
