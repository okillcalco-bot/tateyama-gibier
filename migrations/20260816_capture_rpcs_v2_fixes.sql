-- 20260816_capture_rpcs_v2_fixes.sql
-- Codex 3巡目レビュー対応（P0-1/P0-3/P0-4/P1-1/P1-2の一部）。追加のみ・非破壊。forward-fix。
--
-- P0-1: request_log.result に submission_token 等の credential を保存しない
--       （結果からtokenを除外し初回のみ返す）。payload_hash を md5→sha256。
-- P0-3: survey/photo は「認証→individual確定→(fn:individual, request_id)スコープの冪等→更新」の順。
--       無効/期限切れ/別個体トークンでキャッシュ結果を返さない。scope も検証。
-- P0-4: 写真は public URL でなく object_path を正として image_url に保存。
--       object_path が対象individual用に発行されたパスか検証（他個体紐付け禁止）。
--       submission_tokens.individual_id に FK。表示時に署名URL（private化まで実写真運用禁止）。
-- P1-1: public_submit の rate limit を >=120 かつ advisory lock で原子化。
--       staff_key_ok / admin_rotate は「正しいキーは常に通す・誤りのみ制限」で第三者DoSを回避、窓は自己回復。
-- P1-2: staff_individual_update に deleted_at is null ＋ _capture_validate。

-- ── submission_tokens に FK と scope 前提 ──
alter table submission_tokens
  add constraint submission_tokens_individual_fk
  foreign key (individual_id) references individuals(id) on delete cascade;

-- ── P0-2: 使い捨て端末登録トークン（生スタッフキー共有リンクの置換え） ──
create table if not exists enrollment_tokens (
  id           uuid primary key default gen_random_uuid(),
  token_sha256 text not null unique,
  label        text,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '10 minutes',
  used_at      timestamptz
);
alter table enrollment_tokens enable row level security;   -- RPC経由のみ

