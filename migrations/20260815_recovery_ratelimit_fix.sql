-- 20260815_recovery_ratelimit_fix.sql
-- Codex再レビュー P0-1: admin_rotate_staff_key の回復コード試行制限が
-- 20260815_staff_device_tokens.sql の CREATE OR REPLACE で消えていた不具合を修復。
-- （回復コードを無制限に試せる状態だった。本番先行適用する。）
--
-- 追加のみ。適用済みマイグレーションは編集せず CREATE OR REPLACE で修復。
-- ロールバック: migrations/rollback/20260815_recovery_ratelimit_fix_rollback.sql

-- ── スタッフキー照合: 直列化＋5分10回制限（失敗記録を残す＝falseで返す） ──
create or replace function staff_key_ok(p_staff_key text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_ok boolean; v_fail int;
begin
  -- 同時試行でも回数制限を突破させない（このtxがコミットするまで他は待つ）
  perform pg_advisory_xact_lock(hashtext('auth:staff_key'));
  select count(*) into v_fail from auth_attempts
   where kind = 'staff_key' and not ok and created_at > now() - interval '5 minutes';
  if v_fail >= 10 then
    insert into auth_attempts (kind, ok) values ('staff_key', false);   -- 記録は残す
    return false;                                                        -- 例外で巻き戻さない
  end if;
  select hash into v_hash from app_secrets where key = 'staff_key';
  v_ok := v_hash is not null and v_hash = extensions.crypt(coalesce(p_staff_key,''), v_hash);
  insert into auth_attempts (kind, ok) values ('staff_key', v_ok);
  return v_ok;
end;
$$;
revoke all on function staff_key_ok(text) from public;
grant execute on function staff_key_ok(text) to anon, authenticated;

-- ── スタッフキー変更: 回復コード15分5回制限＋直列化＋全端末失効（同一tx） ──
create or replace function admin_rotate_staff_key(p_recovery_code text, p_new_key text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_fail int; v_revoked int;
begin
  -- 同時リクエストでも5回制限を突破できないよう直列化
  perform pg_advisory_xact_lock(hashtext('auth:recovery'));

  select count(*) into v_fail from auth_attempts
   where kind = 'recovery' and not ok and created_at > now() - interval '15 minutes';
  if v_fail >= 5 then
    insert into security_events (event, detail) values ('recovery_locked', '15分以内に5回失敗');
    return false;   -- 記録を残す（例外でロールバックしない）
  end if;

  select hash into v_hash from app_secrets where key = 'recovery_code';
  if v_hash is null or v_hash <> extensions.crypt(coalesce(p_recovery_code,''), v_hash) then
    insert into auth_attempts (kind, ok) values ('recovery', false);
    insert into security_events (event) values ('recovery_failed');
    return false;   -- 記録を残す
  end if;
  insert into auth_attempts (kind, ok) values ('recovery', true);

  if length(coalesce(p_new_key,'')) < 16 then
    raise exception '新しいスタッフキーは16文字以上にしてください';
  end if;

  -- キー変更と全端末失効を同一トランザクションで（途中失敗は全ロールバック）
  update app_secrets
     set hash = extensions.crypt(p_new_key, extensions.gen_salt('bf')), updated_at = now()
   where key = 'staff_key';
  insert into app_secrets (key, hash)
  values ('staff_key_sha256', encode(extensions.digest(p_new_key, 'sha256'), 'hex'))
  on conflict (key) do update set hash = excluded.hash, updated_at = now();

  v_revoked := staff_devices_revoke_all();

  insert into security_events (event, detail)
  values ('staff_key_rotated', '回復コードによる変更。全端末トークン失効(' || v_revoked || ')。全端末で再認証が必要');
  return true;
end;
$$;
revoke all on function admin_rotate_staff_key(text, text) from public;
grant execute on function admin_rotate_staff_key(text, text) to anon, authenticated;
