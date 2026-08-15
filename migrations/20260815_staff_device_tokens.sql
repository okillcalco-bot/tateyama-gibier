-- 20260815_staff_device_tokens.sql
-- Codexレビュー指摘（端末へスタッフキー平文を永続保存しない）への対応。
--
-- これまで: 端末の localStorage に「生のスタッフキー」を保存していた（漏洩時に
--   マスター鍵そのものが露出。全端末共通で失効もできない）。
-- これから: 初回だけスタッフキーで認証し、以後は「端末トークン」を使う。
--   ・DBには token の sha256 ハッシュのみ保存（平文は保存しない）
--   ・最終利用から30日で失効（スライド式）
--   ・スタッフキー変更時に全端末トークンを一括失効
--   ・端末側から自分のトークンを失効（「この端末の認証を解除」）できる
--
-- 追加のみ・非破壊。既存の staff_key_ok（生キー照合）はそのまま残す。

create table if not exists staff_device_tokens (
  id           uuid primary key default gen_random_uuid(),
  token_sha256 text not null unique,
  label        text,                 -- 端末識別（任意・UA先頭など）
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '30 days',
  revoked_at   timestamptz
);
alter table staff_device_tokens enable row level security;   -- RPC経由のみ
create index if not exists staff_device_tokens_live
  on staff_device_tokens (token_sha256) where revoked_at is null;

-- ── 端末登録: スタッフキーで認証し、トークンを1回だけ返す ──────────────
create or replace function staff_device_register(p_staff_key text, p_label text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_token text; v_exp timestamptz;
begin
  if not staff_key_ok(p_staff_key) then          -- 試行制限つき（既存）
    raise exception 'スタッフキーが違います' using errcode = '28000';
  end if;
  v_token := encode(extensions.gen_random_bytes(32), 'hex');   -- 256bit 乱数
  v_exp := now() + interval '30 days';
  insert into staff_device_tokens (token_sha256, label, expires_at)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), left(coalesce(p_label,''), 80), v_exp);
  insert into security_events (event, detail) values ('device_registered', left(coalesce(p_label,''), 80));
  return jsonb_build_object('token', v_token, 'expires_at', v_exp);
end;
$$;
revoke all on function staff_device_register(text, text) from public;
grant execute on function staff_device_register(text, text) to anon, authenticated;

-- ── トークン照合: 有効なら last_used/expires を延長して true ─────────────
create or replace function staff_token_ok(p_token text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_h text; v_id uuid;
begin
  if coalesce(p_token,'') = '' then return false; end if;
  v_h := encode(extensions.digest(p_token, 'sha256'), 'hex');
  select id into v_id from staff_device_tokens
   where token_sha256 = v_h and revoked_at is null and expires_at > now()
   limit 1;
  if v_id is null then return false; end if;
  update staff_device_tokens
     set last_used_at = now(), expires_at = now() + interval '30 days'
   where id = v_id;
  return true;
end;
$$;
revoke all on function staff_token_ok(text) from public;
grant execute on function staff_token_ok(text) to anon, authenticated;

-- ── 端末の自己失効（「この端末の認証を解除」） ────────────────────────
create or replace function staff_device_revoke(p_token text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_n int;
begin
  update staff_device_tokens set revoked_at = now()
   where token_sha256 = encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex')
     and revoked_at is null;
  get diagnostics v_n = row_count;
  if v_n > 0 then insert into security_events (event) values ('device_revoked'); end if;
  return v_n > 0;
end;
$$;
revoke all on function staff_device_revoke(text) from public;
grant execute on function staff_device_revoke(text) to anon, authenticated;

-- ── 全端末トークンの一括失効（スタッフキー変更時に呼ぶ） ───────────────
create or replace function staff_devices_revoke_all()
returns int
language plpgsql security definer set search_path = public, extensions as $$
declare v_n int;
begin
  update staff_device_tokens set revoked_at = now() where revoked_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke all on function staff_devices_revoke_all() from public;   -- 内部利用のみ（EXECUTE付与なし）

-- ── スタッフ認証ヘルパをトークン/キー両対応へ（個体書込RPCが利用） ───────
-- 引数名は既存(p_staff_key)を維持（CREATE OR REPLACEで改名不可）。実際にはトークンも受ける。
create or replace function _ind_require_staff(p_staff_key text)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if staff_token_ok(p_staff_key) then return; end if;   -- 端末トークン（推奨）
  if staff_key_ok(p_staff_key) then return; end if;     -- 生キー（後方互換）
  raise exception 'スタッフキーが違います' using errcode = '28000';
end;
$$;
revoke all on function _ind_require_staff(text) from public;

-- ── スタッフキー変更時に全端末を失効させる（ライブ定義を踏襲して追記） ──
-- 適用済みマイグレーションのファイルは編集せず、ここで CREATE OR REPLACE する。
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

  update app_secrets
     set hash = extensions.crypt(p_new_key, extensions.gen_salt('bf')), updated_at = now()
   where key = 'staff_key';
  insert into app_secrets (key, hash)
  values ('staff_key_sha256', encode(extensions.digest(p_new_key, 'sha256'), 'hex'))
  on conflict (key) do update set hash = excluded.hash, updated_at = now();

  v_revoked := staff_devices_revoke_all();   -- ★キー変更で全端末トークンを失効

  insert into security_events (event, detail)
  values ('staff_key_rotated', '回復コードによる変更。全端末トークンを失効(' || v_revoked || ')。全端末で再認証が必要');
  return true;
end;
$$;
grant execute on function admin_rotate_staff_key(text, text) to anon, authenticated;
