-- 20260816_capture_rpcs_v2.sql
-- Codex再レビュー P0-3 / P0-2 / P1-1 / P1-2 / P1-4 対応。追加のみ・非破壊。
--
-- P0-3 公開登録とセンター受入の分離:
--   public_capture_submit … 一般捕獲者用。仮番号発行・intake_status=搬入待ち固定・
--     正式情報(label_id/serial/受入時刻/品質/担当/放血後項目)は設定不可・許可外キーはエラー・入力検証・rate limit
--   staff_capture_intake  … センター受入用。staff device token必須。正式番号採番・空枠充当・受入時刻等・単一tx
-- P0-2 本人確認: submit成功時に submission_token を1回返し、調査票更新・写真紐付けに必須化。
--   写真は任意URLでなく object_path のみ受ける。
-- P1-1 冪等: request_log を (fn, client_request_id) 一意＋payload_hash。advisory lockで直列化。
--   同ID同payload→同結果 / 同ID別payload→拒否。
-- P1-2 編集+番号変更を単一tx(staff_individual_edit)。staff更新は明示ホワイトリスト。重複確認は削除済み含む。
-- P1-4 端末トークンに dt_ 接頭辞。token形式なら生キーfallbackしない。監査に device_token_id。
--
-- ロールバック: migrations/rollback/20260816_capture_rpcs_v2_rollback.sql

-- ── 冪等表を (fn, client_request_id) ＋ payload_hash へ作り直し（現状0件） ──
drop table if exists request_log cascade;
create table request_log (
  fn                text not null,
  client_request_id text not null,
  payload_hash      text,
  result            jsonb,
  created_at        timestamptz not null default now(),
  primary key (fn, client_request_id)
);
alter table request_log enable row level security;

-- ── 提出者トークン（自分が登録した個体だけ調査票/写真を追記できる） ──
create table if not exists submission_tokens (
  id           uuid primary key default gen_random_uuid(),
  token_sha256 text not null unique,
  individual_id uuid not null,
  scope        text not null default 'survey_photo',
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '2 hours'
);
alter table submission_tokens enable row level security;
create index if not exists submission_tokens_iid on submission_tokens (individual_id);

-- ── 監査に端末ID・担当者名を追加 ──
alter table individual_audit add column if not exists device_token_id uuid;
alter table individual_audit add column if not exists actor_name text;

-- ── 端末トークン照合（idを返す版・スライド延長） ──
create or replace function staff_token_resolve(p_token text)
returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  if coalesce(p_token,'') = '' then return null; end if;
  select id into v_id from staff_device_tokens
   where token_sha256 = encode(extensions.digest(p_token,'sha256'),'hex')
     and revoked_at is null and expires_at > now() limit 1;
  if v_id is null then return null; end if;
  update staff_device_tokens set last_used_at = now(), expires_at = now() + interval '30 days' where id = v_id;
  return v_id;
end;
$$;
revoke all on function staff_token_resolve(text) from public;