-- ── P1-1: スタッフキー照合を「正しいキーは常に通す・誤りのみ制限」に ──
-- 匿名第三者が誤入力を連発しても、正規スタッフ（正しいキー）は締め出されない。
-- 窓は固定（自己回復）。誤りは履歴に記録し続ける。総当たりはキー長で抑止。
create or replace function staff_key_ok(p_staff_key text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_ok boolean; v_fail int;
begin
  select hash into v_hash from app_secrets where key = 'staff_key';
  v_ok := v_hash is not null and v_hash = extensions.crypt(coalesce(p_staff_key,''), v_hash);
  if v_ok then
    insert into auth_attempts (kind, ok) values ('staff_key', true);
    return true;                                   -- 正しいキーは常に許可（DoS回避）
  end if;
  perform pg_advisory_xact_lock(hashtext('auth:staff_key'));   -- 誤り集計を直列化
  select count(*) into v_fail from auth_attempts
   where kind = 'staff_key' and not ok and created_at > now() - interval '5 minutes';
  insert into auth_attempts (kind, ok) values ('staff_key', false);   -- 履歴は残す
  if v_fail >= 10 then
    insert into security_events (event, detail) values ('staff_key_bruteforce', '5分に誤り多数');
  end if;
  return false;
end;
$$;
revoke all on function staff_key_ok(text) from public;
grant execute on function staff_key_ok(text) to anon, authenticated;

-- ── P1-1: 回復コードも「正しければ常に通す・誤りのみ制限」に ──
create or replace function admin_rotate_staff_key(p_recovery_code text, p_new_key text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_fail int; v_revoked int; v_ok boolean;
begin
  select hash into v_hash from app_secrets where key = 'recovery_code';
  v_ok := v_hash is not null and v_hash = extensions.crypt(coalesce(p_recovery_code,''), v_hash);
  if not v_ok then
    perform pg_advisory_xact_lock(hashtext('auth:recovery'));
    select count(*) into v_fail from auth_attempts
     where kind = 'recovery' and not ok and created_at > now() - interval '15 minutes';
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
  update enrollment_tokens set expires_at = now() where used_at is null and expires_at > now();  -- 未使用の招待も失効
  insert into security_events (event, detail) values ('staff_key_rotated', '全端末/招待を失効(' || v_revoked || ')');
  return true;
end;
$$;
revoke all on function admin_rotate_staff_key(text, text) from public;
grant execute on function admin_rotate_staff_key(text, text) to anon, authenticated;

-- ── P0-1/P1-1: 公開登録。tokenは結果に保存せず初回のみ返す。hashはsha256。rate limitを原子化 ──
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
  v_clean jsonb; v_row individuals; v_label text; v_recent int; v_tok text; v_res jsonb;
begin
  v_prior := _idem_begin('public_capture_submit', p_request_id, v_hash);
  if v_prior is not null then return v_prior; end if;   -- 再送は保存済み結果（token無し）を返す
  -- rate limit（原子化）: 集計→判定を advisory lock 下で。>=120 で拒否
  perform pg_advisory_xact_lock(hashtext('ratelimit:public_capture_submit'));
  select count(*) into v_recent from request_log where fn='public_capture_submit' and created_at > now() - interval '1 minute';
  if v_recent >= 120 then raise exception '混み合っています。少し待って再度お試しください'; end if;
  perform _reject_unknown_keys(p_payload, c_allow);
  perform _capture_validate(p_payload);
  v_label := '仮-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));
  v_clean := (p_payload - 'label_id' - 'serial_number' - 'intake_status')
             || jsonb_build_object('label_id', v_label, 'intake_status', '搬入待ち');
  v_row := _ind_apply('insert', null, v_clean, c_allow || array['label_id','intake_status']);
  v_tok := _issue_submission_token(v_row.id);
  insert into individual_audit(action, actor, target_id, label_id, after)
  values ('submit','public', v_row.id, v_row.label_id, to_jsonb(v_row));
  v_res := jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id, 'serial_number', null);  -- token含めない
  perform _idem_store('public_capture_submit', p_request_id, v_hash, v_res);
  return v_res || jsonb_build_object('submission_token', v_tok);   -- tokenは戻り値のみ（DBには保存しない）
end;
$$;
revoke all on function public_capture_submit(jsonb, text) from public;
grant execute on function public_capture_submit(jsonb, text) to anon, authenticated;

-- ── P0-1: センター受入。同様に token を結果へ保存しない。hash sha256 ──
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
  v_species text; v_serial int; v_label text; v_ph uuid; v_row individuals; v_tok text; v_res jsonb;
begin
  v_dt := _ind_require_staff(p_staff_key);
  v_prior := _idem_begin('staff_capture_intake', p_request_id, v_hash);
  if v_prior is not null then return v_prior; end if;
  perform _reject_unknown_keys(p_payload, c_allow);
  perform _capture_validate(p_payload);
  v_species := p_payload->>'species'; v_serial := nullif(p_payload->>'serial_number','')::int; v_label := p_payload->>'label_id';
  if coalesce(v_label,'') not like '仮-%' and v_species = 'イノシシ' and v_serial is not null then
    perform pg_advisory_xact_lock(hashtext('ind_serial_fill'));
    select id into v_ph from individuals where species='イノシシ' and serial_number = v_serial and capture_date is null and deleted_at is null order by created_at nulls first limit 1;
  end if;
  if v_ph is not null then v_row := _ind_apply('update', v_ph, p_payload, c_allow);
  else v_row := _ind_apply('insert', null, p_payload, c_allow); end if;
  v_tok := _issue_submission_token(v_row.id);
  insert into individual_audit(action, actor, target_id, label_id, after, device_token_id)
  values (case when v_ph is not null then 'intake_fill' else 'intake' end,'staff', v_row.id, v_row.label_id, to_jsonb(v_row), v_dt);
  v_res := jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id, 'serial_number', v_row.serial_number);
  perform _idem_store('staff_capture_intake', p_request_id, v_hash, v_res);
  return v_res || jsonb_build_object('submission_token', v_tok);
end;
$$;
revoke all on function staff_capture_intake(text, jsonb, text) from public;
grant execute on function staff_capture_intake(text, jsonb, text) to anon, authenticated;

-- ── P0-3: 調査票更新は「認証→individual→scope→(fn:individual, req)冪等→更新」 ──
create or replace function public_capture_update_survey(p_submission_token text, p_patch jsonb, p_request_id text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  c_allow constant text[] := array['submitter_name','capture_koaza','body_length_cm','is_juvenile','trap_number','bait_type','trap_set_date','disposal_method','special_notes','photo_tail_before','photo_tail_after','photo_extra','map_image','survey_downloaded_at'];
  v_hash text := encode(extensions.digest(coalesce(p_patch::text,''),'sha256'),'hex'); v_prior jsonb; v_iid uuid; v_row individuals; v_res jsonb;
begin
  -- 1) 認証（scope検証つき）
  select individual_id into v_iid from submission_tokens
   where token_sha256 = encode(extensions.digest(coalesce(p_submission_token,''),'sha256'),'hex')
     and scope = 'survey_photo' and expires_at > now() limit 1;
  if v_iid is null then raise exception '提出用トークンが無効か期限切れです'; end if;
  -- 2) 冪等は個体スコープ（別個体トークンで以前の結果を返さない）
  v_prior := _idem_begin('public_capture_update_survey:'||v_iid::text, p_request_id, v_hash);
  if v_prior is not null then return v_prior; end if;
  perform _reject_unknown_keys(p_patch, c_allow);
  perform _capture_validate(p_patch);
  v_row := _ind_apply('update', v_iid, p_patch, c_allow);
  insert into individual_audit(action, actor, target_id, label_id) values ('update_survey','public', v_iid, v_row.label_id);
  v_res := jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id);
  perform _idem_store('public_capture_update_survey:'||v_iid::text, p_request_id, v_hash, v_res);
  return v_res;
