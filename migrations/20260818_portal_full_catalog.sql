-- 全商品を顧客サイトに表示するための一括変更（価格マスタ＋ポータル＋相談メモ）
--
-- 方針:
--   * 追加のみ（新カラム always_available / 新テーブル portal_inquiries、既存の破壊なし）
--   * 顧客サイトの表示は portal_products が正。price_master は内部価格表として別途整える
--   * 枝肉は個体在庫と部位が紐づかないため always_available=true で常に「注文可」
--
-- ロールバック: migrations/rollback/20260818_portal_full_catalog_rollback.sql

-- ══════════ 1. always_available 列（常に在庫あり扱い＝ご希望受付の枝肉用）══════════
alter table portal_products add column if not exists always_available boolean not null default false;

-- portal_catalog: always_available は在庫に関係なく ◎（在庫ありタブに出て注文可）
create or replace function public.portal_catalog(p_token text)
 returns table(product_id uuid, species text, display_name text, grade_label text, description text,
   sort_order integer, min_order_kg numeric, step_kg numeric, mark text, unit_price integer,
   price_source text, is_orderable boolean, is_favorite boolean)
 language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_id uuid := portal_session_customer(p_token); v_rank text;
begin
  if v_id is null then return; end if;
  select c.price_rank into v_rank from customers c where c.id = v_id;
  return query
  select p.id, p.species, p.display_name, p.grade_label, p.description, p.sort_order,
         p.min_order_kg, p.step_kg,
         case when p.always_available then '◎'
              when coalesce(s.kg,0) >= p.low_kg then '◎'
              when coalesce(s.kg,0) >= p.min_order_kg then '△' else '×' end,
         pr.unit_price, pr.price_source,
         (p.is_orderable and pr.unit_price is not null),
         exists (select 1 from customer_saved_items f
                  where f.customer_id = v_id and f.kind = 'favorite' and f.product_id = p.id)
    from portal_products p
    left join lateral (
      select sum(coalesce(i.weight_kg, i.weight)) as kg
        from portal_product_parts pp
        join inventory i on i.deleted_at is null and i.status = '在庫'
         and i.species = p.species and i.part_name = pp.part_name
         and (pp.grade is null or i.grade = pp.grade)
       where pp.product_id = p.id) s on true
    left join lateral (select * from resolve_unit_price(v_id, p.id)) pr on true
   where p.is_active and p.portal_visible
     and (p.visible_ranks is null or coalesce(v_rank,'standard') = any(p.visible_ranks))
   order by p.sort_order, p.display_name;
end;
$function$;
grant execute on function portal_catalog(text) to anon;

-- ══════════ 2. price_master（内部価格表）の整え ══════════
-- ①イノシシ内臓（赤つなぎ〜チレ＝barcode 112〜118）を 上→並、価格を赤つなぎと同額に
update price_master
   set grade='並', price_standard=1000, price_local=500, price_startmember=300,
       price_premium=1000, price_wholesale=1000
 where species='イノシシ' and barcode_num in ('112','113','114','115','116','117','118');

-- ②シカ・中型獣は「ランク無し」（grade を空に）
update price_master set grade=null where species in ('シカ','中型獣');

-- ③④枝肉を price_master にも追加（イノシシ=並、シカ・中型獣=ランク無し）
insert into price_master (species, part_name, grade, price_standard, price_local, price_startmember, price_premium, price_wholesale)
values
 ('イノシシ','枝肉（全体）','並',   2000,1500,1300,0,0),
 ('シカ',    '枝肉（全体）',null,   2000,1500,1300,0,0),
 ('中型獣',  '枝肉（全体）',null,   3000,2500,2500,0,0);

-- ══════════ 3. ポータル商品（顧客サイト表示）追加 ══════════

-- 既存の価格未設定シカ2件を作り直し（生成物に統合）
delete from portal_product_prices where product_id='c767055a-0cdd-4371-829c-5e7134bc7328';
delete from portal_product_parts  where product_id='c767055a-0cdd-4371-829c-5e7134bc7328';
delete from portal_products        where id='c767055a-0cdd-4371-829c-5e7134bc7328';
delete from portal_product_prices where product_id='48162070-b9c1-495d-acc3-7e867b72ee49';
delete from portal_product_parts  where product_id='48162070-b9c1-495d-acc3-7e867b72ee49';
delete from portal_products        where id='48162070-b9c1-495d-acc3-7e867b72ee49';


