-- 相談ONCONFLICT修正 ＋ イノシシ上/極上を予約商品として追加 ＋ 掲示板に画像対応
-- 追加のみ（image_url列追加・関数再定義）。本番適用済み。
-- ロールバック: migrations/rollback/20260818_portal_ranks_bulletin_image_rollback.sql

-- ① 相談送信の ON CONFLICT を部分ユニークインデックスの述語に合わせる
create or replace function portal_submit_inquiry(p_token text, p_body text, p_request_id text default null)
returns jsonb language plpgsql security definer set search_path to 'public' as $$
declare v_cid uuid := portal_session_customer(p_token); v_id uuid;
begin
  if v_cid is null then raise exception 'ログインし直してください'; end if;
  perform portal_session_touch(p_token);
  if p_body is null or length(btrim(p_body))=0 then raise exception 'ご相談内容を入力してください'; end if;
  if length(p_body) > 1000 then raise exception 'ご相談は1000文字までにしてください'; end if;
  insert into portal_inquiries (customer_id, body, client_request_id)
  values (v_cid, btrim(p_body),
          case when p_request_id is not null and length(p_request_id) between 8 and 64 then p_request_id end)
  on conflict (customer_id, client_request_id) where client_request_id is not null
    do update set body=excluded.body, updated_at=now()
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;
grant execute on function portal_submit_inquiry(text,text,text) to anon;

