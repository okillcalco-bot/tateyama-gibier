-- マスタの変更を「バイトが申請 → 責任者が承認したら反映」にする（追加のみ）2026-10-11
--
-- きっかけ: 「マスタ関係は全てベースをバイトさんにお願いしたい。バイトさんが作業したものを僕はチェックすればいいだけにして」（沖）
--   これまでは各画面から台帳を直接書き換えていて、確認待ちの状態も、変更履歴も無かった。
--
-- 方針
--   ・master_change_requests … 1件の申請＝1行。変更前（申請時点の台帳の値）・変更後・理由・照らした資料・申請者・承認者・日時を残す
--     → これがそのまま変更履歴になる。削除・統合・コード変更は申請できない（スタッフに開放しない）
--   ・承認は「責任者キー」（スタッフキーとは別。app_secrets にハッシュで保存。平文はどこにも残さない）
--   ・承認時に、申請後に台帳の値が変わっていたら反映しない（同時編集）。同じ行に確認待ちの申請は1件まで
--   ・責任者が自分で直すときも、同じ表に「承認済み」で残る（admin_master_apply）
--   ・表は RLS で直接触らせない。読み書きは下の RPC だけ
--
--   staff_master_request(staff_key, p)          … 申請（新規は重複の候補を返し、確認してから申請）
--   staff_master_withdraw(staff_key, id, by)     … 確認待ちの申請を取り下げ
--   staff_master_requests(staff_key, status)     … 申請の一覧（口座番号は伏せ字）
--   admin_master_requests(approver_key, status)  … 責任者用の一覧（全桁）
--   admin_master_review(approver_key, id, decision, by, note) … 承認（反映）／差戻し
--   admin_master_apply(approver_key, p)          … 責任者が直接直す（申請と承認を同時に・履歴に残る）
--   admin_set_approver_key(staff_key, current, new) … 責任者キーの設定・変更（初回はスタッフキーで設定）
--   approver_key_ok(key)                         … 照合（失敗の記録・連続失敗の検知はスタッフキーと同じ）

create table if not exists master_change_requests (
  id            uuid primary key default gen_random_uuid(),
  table_name    text not null,
  record_id     uuid,                       -- 新規は null
  action        text not null check (action in ('insert','update')),
  before        jsonb not null default '{}'::jsonb,   -- 申請時点の台帳の値（変える列だけ）
  after         jsonb not null,                       -- 変えたい値
  label         text,                       -- 一覧で見せる名前（顧客名・捕獲者名・品名など）
  reason        text,
  source_doc    text,                       -- 照らした資料（注文番号・届出書など）
  requested_by  text not null,
  requested_at  timestamptz not null default now(),
  status        text not null default '確認待ち' check (status in ('確認待ち','承認','差戻し','取下げ')),
  reviewed_by   text,
  reviewed_at   timestamptz,
  review_note   text,
  applied_record_id uuid
);
alter table master_change_requests enable row level security;
revoke all on master_change_requests from anon, authenticated;
create unique index if not exists master_change_requests_one_pending
  on master_change_requests (table_name, record_id) where status = '確認待ち' and record_id is not null;
create index if not exists master_change_requests_status_idx on master_change_requests (status, requested_at desc);

-- 申請できる表と列（ここに無い列は申請できない。コード・削除・在庫数・ポータル関係は対象外）
create or replace function master_fields(p_table text)
returns text[] language sql immutable as $$
  select case p_table
    when 'customers'      then array['name','kana','honorific','contact_name','company1','company2','phone','email','address','building','price_rank','billing_method','notes','is_active']
    when 'hunters'        then array['name','furigana','city','postal_code','address','phone','trap_area','registry_number','registered_on','document_type','has_gun',
                                     'bank_name','bank_branch','account_type','account_number','account_holder','account_furigana','memo']
    when 'price_master'   then array['species','part_name','grade','price_standard','price_local','price_startmember']
    when 'products'       then array['name','category','unit','price','base_url','memo']
    when 'supplies'       then array['name','category','unit','min_qty','supplier','memo']
    when 'equipment'      then array['name','qty','location','purchased_on','price','funding','note','status','disposed_on']
    when 'event_venues'   then array['name','kind','address','organizer','memo','is_active','sort_order','lat','lng','consignment','commission_pct','bill_to','bill_to_address']
    when 'retail_outlets' then array['name','email','memo','sort_order','is_active','delivery_notes','commission_pct']
    when 'area_master'    then array['city','district','district_note','oaza','address_label','yomi','sort_order','lat','lng','road_km_roundtrip','road_km_source']
  end
