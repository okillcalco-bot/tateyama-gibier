-- 20260815_individuals_write_rpcs.sql
-- Codex セキュリティレビュー P0-2 / P1-2 対応（段階1: 追加のみ・非破壊）
--
-- 目的: individuals への「anon 直接 UPDATE（任意改ざん）」経路を、監査つきの
--   RPC 経由へ置き換える土台を作る。本マイグレーションは *追加のみ*。
--   anon の直接 INSERT/UPDATE 権限はまだ剥奪しない（クライアント移行→本番確認の後、
--   別マイグレーションで剥奪する。Codex指定の段階的ロールアウト）。
--
-- 作るもの:
--   1. individual_audit         … individuals への書込監査（追記のみ）
--   2. request_log              … client_request_id による冪等化
--   3. _ind_require_staff()     … staff_key 照合（既存 staff_key_ok を再利用）
--   4. _ind_apply()            … 列ホワイトリストで jsonb→行 を安全に INSERT/UPDATE
--   5. public_capture_submit()  … 一般捕獲者の登録（INSERT/空枠うめ・列限定・冪等）
--   6. public_attach_capture_photo() … 看板写真URLの紐付け（image_url のみ）
--   7. staff_individual_update()      … スタッフ編集（広い列・監査）
--   8. staff_individual_soft_delete() … 論理削除（理由つき監査）
--   9. staff_individual_restore()     … 復元（理由つき監査）
--  10. staff_individual_relabel()     … 個体番号変更（単一Tx・在庫コード同期・監査）
--
-- すべて SECURITY DEFINER / search_path 固定 / PUBLIC からの EXECUTE 剥奪。
-- 認証: スタッフ操作は staff_key（既存 app_secrets の bcrypt ハッシュ）で照合。

-- ── 監査表（追記のみ・anonポリシーなし＝RPC経由でのみ書ける） ──────────
create table if not exists individual_audit (
  id           bigint generated always as identity primary key,
  action       text not null,          -- submit / update / soft_delete / restore / relabel / attach_photo
  actor        text not null,          -- 'public' | 'staff'
  target_id    uuid,
  label_id     text,
  new_label_id text,
  reason       text,
  before       jsonb,
  after        jsonb,
  created_at   timestamptz not null default now()
);
alter table individual_audit enable row level security;
create index if not exists individual_audit_target on individual_audit (target_id, created_at);

-- ── 冪等化（同じ client_request_id の再送は既存結果を返す） ────────────
create table if not exists request_log (
  client_request_id text primary key,
  fn         text not null,
  result     jsonb,
  created_at timestamptz not null default now()
);
alter table request_log enable row level security;

-- ── スタッフ認証ヘルパ（既存 staff_key_ok を利用。失敗時は例外） ────────
create or replace function _ind_require_staff(p_staff_key text)
returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not staff_key_ok(p_staff_key) then
    raise exception 'スタッフキーが違います' using errcode = '28000';
  end if;
end;
$$;
revoke all on function _ind_require_staff(text) from public;

-- ── jsonb を列ホワイトリストで安全に INSERT/UPDATE する内部ヘルパ ───────
-- 値は quote_literal、列名は quote_ident、型はカタログ(format_type)から取得。
-- これにより任意キーの混入・SQLインジェクションを防ぐ。p_allow に無い列は無視。
create or replace function _ind_apply(
  p_mode    text,      -- 'insert' | 'update'
  p_id      uuid,      -- update時の対象
  p_payload jsonb,
  p_allow   text[]     -- 許可する列名
) returns individuals
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_key text; v_type text; v_val text;
  v_cols text := ''; v_vals text := ''; v_set text := '';
  v_row individuals;