-- 端末登録: dt_ 接頭辞つきトークンを返す
create or replace function staff_device_register(p_staff_key text, p_label text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_token text; v_exp timestamptz;
begin
  if not staff_key_ok(p_staff_key) then
    raise exception 'スタッフキーが違います' using errcode = '28000';
  end if;
  v_token := 'dt_' || encode(extensions.gen_random_bytes(32), 'hex');
  v_exp := now() + interval '30 days';
  insert into staff_device_tokens (token_sha256, label, expires_at)
  values (encode(extensions.digest(v_token,'sha256'),'hex'), left(coalesce(p_label,''),80), v_exp);
  insert into security_events (event, detail) values ('device_registered', left(coalesce(p_label,''),80));
  return jsonb_build_object('token', v_token, 'expires_at', v_exp);
end;
$$;
revoke all on function staff_device_register(text, text) from public;
grant execute on function staff_device_register(text, text) to anon, authenticated;

-- ── スタッフ認証: トークン形式なら生キーへフォールバックしない。device_token_idを返す ──
drop function if exists _ind_require_staff(text);
create function _ind_require_staff(p_staff_key text)
returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  if p_staff_key like 'dt\_%' then                 -- 端末トークン
    v_id := staff_token_resolve(p_staff_key);
    if v_id is null then raise exception 'スタッフ端末の認証が切れています。再認証してください' using errcode = '28000'; end if;
    return v_id;                                    -- 端末トークンID
  end if;
  if staff_key_ok(p_staff_key) then return null; end if;   -- 生キー（管理者直接・共有リンク発行時のみ）
  raise exception 'スタッフキーが違います' using errcode = '28000';
end;
$$;
revoke all on function _ind_require_staff(text) from public;

-- ── 冪等ヘルパ（(fn,request_id)一意・payload_hash・advisory lock直列化） ──
create or replace function _idem_begin(p_fn text, p_req text, p_hash text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_res jsonb; v_hash text;
begin
  if coalesce(p_req,'') = '' or p_req !~ '^[A-Za-z0-9_-]{8,128}$' then
    raise exception 'リクエストIDが不正です';
  end if;
  perform pg_advisory_xact_lock(hashtext('idem:'||p_fn||':'||p_req));
  select result, payload_hash into v_res, v_hash from request_log
   where fn = p_fn and client_request_id = p_req;
  if found then
    if v_hash is distinct from p_hash then
      raise exception '同じリクエストIDで内容が異なります（二重送信の可能性）';
    end if;
    return v_res;   -- 既存結果を返す（呼び出し側はこれを返して終了）
  end if;
  return null;      -- 未処理。呼び出し側が本処理→_idem_store
end;
$$;
revoke all on function _idem_begin(text, text, text) from public;

create or replace function _idem_store(p_fn text, p_req text, p_hash text, p_result jsonb)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into request_log(fn, client_request_id, payload_hash, result)
  values (p_fn, p_req, p_hash, p_result)
  on conflict (fn, client_request_id) do nothing;
end;
$$;
revoke all on function _idem_store(text, text, text, jsonb) from public;

-- ── 入力検証（範囲・制御文字・全体サイズ） ──
create or replace function _capture_validate(p jsonb)
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare k text; v text; nn numeric; d date;
  c_ctrl constant text := E'\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f';
begin
  if length(p::text) > 20000 then raise exception '入力が大きすぎます'; end if;
  for k in select jsonb_object_keys(p) loop
    if jsonb_typeof(p->k) = 'string' then
      v := p->>k;
      if v <> translate(v, c_ctrl, '') then raise exception '不正な制御文字が含まれています: %', k; end if;
      if char_length(v) > 2000 then raise exception '項目が長すぎます: %', k; end if;
    end if;
  end loop;
  nn := nullif(p->>'weight_total','')::numeric;  if nn is not null and (nn < 0 or nn > 600) then raise exception '体重が範囲外です'; end if;
  nn := nullif(p->>'body_length_cm','')::numeric; if nn is not null and (nn < 0 or nn > 400) then raise exception '体長が範囲外です'; end if;
  nn := nullif(p->>'age_estimate','')::numeric;  if nn is not null and (nn < 0 or nn > 40) then raise exception '推定年齢が範囲外です'; end if;
  nn := nullif(p->>'capture_lat','')::numeric;   if nn is not null and (nn < 20 or nn > 46) then raise exception '緯度が範囲外です'; end if;
  nn := nullif(p->>'capture_lng','')::numeric;   if nn is not null and (nn < 122 or nn > 154) then raise exception '経度が範囲外です'; end if;
  if coalesce(p->>'capture_date','') <> '' then
    d := (p->>'capture_date')::date;
    if d < date '2000-01-01' or d > (current_date + 1) then raise exception '捕獲日が範囲外です'; end if;
  end if;
end;
$$;
revoke all on function _capture_validate(jsonb) from public;

-- 許可外キーがあれば無視せずエラー
create or replace function _reject_unknown_keys(p jsonb, p_allow text[])
returns void
language plpgsql security definer set search_path = public, extensions as $$
declare k text;
begin
  for k in select jsonb_object_keys(p) loop
    if not (k = any(p_allow)) then raise exception '許可されていない項目です: %', k; end if;
  end loop;
end;
$$;
revoke all on function _reject_unknown_keys(jsonb, text[]) from public;

-- 提出者トークン発行
create or replace function _issue_submission_token(p_individual_id uuid)
returns text
language plpgsql security definer set search_path = public, extensions as $$
declare v_tok text;
begin
  v_tok := 'st_' || encode(extensions.gen_random_bytes(24),'hex');
  insert into submission_tokens(token_sha256, individual_id)
  values (encode(extensions.digest(v_tok,'sha256'),'hex'), p_individual_id);
  return v_tok;
end;
$$;
revoke all on function _issue_submission_token(uuid) from public;

-- ── 公開登録（一般捕獲者）: 仮番号・搬入待ち固定・列限定・許可外エラー・検証・冪等・rate limit ──
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
    'body_length_cm','disposal_method'
  ];
  v_hash text := md5(coalesce(p_payload::text,'')); v_prior jsonb;
  v_clean jsonb; v_row individuals; v_label text; v_recent int; v_tok text; v_res jsonb;
begin
  v_prior := _idem_begin('public_capture_submit', p_request_id, v_hash);
  if v_prior is not null then return v_prior; end if;

  -- rate limit（DoSバックストップ・粗い全体制限）
  select count(*) into v_recent from request_log
   where fn='public_capture_submit' and created_at > now() - interval '1 minute';
  if v_recent > 120 then raise exception '混み合っています。少し待って再度お試しください'; end if;

  perform _reject_unknown_keys(p_payload, c_allow);
  perform _capture_validate(p_payload);

  -- 正式情報はサーバ側で固定（匿名は正式番号・受入情報を設定できない）
  v_label := '仮-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));
  v_clean := (p_payload - 'label_id' - 'serial_number' - 'intake_status')
             || jsonb_build_object('label_id', v_label, 'intake_status', '搬入待ち');

  v_row := _ind_apply('insert', null, v_clean, c_allow || array['label_id','intake_status']);

  v_tok := _issue_submission_token(v_row.id);
  insert into individual_audit(action, actor, target_id, label_id, after)
  values ('submit','public', v_row.id, v_row.label_id, to_jsonb(v_row));

  v_res := jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id,
                              'serial_number', null, 'submission_token', v_tok);
  perform _idem_store('public_capture_submit', p_request_id, v_hash, v_res);
  return v_res;
