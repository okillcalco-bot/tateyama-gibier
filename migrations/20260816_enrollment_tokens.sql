-- 20260816_enrollment_tokens.sql
-- Codex 3巡目 P0-2: 生スタッフキー共有リンク(#skey)を廃止し、使い捨て招待(enrollment token)へ。
-- enrollment_tokens 表は 20260816_capture_rpcs_v2_fixes.sql で先行作成済み。ここで列追加とRPCを足す。
-- 追加のみ・非破壊。
--
-- 受入条件:
--  - 十分な乱数(32byte)で発行・DBはsha256のみ・有効期限10分・1回限り
--  - 発行日時/使用日時/失効日時/使用端末(device_token_id)/発行者を監査可能
--  - 交換は SELECT FOR UPDATE で直列化、使用済み化とdt_発行を単一tx、同時交換は1台だけ成功
--  - 期限切れ/使用済み/失効済みは拒否、キー変更で未使用招待を全失効(admin_rotate側で実施済み)
--  - 個体変更RPCは dt_ 端末トークンのみ受理（生スタッフキー不可）
--  - 招待発行にも staff_key の試行制限を適用（staff_key_ok経由）

alter table enrollment_tokens add column if not exists revoked_at timestamptz;
alter table enrollment_tokens add column if not exists device_token_id uuid;
alter table enrollment_tokens add column if not exists issuer text;

-- ── 招待の発行（管理者専用: 生スタッフキーで認証） ──
create or replace function staff_create_enrollment_token(p_staff_key text, p_label text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_token text; v_exp timestamptz;
begin
  if not staff_key_ok(p_staff_key) then           -- 試行制限つき（正しいキーは常に通る）
    raise exception 'スタッフキーが違います' using errcode = '28000';
  end if;
  v_token := 'et_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_exp := now() + interval '10 minutes';
  insert into enrollment_tokens (token_sha256, label, issuer, expires_at)
  values (encode(extensions.digest(v_token,'sha256'),'hex'), left(coalesce(p_label,''),80), 'staff', v_exp);
  insert into security_events (event, detail) values ('enrollment_issued', left(coalesce(p_label,''),80));
  return jsonb_build_object('enroll_token', v_token, 'expires_at', v_exp);
end;
$$;
revoke all on function staff_create_enrollment_token(text, text) from public;
grant execute on function staff_create_enrollment_token(text, text) to anon, authenticated;

-- ── 招待の交換（端末側: 使い捨て・単一tx・直列化） ──
create or replace function staff_enroll_device(p_enroll_token text, p_label text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_row enrollment_tokens; v_tok text; v_exp timestamptz; v_dtid uuid;
begin
  select * into v_row from enrollment_tokens
   where token_sha256 = encode(extensions.digest(coalesce(p_enroll_token,''),'sha256'),'hex')
   for update;                                     -- 同時交換を直列化
  if v_row.id is null then raise exception '認証リンクが無効です'; end if;
  if v_row.used_at is not null then raise exception 'この認証リンクは使用済みです'; end if;
  if v_row.revoked_at is not null then raise exception 'この認証リンクは失効しています'; end if;
  if v_row.expires_at <= now() then raise exception '認証リンクの有効期限が切れています（管理者に再発行を依頼してください）'; end if;

  v_tok := 'dt_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_exp := now() + interval '30 days';
  insert into staff_device_tokens (token_sha256, label, expires_at)
  values (encode(extensions.digest(v_tok,'sha256'),'hex'), left(coalesce(p_label, v_row.label, ''),80), v_exp)
  returning id into v_dtid;

  update enrollment_tokens set used_at = now(), device_token_id = v_dtid where id = v_row.id;  -- 使用済み化（同一tx）
  insert into security_events (event, detail) values ('device_enrolled', left(coalesce(p_label,''),80));
  return jsonb_build_object('token', v_tok, 'expires_at', v_exp);
end;
$$;
revoke all on function staff_enroll_device(text, text) from public;
grant execute on function staff_enroll_device(text, text) to anon, authenticated;

-- ── 個体変更RPCは dt_ 端末トークンのみ受理（生スタッフキーを受けない） ──
create or replace function _ind_require_staff(p_staff_key text)
returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  if p_staff_key like 'dt\_%' then
    v_id := staff_token_resolve(p_staff_key);
    if v_id is null then raise exception 'スタッフ端末の認証が切れています。管理者の認証リンクで再認証してください' using errcode = '28000'; end if;
    return v_id;
  end if;
  raise exception 'スタッフ端末の認証が必要です（管理者の認証リンクで端末を認証してください）' using errcode = '28000';
end;
$$;
revoke all on function _ind_require_staff(text) from public;

-- ── 生スタッフキーでの端末登録(staff_device_register)を廃止 ──
-- 端末トークンの発行は「招待(staff_create_enrollment_token)→交換(staff_enroll_device)」のみに一本化。
-- 生スタッフキーは招待発行(管理者)と回復(admin_rotate_staff_key)に限定する。
drop function if exists staff_device_register(text, text);