begin
  for v_key in select jsonb_object_keys(p_payload) loop
    if not (v_key = any(p_allow)) then continue; end if;
    select format_type(a.atttypid, a.atttypmod) into v_type
      from pg_attribute a
     where a.attrelid = 'public.individuals'::regclass
       and a.attname = v_key and a.attnum > 0 and not a.attisdropped;
    if v_type is null then continue; end if;   -- 存在しない列は無視
    if jsonb_typeof(p_payload -> v_key) = 'null' then
      v_val := 'NULL::' || v_type;
    else
      v_val := quote_literal(p_payload ->> v_key) || '::' || v_type;
    end if;
    if p_mode = 'insert' then
      v_cols := v_cols || case when v_cols = '' then '' else ',' end || quote_ident(v_key);
      v_vals := v_vals || case when v_vals = '' then '' else ',' end || v_val;
    else
      v_set := v_set || case when v_set = '' then '' else ',' end || quote_ident(v_key) || '=' || v_val;
    end if;
  end loop;

  if p_mode = 'insert' then
    if v_cols = '' then raise exception '登録する項目がありません'; end if;
    execute format('insert into individuals (%s) values (%s) returning *', v_cols, v_vals) into v_row;
  else
    if v_set = '' then
      select * into v_row from individuals where id = p_id;   -- 変更なし
    else
      execute format('update individuals set %s where id = %L returning *', v_set, p_id) into v_row;
    end if;
  end if;
  return v_row;
end;
$$;
revoke all on function _ind_apply(text, uuid, jsonb, text[]) from public;

-- ── 一般捕獲者の登録（列限定・空枠うめ・冪等） ────────────────────────
-- 許可列は「捕獲票入力フォームが送る項目」に限定。買取金額・肉ランク・歩留まり・
-- 放射能結果・deleted_at 等の業務/監査項目は *設定不可*（改ざん防止）。
create or replace function public_capture_submit(
  p_payload jsonb,
  p_request_id text default null
) returns jsonb
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
    'notes','submitter_name','special_notes','disposal_method','body_length_cm','map_image',
    'photo_tail_before','photo_tail_after','photo_extra'
  ];
  v_label   text := p_payload ->> 'label_id';
  v_species text := p_payload ->> 'species';
  v_serial  int  := nullif(p_payload ->> 'serial_number','')::int;
  v_ph_id   uuid;
  v_row     individuals;
  v_prior   jsonb;
begin
  -- 冪等: 同じ client_request_id は既存結果を返す
  if p_request_id is not null and p_request_id <> '' then
    select result into v_prior from request_log where client_request_id = p_request_id;
    if v_prior is not null then return v_prior; end if;
  end if;

  -- イノシシの正式番号は「空枠（通し番号だけ・捕獲日なし）」があればそこへ入れる。
  -- 空枠の特定はサーバ側で行い、クライアントから対象行IDは受け取らない（改ざん防止）。
  if coalesce(v_label,'') not like '仮-%' and v_species = 'イノシシ' and v_serial is not null then
    perform pg_advisory_xact_lock(hashtext('ind_serial_fill'));
    select id into v_ph_id from individuals
     where species = 'イノシシ' and serial_number = v_serial
       and capture_date is null and deleted_at is null
     order by created_at nulls first limit 1;
  end if;

  if v_ph_id is not null then
    v_row := _ind_apply('update', v_ph_id, p_payload, c_allow);
  else
    v_row := _ind_apply('insert', null, p_payload, c_allow);
  end if;

  insert into individual_audit(action, actor, target_id, label_id, after)
  values (case when v_ph_id is not null then 'submit_fill' else 'submit' end,
          'public', v_row.id, v_row.label_id, to_jsonb(v_row));

  declare v_res jsonb := jsonb_build_object(
      'id', v_row.id, 'label_id', v_row.label_id, 'serial_number', v_row.serial_number);
  begin
    if p_request_id is not null and p_request_id <> '' then
      insert into request_log(client_request_id, fn, result)
      values (p_request_id, 'public_capture_submit', v_res)
      on conflict (client_request_id) do nothing;
    end if;
    return v_res;
  end;
end;
$$;
revoke all on function public_capture_submit(jsonb, text) from public;
grant execute on function public_capture_submit(jsonb, text) to anon, authenticated;