end;
$$;
revoke all on function public_capture_submit(jsonb, text) from public;
grant execute on function public_capture_submit(jsonb, text) to anon, authenticated;

-- ── センター受入（スタッフ）: 正式番号採番・空枠充当・受入情報・単一tx・冪等 ──
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
    'notes','submitter_name','special_notes','disposal_method','body_length_cm'
  ];
  v_dt uuid; v_hash text := md5(coalesce(p_payload::text,'')); v_prior jsonb;
  v_species text; v_serial int; v_label text; v_ph uuid; v_row individuals; v_tok text; v_res jsonb;
begin
  v_dt := _ind_require_staff(p_staff_key);
  v_prior := _idem_begin('staff_capture_intake', p_request_id, v_hash);
  if v_prior is not null then return v_prior; end if;

  perform _reject_unknown_keys(p_payload, c_allow);
  perform _capture_validate(p_payload);

  v_species := p_payload->>'species';
  v_serial  := nullif(p_payload->>'serial_number','')::int;
  v_label   := p_payload->>'label_id';

  if coalesce(v_label,'') not like '仮-%' and v_species = 'イノシシ' and v_serial is not null then
    perform pg_advisory_xact_lock(hashtext('ind_serial_fill'));
    select id into v_ph from individuals
     where species='イノシシ' and serial_number = v_serial and capture_date is null and deleted_at is null
     order by created_at nulls first limit 1;
  end if;

  if v_ph is not null then
    v_row := _ind_apply('update', v_ph, p_payload, c_allow);
  else
    v_row := _ind_apply('insert', null, p_payload, c_allow);
  end if;

  v_tok := _issue_submission_token(v_row.id);
  insert into individual_audit(action, actor, target_id, label_id, after, device_token_id)
  values (case when v_ph is not null then 'intake_fill' else 'intake' end,'staff', v_row.id, v_row.label_id, to_jsonb(v_row), v_dt);

  v_res := jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id,
                              'serial_number', v_row.serial_number, 'submission_token', v_tok);
  perform _idem_store('staff_capture_intake', p_request_id, v_hash, v_res);
  return v_res;
