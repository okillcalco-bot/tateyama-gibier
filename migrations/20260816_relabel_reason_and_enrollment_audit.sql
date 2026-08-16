-- 20260816_relabel_reason_and_enrollment_audit.sql
-- Codex 4巡目 P1-1 / P1-2。追加のみ（CREATE OR REPLACE ＋ 制約追加）。
--
-- P1-1: 個体番号(label_id)の変更（改番）は「理由」を必須にする。
--   - staff_individual_edit: 番号が実際に変わる場合のみ理由を必須化（属性編集のみなら理由不要）。
--   - staff_individual_relabel: 既定理由でごまかさず、呼び出し側が渡した理由をそのまま要求する
--     （coalesceの既定値を撤去）。理由なしの改番は例外で拒否 → individual_audit に必ず理由が残る。
-- P1-2: enrollment_tokens の監査整合。
--   - device_token_id に staff_device_tokens(id) へのFKを付与（発行された端末IDの実在を保証）。
--   - キー変更(admin_rotate_staff_key)で未使用の招待は expires_at ではなく revoked_at を記録して失効。

-- P1-2a: enrollment_tokens.device_token_id の実在保証（FK）
alter table enrollment_tokens
  drop constraint if exists enrollment_device_fk;
alter table enrollment_tokens
  add constraint enrollment_device_fk
  foreign key (device_token_id) references staff_device_tokens(id);

-- P1-1: 改番に理由を必須化
create or replace function staff_individual_edit(p_staff_key text, p_id uuid, p_patch jsonb, p_new_label text default null, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  c_allow constant text[] := array[
    'species','sex','weight_total','age_estimate','capture_date','capture_time','weather',
    'capture_city','capture_area','capture_koaza','hunter_name','capture_method','finishing_method',
    'trap_part','trap_set_date','trap_number','bait_type','is_juvenile','finisher_name',
    'capture_lat','capture_lng','hit_location','bleed_time','bleed_location','gutting','cooling_method',
    'transport_start','receive_time','process_time','quality','recorder','hunter_health_ok',
    'hunter_health_issues','capture_anomalies','organ_anomalies','has_fetus','processing_type','memo',
    'intake_method','intake_staff','organs_use','hide_status','hide_location','processing_notes',
    'aging_method','aging_started_at','aging_ended_at','meat_rank','yield_rate','buyback_base',
    'buyback_amount','purchase_payee','image_url','processing_done_at','intake_status','body_length_cm',
    'disposal_method','butcher_staff','submitter_name','special_notes','photo_tail_before',
    'photo_tail_after','photo_extra','map_image','survey_downloaded_at','carrier_name',
    'radiation_test_date','radiation_result_date','radiation_result','stopkill_pickup','serial_number'];
  v_dt uuid; v_before individuals; v_row individuals; v_old text; v_new text; v_dup int; v_bad int;
begin
  v_dt := _ind_require_staff(p_staff_key);
  select * into v_before from individuals where id = p_id for update;
  if v_before.id is null then raise exception '個体が見つかりません'; end if;
  if v_before.deleted_at is not null then raise exception '削除済みの個体は編集できません'; end if;
  v_old := v_before.label_id;
  if p_patch is not null and p_patch <> '{}'::jsonb then
    perform _reject_unknown_keys(p_patch, c_allow);
    perform _capture_validate(p_patch);
    v_row := _ind_apply('update', p_id, p_patch, c_allow);
  else v_row := v_before; end if;
  v_new := nullif(btrim(coalesce(p_new_label,'')), '');
  if v_new is not null and v_new <> v_old then
    -- 改番は理由必須（監査ログへ確実に理由を残す）
    if coalesce(btrim(p_reason),'') = '' then raise exception '個体番号を変更する理由を入力してください'; end if;
    if v_new !~ '^[^[:space:]]{2,40}$' then raise exception '個体番号の形式が不正です'; end if;
    select count(*) into v_dup from individuals where label_id = v_new and id <> p_id;
    if v_dup > 0 then raise exception '個体番号が既に使われています（削除済み含む）: %', v_new; end if;
    update individuals set label_id = v_new where id = p_id returning * into v_row;
    update inventory set individual_code = v_new where individual_id = v_new and individual_code = v_old;
    select count(*) into v_bad from inventory where individual_id = v_new and coalesce(individual_code,'') <> v_new;
    if v_bad > 0 then raise exception '在庫コード(individual_code)の不整合が残っています: %件', v_bad; end if;
  end if;
  insert into individual_audit(action, actor, target_id, label_id, new_label_id, before, after, reason, device_token_id)
  values ('edit','staff', p_id, v_old, case when v_new is not null and v_new <> v_old then v_new else null end,
          to_jsonb(v_before), to_jsonb(v_row), p_reason, v_dt);
  return jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id, 'relabeled', (v_new is not null and v_new <> v_old));
end; $$;
revoke all on function staff_individual_edit(text, uuid, jsonb, text, text) from public;
grant execute on function staff_individual_edit(text, uuid, jsonb, text, text) to anon, authenticated;

-- 改番専用ラッパ: 既定理由でごまかさず、呼び出し側の理由をそのまま要求
create or replace function staff_individual_relabel(p_staff_key text, p_id uuid, p_new_label text, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  return staff_individual_edit(p_staff_key, p_id, '{}'::jsonb, p_new_label, p_reason);
end; $$;
revoke all on function staff_individual_relabel(text, uuid, text, text) from public;
grant execute on function staff_individual_relabel(text, uuid, text, text) to anon, authenticated;

-- P1-2b: キー変更で未使用の招待を revoked_at で失効（expires_at 短縮ではなく失効日時を記録）
create or replace function admin_rotate_staff_key(p_recovery_code text, p_new_key text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_fail int; v_revoked int; v_ok boolean; v_inv int;
begin
  select hash into v_hash from app_secrets where key = 'recovery_code';
  v_ok := v_hash is not null and v_hash = extensions.crypt(coalesce(p_recovery_code,''), v_hash);
  if not v_ok then
    perform pg_advisory_xact_lock(hashtext('auth:recovery'));
    select count(*) into v_fail from auth_attempts where kind = 'recovery' and not ok and created_at > now() - interval '15 minutes';
    insert into auth_attempts (kind, ok) values ('recovery', false);
    if v_fail >= 5 then insert into security_events (event, detail) values ('recovery_locked', '15分に誤り多数'); end if;
    insert into security_events (event) values ('recovery_failed');
    return false;
  end if;
  insert into auth_attempts (kind, ok) values ('recovery', true);
  if length(coalesce(p_new_key,'')) < 16 then raise exception '新しいスタッフキーは16文字以上にしてください'; end if;
  update app_secrets set hash = extensions.crypt(p_new_key, extensions.gen_salt('bf')), updated_at = now() where key = 'staff_key';
  insert into app_secrets (key, hash) values ('staff_key_sha256', encode(extensions.digest(p_new_key, 'sha256'), 'hex'))
   on conflict (key) do update set hash = excluded.hash, updated_at = now();
  v_revoked := staff_devices_revoke_all();
  update enrollment_tokens set revoked_at = now() where used_at is null and revoked_at is null;   -- 失効日時を記録
  get diagnostics v_inv = row_count;
  insert into security_events (event, detail) values ('staff_key_rotated', '端末失効' || v_revoked || '・未使用招待失効' || v_inv);
  return true;
end; $$;
revoke all on function admin_rotate_staff_key(text, text) from public;
grant execute on function admin_rotate_staff_key(text, text) to anon, authenticated;