-- ── 看板写真URLの紐付け（image_url のみ・列限定） ─────────────────────
create or replace function public_attach_capture_photo(
  p_label_id text,
  p_image_url text,
  p_request_id text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_row individuals; v_prior jsonb;
begin
  if p_request_id is not null and p_request_id <> '' then
    select result into v_prior from request_log where client_request_id = p_request_id;
    if v_prior is not null then return v_prior; end if;
  end if;
  update individuals set image_url = p_image_url
   where label_id = p_label_id and deleted_at is null
   returning * into v_row;
  if v_row.id is null then raise exception '個体が見つかりません: %', p_label_id; end if;
  insert into individual_audit(action, actor, target_id, label_id, after)
  values ('attach_photo','public', v_row.id, v_row.label_id,
          jsonb_build_object('image_url', p_image_url));
  declare v_res jsonb := jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id);
  begin
    if p_request_id is not null and p_request_id <> '' then
      insert into request_log(client_request_id, fn, result)
      values (p_request_id, 'public_attach_capture_photo', v_res) on conflict do nothing;
    end if;
    return v_res;
  end;
end;
$$;
revoke all on function public_attach_capture_photo(text, text, text) from public;
grant execute on function public_attach_capture_photo(text, text, text) to anon, authenticated;

-- ── 調査票の追記（提出者本人が自分の登録個体へ調査票項目/写真を紐付け・列限定） ──
-- 買取・肉ランク・放射能等の業務/監査項目は対象外（改ざん防止）。
create or replace function public_capture_update_survey(
  p_label_id text,
  p_patch jsonb,
  p_request_id text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  c_allow constant text[] := array[
    'submitter_name','capture_koaza','body_length_cm','is_juvenile','trap_number',
    'bait_type','trap_set_date','disposal_method','special_notes',
    'photo_tail_before','photo_tail_after','photo_extra','map_image','survey_downloaded_at'
  ];
  v_id uuid; v_row individuals; v_prior jsonb;
begin
  if p_request_id is not null and p_request_id <> '' then
    select result into v_prior from request_log where client_request_id = p_request_id;
    if v_prior is not null then return v_prior; end if;
  end if;
  select id into v_id from individuals where label_id = p_label_id and deleted_at is null limit 1;
  if v_id is null then raise exception '個体が見つかりません: %', p_label_id; end if;
  v_row := _ind_apply('update', v_id, p_patch, c_allow);
  insert into individual_audit(action, actor, target_id, label_id)
  values ('update_survey','public', v_id, p_label_id);
  declare v_res jsonb := jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id);
  begin
    if p_request_id is not null and p_request_id <> '' then
      insert into request_log(client_request_id, fn, result)
      values (p_request_id, 'public_capture_update_survey', v_res) on conflict do nothing;
    end if;
    return v_res;
  end;
end;
$$;
revoke all on function public_capture_update_survey(text, jsonb, text) from public;
grant execute on function public_capture_update_survey(text, jsonb, text) to anon, authenticated;

-- ── スタッフ編集（広い列・監査。id/created_at/label_id/deleted_at は変更不可） ──
create or replace function staff_individual_update(
  p_staff_key text,
  p_id uuid,
  p_patch jsonb
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_allow text[];
  v_before individuals; v_row individuals;
begin
  perform _ind_require_staff(p_staff_key);
  select * into v_before from individuals where id = p_id;
  if v_before.id is null then raise exception '個体が見つかりません'; end if;
  -- 許可列 = individuals の全列 − 保護列（採番/監査/論理削除は専用RPCで扱う）
  select array_agg(a.attname::text) into v_allow
    from pg_attribute a
   where a.attrelid = 'public.individuals'::regclass and a.attnum > 0 and not a.attisdropped
     and a.attname not in ('id','created_at','label_id','deleted_at');
  v_row := _ind_apply('update', p_id, p_patch, v_allow);
  insert into individual_audit(action, actor, target_id, label_id, before, after)
  values ('update','staff', p_id, v_row.label_id, to_jsonb(v_before), to_jsonb(v_row));
  return jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id);