end;
$$;
revoke all on function public_capture_update_survey(text, jsonb, text) from public;
grant execute on function public_capture_update_survey(text, jsonb, text) to anon, authenticated;

-- ── P0-3/P0-4: 写真紐付け。認証→個体→object_path検証→保存（image_urlはobject_path）→個体スコープ冪等 ──
create or replace function public_attach_capture_photo(p_credential text, p_label_id text, p_object_path text, p_request_id text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_iid uuid; v_dt uuid; v_row individuals; v_res jsonb; v_prefix text;
  v_hash text := encode(extensions.digest(coalesce(p_object_path,''),'sha256'),'hex'); v_prior jsonb;
begin
  -- 1) 認証（st_=提出者トークン / それ以外=staff端末トークン）
  if coalesce(p_credential,'') like 'st\_%' then
    select individual_id into v_iid from submission_tokens
     where token_sha256 = encode(extensions.digest(p_credential,'sha256'),'hex') and scope='survey_photo' and expires_at > now() limit 1;
    if v_iid is null then raise exception '提出用トークンが無効か期限切れです'; end if;
  else
    v_dt := _ind_require_staff(p_credential);
    select id into v_iid from individuals where label_id = p_label_id and deleted_at is null limit 1;
    if v_iid is null then raise exception '個体が見つかりません: %', p_label_id; end if;
  end if;
  select * into v_row from individuals where id = v_iid;
  -- 2) object_path 形式＋この個体用に発行されたパスかを検証（他個体への紐付け禁止）
  if coalesce(p_object_path,'') = '' or p_object_path !~ '^[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}$' or p_object_path like '%..%' then
    raise exception '画像パスが不正です'; end if;
  v_prefix := regexp_replace(coalesce(v_row.label_id,''), '[^A-Za-z0-9_-]', '_', 'g');
  if v_prefix = '' or split_part(p_object_path, '/', 1) <> v_prefix then
    raise exception '画像パスが対象個体のものではありません'; end if;
  -- 3) 冪等（個体スコープ）
  v_prior := _idem_begin('public_attach_capture_photo:'||v_iid::text, p_request_id, v_hash);
  if v_prior is not null then return v_prior; end if;
  -- 4) image_url には object_path を保存（private化後は署名URLで表示）
  update individuals set image_url = p_object_path where id = v_iid returning * into v_row;
  insert into individual_audit(action, actor, target_id, label_id, device_token_id, after)
  values ('attach_photo', case when v_dt is null then 'public' else 'staff' end, v_iid, v_row.label_id, v_dt, jsonb_build_object('object_path', p_object_path));
  v_res := jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id, 'object_path', p_object_path);
  perform _idem_store('public_attach_capture_photo:'||v_iid::text, p_request_id, v_hash, v_res);
  return v_res;
end;
$$;
revoke all on function public_attach_capture_photo(text, text, text, text) from public;
grant execute on function public_attach_capture_photo(text, text, text, text) to anon, authenticated;

-- ── P1-2: 旧 staff_individual_update に deleted_at is null ＋ 検証 ──
create or replace function staff_individual_update(p_staff_key text, p_id uuid, p_patch jsonb)
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
  v_dt uuid; v_before individuals; v_row individuals;
begin
  v_dt := _ind_require_staff(p_staff_key);
  select * into v_before from individuals where id = p_id for update;
  if v_before.id is null then raise exception '個体が見つかりません'; end if;
  if v_before.deleted_at is not null then raise exception '削除済みの個体は編集できません'; end if;
  perform _reject_unknown_keys(p_patch, c_allow);
  perform _capture_validate(p_patch);
  v_row := _ind_apply('update', p_id, p_patch, c_allow);
  insert into individual_audit(action, actor, target_id, label_id, before, after, device_token_id)
  values ('update','staff', p_id, v_row.label_id, to_jsonb(v_before), to_jsonb(v_row), v_dt);
  return jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id);
end;
$$;
revoke all on function staff_individual_update(text, uuid, jsonb) from public;
grant execute on function staff_individual_update(text, uuid, jsonb) to anon, authenticated;