end;
$$;
revoke all on function staff_capture_intake(text, jsonb, text) from public;
grant execute on function staff_capture_intake(text, jsonb, text) to anon, authenticated;

-- ── 調査票の追記: submission_token 必須（自分の登録個体だけ） ──
drop function if exists public_capture_update_survey(text, jsonb, text);
create function public_capture_update_survey(p_submission_token text, p_patch jsonb, p_request_id text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  c_allow constant text[] := array[
    'submitter_name','capture_koaza','body_length_cm','is_juvenile','trap_number','bait_type',
    'trap_set_date','disposal_method','special_notes','photo_tail_before','photo_tail_after',
    'photo_extra','map_image','survey_downloaded_at'
  ];
  v_hash text := md5(coalesce(p_patch::text,'')); v_prior jsonb; v_iid uuid; v_row individuals; v_res jsonb;
begin
  v_prior := _idem_begin('public_capture_update_survey', p_request_id, v_hash);
  if v_prior is not null then return v_prior; end if;
  select individual_id into v_iid from submission_tokens
   where token_sha256 = encode(extensions.digest(coalesce(p_submission_token,''),'sha256'),'hex')
     and expires_at > now() limit 1;
  if v_iid is null then raise exception '提出用トークンが無効か期限切れです'; end if;
  perform _reject_unknown_keys(p_patch, c_allow);
  perform _capture_validate(p_patch);
  v_row := _ind_apply('update', v_iid, p_patch, c_allow);
  insert into individual_audit(action, actor, target_id, label_id) values ('update_survey','public', v_iid, v_row.label_id);
  v_res := jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id);
  perform _idem_store('public_capture_update_survey', p_request_id, v_hash, v_res);
  return v_res;
end;
$$;
revoke all on function public_capture_update_survey(text, jsonb, text) from public;
grant execute on function public_capture_update_survey(text, jsonb, text) to anon, authenticated;

-- ── 看板写真の紐付け: submission_token または staff token 必須・object_path のみ ──
drop function if exists public_attach_capture_photo(text, text, text);
create function public_attach_capture_photo(p_credential text, p_label_id text, p_object_path text, p_request_id text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_iid uuid; v_dt uuid; v_row individuals; v_url text; v_res jsonb;
  v_hash text := md5(coalesce(p_object_path,'')); v_prior jsonb;
begin
  v_prior := _idem_begin('public_attach_capture_photo', p_request_id, v_hash);
  if v_prior is not null then return v_prior; end if;

  if coalesce(p_object_path,'') = '' or p_object_path !~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,200}$' or p_object_path like '%..%' then
    raise exception '画像パスが不正です';
  end if;

  if coalesce(p_credential,'') like 'st\_%' then
    select individual_id into v_iid from submission_tokens
     where token_sha256 = encode(extensions.digest(p_credential,'sha256'),'hex') and expires_at > now() limit 1;
    if v_iid is null then raise exception '提出用トークンが無効か期限切れです'; end if;
  else
    v_dt := _ind_require_staff(p_credential);   -- staff/dt_ トークン
    select id into v_iid from individuals where label_id = p_label_id and deleted_at is null limit 1;
    if v_iid is null then raise exception '個体が見つかりません: %', p_label_id; end if;
  end if;

  v_url := 'https://clpdyrehdgzgiidbfucj.supabase.co/storage/v1/object/public/capture-photos/' || p_object_path;
  update individuals set image_url = v_url where id = v_iid returning * into v_row;
  insert into individual_audit(action, actor, target_id, label_id, device_token_id, after)
  values ('attach_photo', case when v_dt is null then 'public' else 'staff' end, v_iid, v_row.label_id, v_dt,
          jsonb_build_object('object_path', p_object_path));
  v_res := jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id, 'image_url', v_url);
  perform _idem_store('public_attach_capture_photo', p_request_id, v_hash, v_res);
  return v_res;
end;
$$;
revoke all on function public_attach_capture_photo(text, text, text, text) from public;
grant execute on function public_attach_capture_photo(text, text, text, text) to anon, authenticated;

-- ── スタッフ編集: 明示ホワイトリスト・許可外エラー・検証（単体update） ──
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
    'radiation_test_date','radiation_result_date','radiation_result','stopkill_pickup','serial_number'
  ];
  v_dt uuid; v_before individuals; v_row individuals;