end;
$$;
revoke all on function staff_individual_update(text, uuid, jsonb) from public;
grant execute on function staff_individual_update(text, uuid, jsonb) to anon, authenticated;

-- ── 論理削除（理由つき監査） ──────────────────────────────────────────
create or replace function staff_individual_soft_delete(
  p_staff_key text,
  p_id uuid,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_row individuals;
begin
  perform _ind_require_staff(p_staff_key);
  update individuals set deleted_at = now()
   where id = p_id and deleted_at is null returning * into v_row;
  if v_row.id is null then
    -- 既に削除済みか存在しない
    select * into v_row from individuals where id = p_id;
    if v_row.id is null then raise exception '個体が見つかりません'; end if;
  end if;
  insert into individual_audit(action, actor, target_id, label_id, reason)
  values ('soft_delete','staff', p_id, v_row.label_id, p_reason);
  return jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id, 'deleted_at', v_row.deleted_at);
end;
$$;
revoke all on function staff_individual_soft_delete(text, uuid, text) from public;
grant execute on function staff_individual_soft_delete(text, uuid, text) to anon, authenticated;

-- ── 復元（理由つき監査） ──────────────────────────────────────────────
create or replace function staff_individual_restore(
  p_staff_key text,
  p_id uuid,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_row individuals;
begin
  perform _ind_require_staff(p_staff_key);
  update individuals set deleted_at = null
   where id = p_id returning * into v_row;
  if v_row.id is null then raise exception '個体が見つかりません'; end if;
  insert into individual_audit(action, actor, target_id, label_id, reason)
  values ('restore','staff', p_id, v_row.label_id, p_reason);
  return jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id);
end;
$$;
revoke all on function staff_individual_restore(text, uuid, text) from public;
grant execute on function staff_individual_restore(text, uuid, text) to anon, authenticated;

-- ── 個体番号の変更（単一Tx・FKカスケード・在庫コード同期・監査） ─────────
-- label_id を更新すると inventory.individual_id / processing_log.individual_id は
-- FK ON UPDATE CASCADE で自動追随する。非正規化列 inventory.individual_code のみ手動同期。
-- ident_code / lot_code / parent_ident_code / child_ident_code は通し番号由来で
-- 個体番号(label_id)とは無関係のため触らない（Codex指摘のとおり）。
create or replace function staff_individual_relabel(
  p_staff_key text,
  p_id uuid,
  p_new_label text,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_old text; v_row individuals; v_dup int;
begin
  perform _ind_require_staff(p_staff_key);
  if coalesce(trim(p_new_label),'') = '' then raise exception '新しい個体番号が空です'; end if;

  select label_id into v_old from individuals where id = p_id for update;
  if v_old is null then raise exception '個体が見つかりません'; end if;
  if v_old = p_new_label then
    return jsonb_build_object('id', p_id, 'label_id', v_old, 'changed', false);
  end if;

  select count(*) into v_dup from individuals
   where label_id = p_new_label and id <> p_id and deleted_at is null;
  if v_dup > 0 then raise exception '個体番号が重複します: %', p_new_label; end if;

  update individuals set label_id = p_new_label where id = p_id returning * into v_row; -- FKカスケード
  update inventory set individual_code = p_new_label
   where individual_id = p_new_label and individual_code = v_old;  -- 非正規化コード同期

  insert into individual_audit(action, actor, target_id, label_id, new_label_id, reason)
  values ('relabel','staff', p_id, v_old, p_new_label, p_reason);
  return jsonb_build_object('id', v_row.id, 'label_id', v_row.label_id, 'changed', true);
end;
$$;
revoke all on function staff_individual_relabel(text, uuid, text, text) from public;
grant execute on function staff_individual_relabel(text, uuid, text, text) to anon, authenticated;