$$;
create or replace function master_label(p_table text, p jsonb)
returns text language sql immutable as $$
  select coalesce(case p_table
    when 'price_master' then concat_ws(' ', p->>'species', p->>'part_name', p->>'grade')
    when 'area_master'  then coalesce(p->>'address_label', concat_ws(' ', p->>'city', p->>'district'))
    else p->>'name' end, '')
$$;
-- 一覧で口座番号を伏せる（下2桁だけ）
create or replace function master_mask(p_table text, p jsonb)
returns jsonb language sql immutable as $$
  select case when p_table = 'hunters' and p ? 'account_number' and coalesce(p->>'account_number','') <> ''
    then jsonb_set(p, '{account_number}', to_jsonb(repeat('*', greatest(length(p->>'account_number') - 2, 0)) || right(p->>'account_number', 2)))
    else p end
$$;

-- 責任者キー
create or replace function approver_key_ok(p_key text)
returns boolean language plpgsql volatile security definer set search_path to 'public', 'extensions'
as $$
declare v_hash text; v_ok boolean; v_fail int;
begin
  select hash into v_hash from app_secrets where key = 'approver_key';
  v_ok := v_hash is not null and v_hash = extensions.crypt(coalesce(p_key,''), v_hash);
  if v_ok then insert into auth_attempts (kind, ok) values ('approver_key', true); return true; end if;
  perform pg_advisory_xact_lock(hashtext('auth:approver_key'));
  select count(*) into v_fail from auth_attempts where kind = 'approver_key' and not ok and created_at > now() - interval '5 minutes';
  insert into auth_attempts (kind, ok) values ('approver_key', false);
  if v_fail >= 10 then insert into security_events (event, detail) values ('approver_key_bruteforce', '5分に誤り多数'); end if;
  return false;
end $$;

create or replace function admin_set_approver_key(p_staff_key text, p_current text, p_new text)
returns jsonb language plpgsql volatile security definer set search_path to 'public', 'extensions'
as $$
declare v_exists boolean;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  select exists(select 1 from app_secrets where key = 'approver_key') into v_exists;
  if v_exists and not approver_key_ok(p_current) then raise exception '今の責任者キーが違います'; end if;
  if length(coalesce(p_new,'')) < 8 then raise exception '責任者キーは8文字以上にしてください'; end if;
  if staff_key_ok(p_new) then raise exception '責任者キーはスタッフキーと別のものにしてください'; end if;
  insert into app_secrets (key, hash) values ('approver_key', extensions.crypt(p_new, extensions.gen_salt('bf')))
  on conflict (key) do update set hash = excluded.hash;
  insert into security_events (event, detail) values ('approver_key_set', case when v_exists then '変更' else '初回設定' end);
  return jsonb_build_object('ok', true, 'first', not v_exists);
end $$;

-- 申請の検証（列・型・重複）。戻り値: 正規化した after
create or replace function master_check(p_table text, p_after jsonb)
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $$
declare v_fields text[] := master_fields(p_table); k text; v_out jsonb := '{}'::jsonb;
begin
  if v_fields is null then raise exception 'この表は申請できません: %', p_table; end if;
  if jsonb_typeof(p_after) is distinct from 'object' or p_after = '{}'::jsonb then raise exception '変更する項目がありません'; end if;
  for k in select jsonb_object_keys(p_after) loop
    if not k = any(v_fields) then raise exception '「%」はこの画面からは変更できません', k; end if;
    v_out := v_out || jsonb_build_object(k, case when jsonb_typeof(p_after->k) = 'string' and btrim(p_after->>k) = '' then 'null'::jsonb else p_after->k end);
  end loop;
  -- 型の確認（入らない値はここで落とす）
  execute format('select jsonb_populate_record(null::%I, $1)', p_table) using v_out;
  if p_table = 'hunters' and coalesce(v_out->>'account_number','') <> '' and (v_out->>'account_number') !~ '^\d{1,8}$' then
    raise exception '口座番号は数字だけで入れてください（先頭の0もそのまま）'; end if;
  return v_out;