-- ② イノシシ 上・極上ランクを予約(reserve_only)商品として追加
with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('イノシシ','猪ロース（上）','上','上位ランク。ご予約で承ります',710,0.5,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',4750 from ins union all select id,'local',4125 from ins union all select id,'startmember',4125 from ins;
with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('イノシシ','猪ロース（極上）','極上','上位ランク。ご予約で承ります',720,0.5,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',5700 from ins union all select id,'local',4950 from ins union all select id,'startmember',4950 from ins;
with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('イノシシ','猪肩ロース（上）','上','上位ランク。ご予約で承ります',730,0.5,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',3875 from ins union all select id,'local',3500 from ins union all select id,'startmember',3500 from ins;
with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('イノシシ','猪肩ロース（極上）','極上','上位ランク。ご予約で承ります',740,0.5,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',4650 from ins union all select id,'local',4200 from ins union all select id,'startmember',4200 from ins;
with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('イノシシ','猪バラ（上）','上','上位ランク。ご予約で承ります',750,0.5,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',3875 from ins union all select id,'local',3500 from ins union all select id,'startmember',3500 from ins;
with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('イノシシ','猪バラ（極上）','極上','上位ランク。ご予約で承ります',760,0.5,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',4650 from ins union all select id,'local',4200 from ins union all select id,'startmember',4200 from ins;
with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('イノシシ','猪モモ（上）','上','上位ランク。ご予約で承ります',770,0.5,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',3250 from ins union all select id,'local',3000 from ins union all select id,'startmember',3000 from ins;
with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('イノシシ','猪モモ（極上）','極上','上位ランク。ご予約で承ります',780,0.5,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',3900 from ins union all select id,'local',3600 from ins union all select id,'startmember',3600 from ins;
with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('イノシシ','猪ヒレ（上）','上','上位ランク。ご予約で承ります',790,0.5,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',4750 from ins union all select id,'local',4125 from ins union all select id,'startmember',4125 from ins;
with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('イノシシ','猪ヒレ（極上）','極上','上位ランク。ご予約で承ります',800,0.5,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',5700 from ins union all select id,'local',4950 from ins union all select id,'startmember',4950 from ins;
with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('イノシシ','猪カタ（ウデ）（上）','上','上位ランク。ご予約で承ります',810,0.5,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',2750 from ins union all select id,'local',2625 from ins union all select id,'startmember',2625 from ins;
with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('イノシシ','猪カタ（ウデ）（極上）','極上','上位ランク。ご予約で承ります',820,0.5,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',3300 from ins union all select id,'local',3150 from ins union all select id,'startmember',3150 from ins;
with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('イノシシ','猪ネック（上）','上','上位ランク。ご予約で承ります',830,0.5,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',2250 from ins union all select id,'local',2250 from ins union all select id,'startmember',2250 from ins;
with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('イノシシ','猪ネック（極上）','極上','上位ランク。ご予約で承ります',840,0.5,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',2700 from ins union all select id,'local',2700 from ins union all select id,'startmember',2700 from ins;
with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('イノシシ','猪スネ（上）','上','上位ランク。ご予約で承ります',850,0.5,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',2000 from ins union all select id,'local',1875 from ins union all select id,'startmember',1875 from ins;
with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('イノシシ','猪スネ（極上）','極上','上位ランク。ご予約で承ります',860,0.5,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',2400 from ins union all select id,'local',2250 from ins union all select id,'startmember',2250 from ins;
with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('イノシシ','猪ミンチ用（上）','上','上位ランク。ご予約で承ります',870,0.5,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',2000 from ins union all select id,'local',1875 from ins union all select id,'startmember',1875 from ins;
with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('イノシシ','猪ミンチ用（極上）','極上','上位ランク。ご予約で承ります',880,0.5,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',2400 from ins union all select id,'local',2250 from ins union all select id,'startmember',2250 from ins;

-- ③ 掲示板に画像（image_url。管理画面から縮小したdataURLを保存）
alter table portal_bulletins add column if not exists image_url text;

drop function if exists portal_bulletins();
create or replace function portal_bulletins()
returns table(id uuid, product_id uuid, title text, body text, badge text,
              sort_order int, created_at timestamptz, image_url text)
language sql stable security definer set search_path to 'public' as $$
  select b.id, b.product_id, b.title, b.body, b.badge, b.sort_order, b.created_at, b.image_url
    from portal_bulletins b where b.is_active order by b.sort_order, b.created_at desc;
$$;
grant execute on function portal_bulletins() to anon;

drop function if exists admin_list_bulletins(text);
create or replace function admin_list_bulletins(p_staff_key text)
returns table(id uuid, product_id uuid, product_name text, title text, body text,
              badge text, sort_order int, is_active boolean, created_at timestamptz, image_url text)
language plpgsql security definer set search_path to 'public' as $$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  return query
    select b.id, b.product_id, p.display_name, b.title, b.body, b.badge,
           b.sort_order, b.is_active, b.created_at, b.image_url
      from portal_bulletins b
      left join portal_products p on p.id = b.product_id
     order by b.is_active desc, b.sort_order, b.created_at desc;
end;
$$;
grant execute on function admin_list_bulletins(text) to anon;

create or replace function admin_upsert_bulletin(p_staff_key text, p jsonb)
returns uuid language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if length(coalesce(p->>'image_url','')) > 700000 then raise exception '画像が大きすぎます（縮小してください）'; end if;
  if p->>'id' is not null then
    v_id := (p->>'id')::uuid;
    update portal_bulletins set
      product_id = case when p ? 'product_id' then nullif(p->>'product_id','')::uuid else product_id end,
      title      = case when p ? 'title' then nullif(p->>'title','') else title end,
      body       = case when p ? 'body' then nullif(p->>'body','') else body end,
      badge      = case when p ? 'badge' then nullif(p->>'badge','') else badge end,
      image_url  = case when p ? 'image_url' then nullif(p->>'image_url','') else image_url end,
      sort_order = coalesce((p->>'sort_order')::int, sort_order),
      is_active  = coalesce((p->>'is_active')::boolean, is_active),
      updated_at = now()
    where id = v_id;
    if not found then raise exception '掲示が見つかりません'; end if;
  else
    insert into portal_bulletins (product_id, title, body, badge, image_url, sort_order, is_active)
    values (nullif(p->>'product_id','')::uuid, nullif(p->>'title',''), nullif(p->>'body',''),
            nullif(p->>'badge',''), nullif(p->>'image_url',''),
            coalesce((p->>'sort_order')::int, 100), coalesce((p->>'is_active')::boolean, true))
    returning id into v_id;
  end if;
  return v_id;
end;
$$;
grant execute on function admin_upsert_bulletin(text,jsonb) to anon;