with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available) values ('イノシシ','猪タン（舌）','並','内臓・希少部位。ご相談ください',200,0.5,0.5,3.0,true,true,true,false) returning id), pp as (insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',1000 from ins union all select id,'local',500 from ins union all select id,'startmember',300 from ins returning 1) insert into portal_product_parts (product_id,part_name,grade) select id,'タン（舌）','並' from ins;

with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available) values ('イノシシ','猪ハツ（心臓）','並','内臓・希少部位。ご相談ください',210,0.5,0.5,3.0,true,true,true,false) returning id), pp as (insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',1000 from ins union all select id,'local',500 from ins union all select id,'startmember',300 from ins returning 1) insert into portal_product_parts (product_id,part_name,grade) select id,'ハツ（心臓）','並' from ins;

with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available) values ('イノシシ','猪レバ（肝臓）','並','内臓・希少部位。ご相談ください',220,0.5,0.5,3.0,true,true,true,false) returning id), pp as (insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',1000 from ins union all select id,'local',500 from ins union all select id,'startmember',300 from ins returning 1) insert into portal_product_parts (product_id,part_name,grade) select id,'レバ（肝臓）','並' from ins;

with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available) values ('イノシシ','猪フワ（肺）','並','内臓・希少部位。ご相談ください',230,0.5,0.5,3.0,true,true,true,false) returning id), pp as (insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',1000 from ins union all select id,'local',500 from ins union all select id,'startmember',300 from ins returning 1) insert into portal_product_parts (product_id,part_name,grade) select id,'フワ（肺）','並' from ins;

with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available) values ('イノシシ','猪マメ（腎臓）','並','内臓・希少部位。ご相談ください',240,0.5,0.5,3.0,true,true,true,false) returning id), pp as (insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',1000 from ins union all select id,'local',500 from ins union all select id,'startmember',300 from ins returning 1) insert into portal_product_parts (product_id,part_name,grade) select id,'マメ（腎臓）','並' from ins;

with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available) values ('イノシシ','猪チレ（脾臓）','並','内臓・希少部位。ご相談ください',250,0.5,0.5,3.0,true,true,true,false) returning id), pp as (insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',1000 from ins union all select id,'local',500 from ins union all select id,'startmember',300 from ins returning 1) insert into portal_product_parts (product_id,part_name,grade) select id,'チレ（脾臓）','並' from ins;

with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available) values ('イノシシ','猪赤つなぎセット','並','内臓・希少部位。ご相談ください',260,0.5,0.5,3.0,true,true,true,false) returning id), pp as (insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',1000 from ins union all select id,'local',500 from ins union all select id,'startmember',300 from ins returning 1) insert into portal_product_parts (product_id,part_name,grade) select id,'赤つなぎセット','並' from ins;

with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available) values ('イノシシ','猪枝肉（一頭分・ご希望）',null,'枝肉（骨付き一頭分）。ご希望として承ります',300,1.0,0.5,3.0,true,true,true,true) returning id), pp as (insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',2000 from ins union all select id,'local',1500 from ins union all select id,'startmember',1300 from ins returning 1) insert into portal_product_parts (product_id,part_name,grade) select id,'枝肉（全体）','並' from ins;

with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available) values ('シカ','鹿枝肉（一頭分・ご希望）',null,'枝肉（骨付き一頭分）。ご希望として承ります',405,1.0,0.5,3.0,true,true,true,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',2000 from ins union all select id,'local',1500 from ins union all select id,'startmember',1300 from ins;

with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available) values ('中型獣','中型獣 枝肉（一頭分・ご希望）',null,'アナグマ・タヌキ等。枝肉（一頭分）でご希望を承ります',600,1.0,0.5,3.0,true,true,true,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',3000 from ins union all select id,'local',2500 from ins union all select id,'startmember',2500 from ins;

with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available) values ('シカ','鹿ロース',null,'',410,0.5,0.5,3.0,true,true,true,false) returning id), pp as (insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',3800 from ins union all select id,'local',3800 from ins union all select id,'startmember',3800 from ins returning 1) insert into portal_product_parts (product_id,part_name,grade) select id,'ロース','並' from ins;

with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available) values ('シカ','鹿モモ',null,'',420,0.5,0.5,3.0,true,true,true,false) returning id), pp as (insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',2600 from ins union all select id,'local',2600 from ins union all select id,'startmember',2600 from ins returning 1) insert into portal_product_parts (product_id,part_name,grade) select id,'モモ（ウチ）','並' from ins union all select id,'モモ（ソト）','並' from ins union all select id,'モモ（シンタマ）','並' from ins;

with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available) values ('シカ','鹿肩ロース',null,'',430,0.5,0.5,3.0,true,true,true,false) returning id), pp as (insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',2600 from ins union all select id,'local',2600 from ins union all select id,'startmember',2600 from ins returning 1) insert into portal_product_parts (product_id,part_name,grade) select id,'肩ロース','並' from ins;

with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available) values ('シカ','鹿カタ（ウデ）',null,'',440,0.5,0.5,3.0,true,true,true,false) returning id), pp as (insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',2200 from ins union all select id,'local',2200 from ins union all select id,'startmember',2200 from ins returning 1) insert into portal_product_parts (product_id,part_name,grade) select id,'カタ','並' from ins;

with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available) values ('シカ','鹿ネック',null,'',450,0.5,0.5,3.0,true,true,true,false) returning id), pp as (insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',2500 from ins union all select id,'local',2500 from ins union all select id,'startmember',2500 from ins returning 1) insert into portal_product_parts (product_id,part_name,grade) select id,'ネック','並' from ins;

with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available) values ('シカ','鹿バラ',null,'',460,0.5,0.5,3.0,true,true,true,false) returning id), pp as (insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',1800 from ins union all select id,'local',1800 from ins union all select id,'startmember',1800 from ins returning 1) insert into portal_product_parts (product_id,part_name,grade) select id,'バラ','並' from ins;

with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available) values ('シカ','鹿スネ',null,'',470,0.5,0.5,3.0,true,true,true,false) returning id), pp as (insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',2000 from ins union all select id,'local',2000 from ins union all select id,'startmember',2000 from ins returning 1) insert into portal_product_parts (product_id,part_name,grade) select id,'スネ','並' from ins;

with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available) values ('シカ','鹿ヒレ',null,'',480,0.5,0.5,3.0,true,true,true,false) returning id), pp as (insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',3800 from ins union all select id,'local',3800 from ins union all select id,'startmember',3800 from ins returning 1) insert into portal_product_parts (product_id,part_name,grade) select id,'ヒレ','並' from ins;

with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available) values ('シカ','鹿ミンチ',null,'',490,0.5,0.5,3.0,true,true,true,false) returning id), pp as (insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',1600 from ins union all select id,'local',1600 from ins union all select id,'startmember',1600 from ins returning 1) insert into portal_product_parts (product_id,part_name,grade) select id,'ミンチ用','並' from ins;

-- ══════════ 4. ご相談・お問い合わせ（商品注文と別に送れる自由メモ）══════════
create table if not exists portal_inquiries (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references customers(id) on delete cascade,
  body text not null,
  status text not null default '未対応',      -- 未対応 / 対応済
  client_request_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists portal_inquiries_reqid_uq
  on portal_inquiries (customer_id, client_request_id) where client_request_id is not null;
alter table portal_inquiries enable row level security;   -- ポリシー無し＝RPC経由のみ

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
  on conflict (customer_id, client_request_id) do update set body=excluded.body, updated_at=now()
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end;
$$;

create or replace function admin_list_inquiries(p_staff_key text, p_status text default null)
returns table(id uuid, customer_id uuid, customer_name text, customer_code text,
              body text, status text, created_at timestamptz)
language plpgsql security definer set search_path to 'public' as $$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  return query
    select q.id, q.customer_id, c.name, c.code, q.body, q.status, q.created_at
      from portal_inquiries q left join customers c on c.id=q.customer_id
     where (p_status is null or q.status=p_status)
     order by (q.status='未対応') desc, q.created_at desc;
end;
$$;

create or replace function admin_set_inquiry_status(p_staff_key text, p_id uuid, p_status text)
returns boolean language plpgsql security definer set search_path to 'public' as $$
declare v int;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if p_status not in ('未対応','対応済') then raise exception '不正なステータスです'; end if;
  update portal_inquiries set status=p_status, updated_at=now() where id=p_id;
  get diagnostics v = row_count; return v>0;
end;
$$;

grant execute on function portal_submit_inquiry(text,text,text) to anon;
grant execute on function admin_list_inquiries(text,text) to anon;
grant execute on function admin_set_inquiry_status(text,uuid,text) to anon;