end $$;

create or replace function staff_master_request(p_staff_key text, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_table text := p->>'table'; v_rec uuid := nullif(p->>'record_id','')::uuid; v_after jsonb; v_cur jsonb; v_before jsonb := '{}'::jsonb;
        k text; v_id uuid; v_dup jsonb := '[]'::jsonb; v_by text := btrim(coalesce(p->>'requested_by',''));
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if v_by = '' then raise exception '申請者の名前を入れてください'; end if;
  v_after := master_check(v_table, p->'after');
  if v_rec is not null then
    execute format('select to_jsonb(t) from %I t where id = $1', v_table) into v_cur using v_rec;
    if v_cur is null then raise exception '対象が見つかりません（削除された可能性）'; end if;
    -- 変わらない項目は申請に入れない。変更前の値を残す
    for k in select jsonb_object_keys(v_after) loop
      if (v_cur->k) is not distinct from (v_after->k) then v_after := v_after - k;
      else v_before := v_before || jsonb_build_object(k, v_cur->k); end if;
    end loop;
    if v_after = '{}'::jsonb then return jsonb_build_object('ok', false, 'error', '台帳と同じ内容です（変更がありません）'); end if;
    if exists (select 1 from master_change_requests where table_name = v_table and record_id = v_rec and status = '確認待ち') then
      return jsonb_build_object('ok', false, 'error', 'この行には確認待ちの申請がすでにあります（責任者の確認を待つか、取り下げてから）'); end if;
  else
    -- 新規: 重複の候補（同じ名前・同じ電話）を返す。確認したうえで confirm_dup=true で申請
    execute format($q$select coalesce(jsonb_agg(jsonb_build_object('id', id, 'label', %s)), '[]'::jsonb) from %I t
                     where %s and coalesce((to_jsonb(t)->>'deleted_at'), '') = '' limit 10$q$,
       case v_table when 'price_master' then $l$concat_ws(' ', species, part_name, grade)$l$ when 'area_master' then 'address_label' else 'name' end, v_table,
       case v_table
         when 'price_master' then format('species = %L and part_name = %L and coalesce(grade,%L) = coalesce(%L,%L)', v_after->>'species', v_after->>'part_name', '', v_after->>'grade', '')
         when 'area_master'  then format('address_label = %L', v_after->>'address_label')
         when 'customers'    then format($c$(regexp_replace(name,'\s','','g') = regexp_replace(%L,'\s','','g') or (length(regexp_replace(coalesce(phone,''),'\D','','g')) >= 9 and regexp_replace(coalesce(phone,''),'\D','','g') = regexp_replace(%L,'\D','','g')))$c$, v_after->>'name', coalesce(v_after->>'phone','x'))
         else format($c$regexp_replace(name,'\s','','g') = regexp_replace(%L,'\s','','g')$c$, v_after->>'name') end)
      into v_dup;
    if jsonb_array_length(v_dup) > 0 and coalesce((p->>'confirm_dup')::boolean, false) = false then
      return jsonb_build_object('ok', false, 'need_confirm', true, 'dup', v_dup, 'error', '似た登録がすでにあります。同じものでないか確認してください');
    end if;
    if v_table = 'price_master' and jsonb_array_length(v_dup) > 0 then
      return jsonb_build_object('ok', false, 'dup', v_dup, 'error', '同じ鳥獣種・部位・等級の価格がすでにあります（新規ではなく変更で申請してください）'); end if;
  end if;
  insert into master_change_requests (table_name, record_id, action, before, after, label, reason, source_doc, requested_by)
  values (v_table, v_rec, case when v_rec is null then 'insert' else 'update' end, v_before, v_after,
          left(master_label(v_table, coalesce(v_cur, '{}'::jsonb) || v_after), 80),
          nullif(btrim(coalesce(p->>'reason','')),''), nullif(btrim(coalesce(p->>'source_doc','')),''), left(v_by, 40))
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'dup', v_dup);
end $$;

