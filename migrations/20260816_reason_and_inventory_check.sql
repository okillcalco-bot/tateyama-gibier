-- 20260816_reason_and_inventory_check.sql
-- Codex 3巡目 P1-2 残: 削除/復元の理由を人手必須化、relabel後の在庫コード不整合を同一txで検証。追加のみ。

-- by-label ラッパの理由 coalesce 既定を廃止（未入力を通さない。下位関数が非空を強制）
create or replace function staff_individual_soft_delete_by_label(p_staff_key text, p_label text, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  perform _ind_require_staff(p_staff_key);
  select id into v_id from individuals where label_id = p_label and deleted_at is null limit 1;
  if v_id is null then raise exception '個体が見つかりません: %', p_label; end if;
  return staff_individual_soft_delete(p_staff_key, v_id, p_reason);   -- 理由はそのまま（未入力なら下位でエラー）
end;
$$;
revoke all on function staff_individual_soft_delete_by_label(text, text, text) from public;
grant execute on function staff_individual_soft_delete_by_label(text, text, text) to anon, authenticated;

create or replace function staff_individual_restore_by_label(p_staff_key text, p_label text, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  perform _ind_require_staff(p_staff_key);
  select id into v_id from individuals where label_id = p_label and deleted_at is not null order by deleted_at desc limit 1;
  if v_id is null then raise exception '削除済みの個体が見つかりません: %', p_label; end if;
  return staff_individual_restore(p_staff_key, v_id, p_reason);
end;
$$;
revoke all on function staff_individual_restore_by_label(text, text, text) from public;
grant execute on function staff_individual_restore_by_label(text, text, text) to anon, authenticated;

-- 統合編集: relabel 後に inventory.individual_code の不整合0を同一txで検証
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
    if v_new !~ '^[^[:space:]]{2,40}$' then raise exception '個体番号の形式が不正です'; end if;
    select count(*) into v_dup from individuals where label_id = v_new and id <> p_id;
    if v_dup > 0 then raise exception '個体番号が既に使われています（削除済み含む）: %', v_new; end if;
    update individuals set label_id = v_new where id = p_id returning * into v_row;
    update inventory set individual_code = v_new where individual_id = v_new and individual_code = v_old;
    -- relabel後の非正規化コード不整合を同一txで検証（残っていればロールバック）
    select count(*) into v_bad from inventory where individual_id = v_new and coalesce(individual_code,'') <> v_new;
    if v_bad > 0 then raise exception '在庫コード(individual_code)の不整合が残っています: %件', v_bad; end if;
  end if;
  insert into individual_audit(action, actor, target_id, label_id, new_label_id, before, after, reason, device_token_id)
  values ('edit','staff', p_id, v_old, case when v_new is not null and v_new <> v_old then v_new else null end,
          to_jsonb(v_before), to_jsonb(v_row), p_reason, v_dt);
  return jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id, 'relabeled', (v_new is not null and v_new <> v_old));
end;
$$;
revoke all on function staff_individual_edit(text, uuid, jsonb, text, text) from public;
grant execute on function staff_individual_edit(text, uuid, jsonb, text, text) to anon, authenticated;
