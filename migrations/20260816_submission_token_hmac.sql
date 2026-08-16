-- 20260816_submission_token_hmac.sql
-- Codex 4巡目 P0-2: submission_token を「決定的に再生成可能」にする。
-- サーバー秘密鍵(app_secrets.submission_hmac)によるHMACで individual_id + request_id + scope から
-- 決定的に生成。DBには sha256 ハッシュのみ保存。同じrequest_id・同じ個体の正当な再送では同じ有効な
-- トークンを再取得できる（レスポンス喪失に強い）。別request_id/別個体/別scopeからは再生成できない。
-- 追加のみ。前提: app_secrets に 'submission_hmac'（32byte hex）を投入済み。

-- 決定的トークン発行（(individual_id, request_id) が同じなら同じトークン）
drop function if exists _issue_submission_token(uuid);
create function _issue_submission_token(p_individual_id uuid, p_request_id text)
returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_secret text; v_tok text;
begin
  select hash into v_secret from app_secrets where key = 'submission_hmac';
  if v_secret is null then raise exception 'submission_hmac 未設定'; end if;
  -- scope で用途分離。individual_id と request_id で決定的。
  v_tok := 'st_' || encode(extensions.hmac(p_individual_id::text || ':' || coalesce(p_request_id,'') || ':survey_photo', v_secret, 'sha256'), 'hex');
  insert into submission_tokens(token_sha256, individual_id, scope, expires_at)
  values (encode(extensions.digest(v_tok,'sha256'),'hex'), p_individual_id, 'survey_photo', now() + interval '2 hours')
  on conflict (token_sha256) do update set expires_at = now() + interval '2 hours';   -- 再送で有効期限を再延長
  return v_tok;
end;
$$;
revoke all on function _issue_submission_token(uuid, text) from public;

-- 公開登録: 初回・再送とも決定的トークンを返す。request_log.result には token を含めない。
create or replace function public_capture_submit(p_payload jsonb, p_request_id text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  c_allow constant text[] := array[
    'species','sex','weight_total','age_estimate','capture_date','capture_time','weather',
    'capture_city','capture_area','capture_koaza','hunter_name','capture_method','finishing_method',
    'trap_part','trap_set_date','trap_number','bait_type','is_juvenile','finisher_name',
    'capture_lat','capture_lng','hit_location','bleed_time','bleed_location','gutting',
    'capture_anomalies','hunter_health_ok','hunter_health_issues','organ_anomalies','has_fetus',
    'intake_method','carrier_name','memo','notes','submitter_name','special_notes',
    'body_length_cm','disposal_method'];
  v_hash text := encode(extensions.digest(coalesce(p_payload::text,''),'sha256'),'hex'); v_prior jsonb;
  v_clean jsonb; v_row individuals; v_label text; v_recent int; v_res jsonb;
begin
  v_prior := _idem_begin('public_capture_submit', p_request_id, v_hash);
  if v_prior is not null then
    -- 再送: 決定的トークンを再生成して返す（DBにはtokenを保存していない）
    return v_prior || jsonb_build_object('submission_token', _issue_submission_token((v_prior->>'id')::uuid, p_request_id));
  end if;
  perform pg_advisory_xact_lock(hashtext('ratelimit:public_capture_submit'));
  select count(*) into v_recent from request_log where fn='public_capture_submit' and created_at > now() - interval '1 minute';
  if v_recent >= 120 then raise exception '混み合っています。少し待って再度お試しください'; end if;
  perform _reject_unknown_keys(p_payload, c_allow);
  perform _capture_validate(p_payload);
  v_label := '仮-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));
  v_clean := (p_payload - 'label_id' - 'serial_number' - 'intake_status') || jsonb_build_object('label_id', v_label, 'intake_status', '搬入待ち');
  v_row := _ind_apply('insert', null, v_clean, c_allow || array['label_id','intake_status']);
  insert into individual_audit(action, actor, target_id, label_id, after) values ('submit','public', v_row.id, v_row.label_id, to_jsonb(v_row));
  v_res := jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id, 'serial_number', null);
  perform _idem_store('public_capture_submit', p_request_id, v_hash, v_res);
  return v_res || jsonb_build_object('submission_token', _issue_submission_token(v_row.id, p_request_id));
end;
$$;
revoke all on function public_capture_submit(jsonb, text) from public;
grant execute on function public_capture_submit(jsonb, text) to anon, authenticated;

-- センター受入: 同様に決定的トークン。
create or replace function staff_capture_intake(p_staff_key text, p_payload jsonb, p_request_id text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  c_allow constant text[] := array[
    'label_id','serial_number','intake_status','species','sex','weight_total','age_estimate',
    'capture_date','capture_time','weather','capture_city','capture_area','capture_koaza',
    'hunter_name','capture_method','finishing_method','trap_part','trap_set_date','trap_number',
    'bait_type','is_juvenile','finisher_name','capture_lat','capture_lng','hit_location',
    'bleed_time','bleed_location','receive_time','transport_start','process_time','gutting',
    'capture_anomalies','hunter_health_ok','hunter_health_issues','organ_anomalies','has_fetus',
    'quality','intake_method','intake_staff','stopkill_pickup','carrier_name','recorder','memo',
    'notes','submitter_name','special_notes','disposal_method','body_length_cm'];
  v_dt uuid; v_hash text := encode(extensions.digest(coalesce(p_payload::text,''),'sha256'),'hex'); v_prior jsonb;
  v_species text; v_serial int; v_label text; v_ph uuid; v_row individuals; v_res jsonb;
begin
  v_dt := _ind_require_staff(p_staff_key);
  v_prior := _idem_begin('staff_capture_intake', p_request_id, v_hash);
  if v_prior is not null then
    return v_prior || jsonb_build_object('submission_token', _issue_submission_token((v_prior->>'id')::uuid, p_request_id));
  end if;
  perform _reject_unknown_keys(p_payload, c_allow);
  perform _capture_validate(p_payload);
  v_species := p_payload->>'species'; v_serial := nullif(p_payload->>'serial_number','')::int; v_label := p_payload->>'label_id';
  if coalesce(v_label,'') not like '仮-%' and v_species = 'イノシシ' and v_serial is not null then
    perform pg_advisory_xact_lock(hashtext('ind_serial_fill'));
    select id into v_ph from individuals where species='イノシシ' and serial_number = v_serial and capture_date is null and deleted_at is null order by created_at nulls first limit 1;
  end if;
  if v_ph is not null then v_row := _ind_apply('update', v_ph, p_payload, c_allow);
  else v_row := _ind_apply('insert', null, p_payload, c_allow); end if;
  insert into individual_audit(action, actor, target_id, label_id, after, device_token_id)
  values (case when v_ph is not null then 'intake_fill' else 'intake' end,'staff', v_row.id, v_row.label_id, to_jsonb(v_row), v_dt);
  v_res := jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id, 'serial_number', v_row.serial_number);
  perform _idem_store('staff_capture_intake', p_request_id, v_hash, v_res);
  return v_res || jsonb_build_object('submission_token', _issue_submission_token(v_row.id, p_request_id));
end;
$$;
revoke all on function staff_capture_intake(text, jsonb, text) from public;
grant execute on function staff_capture_intake(text, jsonb, text) to anon, authenticated;