create or replace function staff_master_withdraw(p_staff_key text, p_id uuid, p_by text)
returns jsonb language plpgsql volatile security definer set search_path to 'public'
as $$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  update master_change_requests set status = '取下げ', reviewed_by = left(coalesce(p_by,''),40), reviewed_at = now()
   where id = p_id and status = '確認待ち';
  if not found then return jsonb_build_object('ok', false, 'error', '確認待ちの申請が見つかりません（もう確認された可能性）'); end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function master_requests_json(p_status text, p_mask boolean)
returns jsonb language sql stable security definer set search_path to 'public'
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', r.id, 'table', r.table_name, 'record_id', r.record_id, 'action', r.action, 'label', r.label,
      'before', case when p_mask then master_mask(r.table_name, r.before) else r.before end,
      'after',  case when p_mask then master_mask(r.table_name, r.after)  else r.after  end,
      'reason', r.reason, 'source_doc', r.source_doc, 'requested_by', r.requested_by,
      'requested_at', to_char(r.requested_at at time zone 'Asia/Tokyo', 'YYYY/MM/DD HH24:MI'),
      'status', r.status, 'reviewed_by', r.reviewed_by,
      'reviewed_at', to_char(r.reviewed_at at time zone 'Asia/Tokyo', 'YYYY/MM/DD HH24:MI'), 'review_note', r.review_note)
      order by r.requested_at desc), '[]'::jsonb)
  from (select * from master_change_requests
         where (coalesce(p_status,'') = '' or status = p_status)
         order by requested_at desc limit 500) r
$$;
revoke execute on function master_requests_json(text, boolean) from anon, authenticated, public;

create or replace function staff_master_requests(p_staff_key text, p_status text default '確認待ち')
returns jsonb language plpgsql volatile security definer set search_path to 'public'
as $$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  return master_requests_json(p_status, true);
end $$;

create or replace function admin_master_requests(p_approver_key text, p_status text default '確認待ち')
returns jsonb language plpgsql volatile security definer set search_path to 'public'
as $$
begin
  if not approver_key_ok(p_approver_key) then raise exception '責任者キーが違います'; end if;
  return master_requests_json(p_status, false);
end $$;

-- 反映（承認・直接の両方から使う。外からは呼べない）
create or replace function master_apply_row(p_req master_change_requests)
returns uuid language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_cur jsonb; k text; v_cols text; v_id uuid; v_code text;
begin
  v_cols := (select string_agg(format('%I', c), ', ') from jsonb_object_keys(p_req.after) c);
  if p_req.action = 'update' then
    execute format('select to_jsonb(t) from %I t where id = $1 for update', p_req.table_name) into v_cur using p_req.record_id;
    if v_cur is null then raise exception '対象が見つかりません（削除された可能性）。反映していません'; end if;
    for k in select jsonb_object_keys(p_req.before) loop
      if (v_cur->k) is distinct from (p_req.before->k) then
        raise exception '申請の後に台帳の「%」が変わっています。反映していません（申請し直してください）', k; end if;
    end loop;
    execute format('update %I t set (%s) = (select %s from jsonb_populate_record(null::%I, $2)) where id = $1',
                   p_req.table_name, v_cols, v_cols, p_req.table_name) using p_req.record_id, p_req.after;
    return p_req.record_id;
  else
    if p_req.table_name = 'customers' then
      perform pg_advisory_xact_lock(hashtext('customers:code'));
      select 'C' || lpad((coalesce(max(substring(code from '^C(\d{1,6})$')::int), 0) + 1)::text, 4, '0') into v_code from customers;
      execute format('insert into customers (code, %s) select $2, %s from jsonb_populate_record(null::customers, $1) returning id', v_cols, v_cols)
        into v_id using p_req.after, v_code;
    else
      execute format('insert into %I (%s) select %s from jsonb_populate_record(null::%I, $1) returning id',
                     p_req.table_name, v_cols, v_cols, p_req.table_name) into v_id using p_req.after;
    end if;
    return v_id;
  end if;
end $$;
revoke execute on function master_apply_row(master_change_requests) from anon, authenticated, public;

