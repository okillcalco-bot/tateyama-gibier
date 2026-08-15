-- rollback of 20260815_recovery_ratelimit_fix.sql
-- 直前（20260815_staff_device_tokens.sql 適用後）の定義へ戻す。
-- 注意: この定義は回復コード試行制限が無い状態なので、通常はロールバックしないこと。

create or replace function staff_key_ok(p_staff_key text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_ok boolean;
begin
  select hash into v_hash from app_secrets where key = 'staff_key';
  v_ok := v_hash is not null and v_hash = extensions.crypt(coalesce(p_staff_key,''), v_hash);
  insert into auth_attempts (kind, ok) values ('staff_key', v_ok);
  return v_ok;
end;
$$;
revoke all on function staff_key_ok(text) from public;
grant execute on function staff_key_ok(text) to anon, authenticated;

create or replace function admin_rotate_staff_key(p_recovery_code text, p_new_key text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_revoked int;
begin
  select hash into v_hash from app_secrets where key = 'recovery_code';
  if v_hash is null or v_hash <> extensions.crypt(coalesce(p_recovery_code,''), v_hash) then
    insert into auth_attempts (kind, ok) values ('recovery', false);
    insert into security_events (event) values ('recovery_failed');
    return false;
  end if;
  insert into auth_attempts (kind, ok) values ('recovery', true);
  if length(coalesce(p_new_key,'')) < 16 then
    raise exception '新しいスタッフキーは16文字以上にしてください';
  end if;
  update app_secrets set hash = extensions.crypt(p_new_key, extensions.gen_salt('bf')), updated_at = now() where key = 'staff_key';
  insert into app_secrets (key, hash) values ('staff_key_sha256', encode(extensions.digest(p_new_key, 'sha256'), 'hex'))
  on conflict (key) do update set hash = excluded.hash, updated_at = now();
  v_revoked := staff_devices_revoke_all();
  insert into security_events (event, detail) values ('staff_key_rotated', '回復コードによる変更。全端末トークンを失効(' || v_revoked || ')。全端末で再認証が必要');
  return true;
end;
$$;
grant execute on function admin_rotate_staff_key(text, text) to anon, authenticated;