begin
  v_dt := _ind_require_staff(p_staff_key);
  select * into v_before from individuals where id = p_id for update;
  if v_before.id is null then raise exception '個体が見つかりません'; end if;
  perform _reject_unknown_keys(p_patch, c_allow);
  v_row := _ind_apply('update', p_id, p_patch, c_allow);
  insert into individual_audit(action, actor, target_id, label_id, before, after, device_token_id)
  values ('update','staff', p_id, v_row.label_id, to_jsonb(v_before), to_jsonb(v_row), v_dt);
  return jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id);
end;
$$;
revoke all on function staff_individual_update(text, uuid, jsonb) from public;
grant execute on function staff_individual_update(text, uuid, jsonb) to anon, authenticated;

-- ── 編集+番号変更を単一トランザクションで（P1-2） ──
create or replace function staff_individual_edit(
  p_staff_key text, p_id uuid, p_patch jsonb, p_new_label text default null, p_reason text default null)
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
    'radiation_test_date','radiation_result_date','radiation_result','stopkill_pickup','serial_number'
  ];
  v_dt uuid; v_before individuals; v_row individuals; v_old text; v_new text; v_dup int;
begin
  v_dt := _ind_require_staff(p_staff_key);
  select * into v_before from individuals where id = p_id for update;   -- 行ロック
  if v_before.id is null then raise exception '個体が見つかりません'; end if;
  if v_before.deleted_at is not null then raise exception '削除済みの個体は編集できません'; end if;
  v_old := v_before.label_id;

  if p_patch is not null and p_patch <> '{}'::jsonb then
    perform _reject_unknown_keys(p_patch, c_allow);
    perform _capture_validate(p_patch);
    v_row := _ind_apply('update', p_id, p_patch, c_allow);
  else
    v_row := v_before;
  end if;

  v_new := nullif(btrim(coalesce(p_new_label,'')), '');
  if v_new is not null and v_new <> v_old then
    if v_new !~ '^[^[:space:]]{2,40}$' then raise exception '個体番号の形式が不正です'; end if;
    -- 重複確認は削除済みを含む全行（番号の再利用を禁止）
    select count(*) into v_dup from individuals where label_id = v_new and id <> p_id;
    if v_dup > 0 then raise exception '個体番号が既に使われています（削除済み含む）: %', v_new; end if;
    update individuals set label_id = v_new where id = p_id returning * into v_row;  -- FKカスケード
    update inventory set individual_code = v_new where individual_id = v_new and individual_code = v_old;
  end if;

  insert into individual_audit(action, actor, target_id, label_id, new_label_id, before, after, reason, device_token_id)
  values ('edit','staff', p_id, v_old, case when v_new is not null and v_new <> v_old then v_new else null end,
          to_jsonb(v_before), to_jsonb(v_row), p_reason, v_dt);
  return jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id,
                            'relabeled', (v_new is not null and v_new <> v_old));
end;
$$;
revoke all on function staff_individual_edit(text, uuid, jsonb, text, text) from public;
grant execute on function staff_individual_edit(text, uuid, jsonb, text, text) to anon, authenticated;

-- ── 論理削除/復元: FOR UPDATE・no-opは監査を増やさない・理由必須 ──
create or replace function staff_individual_soft_delete(p_staff_key text, p_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_dt uuid; v_row individuals;
begin
  v_dt := _ind_require_staff(p_staff_key);
  if coalesce(btrim(p_reason),'') = '' then raise exception '削除の理由を入力してください'; end if;
  select * into v_row from individuals where id = p_id for update;
  if v_row.id is null then raise exception '個体が見つかりません'; end if;
  if v_row.deleted_at is not null then
    return jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id, 'deleted_at', v_row.deleted_at, 'changed', false);
  end if;
  update individuals set deleted_at = now() where id = p_id returning * into v_row;
  insert into individual_audit(action, actor, target_id, label_id, reason, device_token_id)
  values ('soft_delete','staff', p_id, v_row.label_id, p_reason, v_dt);
  return jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id, 'deleted_at', v_row.deleted_at, 'changed', true);
end;
$$;
revoke all on function staff_individual_soft_delete(text, uuid, text) from public;
grant execute on function staff_individual_soft_delete(text, uuid, text) to anon, authenticated;