create or replace function admin_master_review(p_approver_key text, p_id uuid, p_decision text, p_by text, p_note text default null)
returns jsonb language plpgsql volatile security definer set search_path to 'public'
as $$
declare r master_change_requests; v_id uuid;
begin
  if not approver_key_ok(p_approver_key) then raise exception '責任者キーが違います'; end if;
  if coalesce(btrim(p_by),'') = '' then raise exception '確認した人の名前を入れてください'; end if;
  select * into r from master_change_requests where id = p_id for update;
  if not found or r.status <> '確認待ち' then return jsonb_build_object('ok', false, 'error', 'この申請はもう確認待ちではありません'); end if;
  if p_decision = '差戻し' then
    if coalesce(btrim(p_note),'') = '' then raise exception '差戻しの理由を書いてください'; end if;
    update master_change_requests set status = '差戻し', reviewed_by = left(p_by,40), reviewed_at = now(), review_note = p_note where id = p_id;
    return jsonb_build_object('ok', true);
  elsif p_decision = '承認' then
    v_id := master_apply_row(r);
    update master_change_requests set status = '承認', reviewed_by = left(p_by,40), reviewed_at = now(), review_note = nullif(btrim(coalesce(p_note,'')),''),
           applied_record_id = v_id where id = p_id;
    return jsonb_build_object('ok', true, 'record_id', v_id);
  end if;
  raise exception '承認か差戻しを選んでください';
end $$;

create or replace function admin_master_apply(p_approver_key text, p jsonb)
returns jsonb language plpgsql volatile security definer set search_path to 'public'
as $$
declare v_table text := p->>'table'; v_rec uuid := nullif(p->>'record_id','')::uuid; v_after jsonb; v_cur jsonb; v_before jsonb := '{}'::jsonb;
        k text; r master_change_requests; v_by text := btrim(coalesce(p->>'requested_by',''));
begin
  if not approver_key_ok(p_approver_key) then raise exception '責任者キーが違います'; end if;
  if v_by = '' then raise exception '名前を入れてください'; end if;
  v_after := master_check(v_table, p->'after');
  if v_rec is not null then
    execute format('select to_jsonb(t) from %I t where id = $1', v_table) into v_cur using v_rec;
    if v_cur is null then raise exception '対象が見つかりません'; end if;
    for k in select jsonb_object_keys(v_after) loop
      if (v_cur->k) is not distinct from (v_after->k) then v_after := v_after - k; else v_before := v_before || jsonb_build_object(k, v_cur->k); end if;
    end loop;
    if v_after = '{}'::jsonb then return jsonb_build_object('ok', true, 'record_id', v_rec, 'nochange', true); end if;
    -- 画面を開いた時の値（p.before）と今の台帳が違えば止める（同時編集）
    if p ? 'before' then
      for k in select jsonb_object_keys(p->'before') loop
        if (v_cur->k) is distinct from (p->'before'->k) then raise exception '開いた後に台帳の「%」が変わっています。保存していません', k; end if;
      end loop;
    end if;
    if exists (select 1 from master_change_requests where table_name = v_table and record_id = v_rec and status = '確認待ち') then
      raise exception 'この行には確認待ちの申請があります。先に申請を確認してください'; end if;
  end if;
  insert into master_change_requests (table_name, record_id, action, before, after, label, reason, source_doc, requested_by, status, reviewed_by, reviewed_at)
  values (v_table, v_rec, case when v_rec is null then 'insert' else 'update' end, v_before, v_after,
          left(master_label(v_table, coalesce(v_cur, '{}'::jsonb) || v_after), 80), nullif(btrim(coalesce(p->>'reason','')),''),
          nullif(btrim(coalesce(p->>'source_doc','')),''), left(v_by,40), '確認待ち', null, null)
  returning * into r;
  r.applied_record_id := master_apply_row(r);
  update master_change_requests set status = '承認', reviewed_by = left(v_by,40), reviewed_at = now(), applied_record_id = r.applied_record_id,
         review_note = '責任者が直接変更' where id = r.id;
  return jsonb_build_object('ok', true, 'record_id', r.applied_record_id, 'id', r.id);
end $$;

grant execute on function staff_master_request(text, jsonb), staff_master_withdraw(text, uuid, text), staff_master_requests(text, text),
  admin_master_requests(text, text), admin_master_review(text, uuid, text, text, text), admin_master_apply(text, jsonb),
  admin_set_approver_key(text, text, text) to anon, authenticated;
revoke execute on function approver_key_ok(text) from anon, authenticated, public;