create or replace function staff_individual_restore(p_staff_key text, p_id uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_dt uuid; v_row individuals;
begin
  v_dt := _ind_require_staff(p_staff_key);
  if coalesce(btrim(p_reason),'') = '' then raise exception '復元の理由を入力してください'; end if;
  select * into v_row from individuals where id = p_id for update;
  if v_row.id is null then raise exception '個体が見つかりません'; end if;
  if v_row.deleted_at is null then
    return jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id, 'changed', false);
  end if;
  update individuals set deleted_at = null where id = p_id returning * into v_row;
  insert into individual_audit(action, actor, target_id, label_id, reason, device_token_id)
  values ('restore','staff', p_id, v_row.label_id, p_reason, v_dt);
  return jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id, 'changed', true);
end;
$$;
revoke all on function staff_individual_restore(text, uuid, text) from public;
grant execute on function staff_individual_restore(text, uuid, text) to anon, authenticated;

-- 旧 relabel は統合 edit に委譲（後方互換）
create or replace function staff_individual_relabel(p_staff_key text, p_id uuid, p_new_label text, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  return staff_individual_edit(p_staff_key, p_id, '{}'::jsonb, p_new_label, coalesce(p_reason,'個体番号変更'));
end;
$$;
revoke all on function staff_individual_relabel(text, uuid, text, text) from public;
grant execute on function staff_individual_relabel(text, uuid, text, text) to anon, authenticated;

-- ラベル指定の soft_delete/restore は理由必須化に追随（既存シグネチャ維持）
create or replace function staff_individual_soft_delete_by_label(p_staff_key text, p_label text, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  perform _ind_require_staff(p_staff_key);
  select id into v_id from individuals where label_id = p_label and deleted_at is null limit 1;
  if v_id is null then raise exception '個体が見つかりません: %', p_label; end if;
  return staff_individual_soft_delete(p_staff_key, v_id, coalesce(p_reason,'個体の削除'));
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
  return staff_individual_restore(p_staff_key, v_id, coalesce(p_reason,'個体の復元'));
end;
$$;
revoke all on function staff_individual_restore_by_label(text, text, text) from public;
grant execute on function staff_individual_restore_by_label(text, text, text) to anon, authenticated;

-- staff_individual_create も明示ホワイトリスト＋検証＋監査(device_token_id)
create or replace function staff_individual_create(p_staff_key text, p_payload jsonb)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  c_allow constant text[] := array[
    'label_id','serial_number','intake_status','species','sex','weight_total','age_estimate',
    'capture_date','capture_time','weather','capture_city','capture_area','capture_koaza',
    'hunter_name','capture_method','finishing_method','trap_part','trap_set_date','trap_number',
    'bait_type','is_juvenile','finisher_name','capture_lat','capture_lng','hit_location','bleed_time',
    'bleed_location','receive_time','transport_start','process_time','gutting','capture_anomalies',
    'hunter_health_ok','hunter_health_issues','organ_anomalies','has_fetus','quality','intake_method',
    'intake_staff','stopkill_pickup','carrier_name','recorder','memo','notes','submitter_name',
    'special_notes','disposal_method','body_length_cm','cooling_method','processing_type','organs_use',
    'hide_status','hide_location','processing_notes','aging_method','meat_rank','yield_rate',
    'buyback_base','buyback_amount','purchase_payee','image_url','butcher_staff','processing_done_at',
    'radiation_test_date','radiation_result_date','radiation_result','map_image','weather'
  ];
  v_dt uuid; v_row individuals;
begin
  v_dt := _ind_require_staff(p_staff_key);
  if coalesce(p_payload->>'label_id','') = '' then raise exception '個体管理番号は必須です'; end if;
  perform _reject_unknown_keys(p_payload, c_allow);
  perform _capture_validate(p_payload);
  v_row := _ind_apply('insert', null, p_payload, c_allow);
  insert into individual_audit(action, actor, target_id, label_id, after, device_token_id)
  values ('create','staff', v_row.id, v_row.label_id, to_jsonb(v_row), v_dt);
  return jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id);
end;
$$;
revoke all on function staff_individual_create(text, jsonb) from public;
grant execute on function staff_individual_create(text, jsonb) to anon, authenticated;
