-- シカ・中型獣を「常に予約（在庫なし）側に固定」。中型獣は5獣種に分割。
-- 追加のみ（reserve_only 列を追加）。本番適用済み。
-- ロールバック: migrations/rollback/20260818_portal_reserve_only_deer_medium_rollback.sql

alter table portal_products add column if not exists reserve_only boolean not null default false;

-- portal_catalog: reserve_only は在庫に関係なく常に×（予約タブに固定）。次に always_available（◎）、以降は在庫連動。
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
         case when p.reserve_only then '×'
              when p.always_available then '◎'
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

update portal_products set reserve_only=true, updated_at=now() where species in ('シカ','中型獣');

delete from portal_products where species='中型獣' and display_name='中型獣 枝肉（一頭分・ご希望）';

with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('中型獣','キョン（一頭分・ご希望）',null,'枝肉（一頭分）。ご希望として承ります',610,1.0,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',3000 from ins union all select id,'local',2500 from ins union all select id,'startmember',2500 from ins;
with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('中型獣','ハクビシン（一頭分・ご希望）',null,'枝肉（一頭分）。ご希望として承ります',620,1.0,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',3000 from ins union all select id,'local',2500 from ins union all select id,'startmember',2500 from ins;
with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('中型獣','アライグマ（一頭分・ご希望）',null,'枝肉（一頭分）。ご希望として承ります',630,1.0,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',3000 from ins union all select id,'local',2500 from ins union all select id,'startmember',2500 from ins;
with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('中型獣','タヌキ（一頭分・ご希望）',null,'枝肉（一頭分）。ご希望として承ります',640,1.0,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',3000 from ins union all select id,'local',2500 from ins union all select id,'startmember',2500 from ins;
with ins as (insert into portal_products (species,display_name,grade_label,description,sort_order,min_order_kg,step_kg,low_kg,portal_visible,is_orderable,is_active,always_available,reserve_only) values ('中型獣','ノウサギ（一頭分・ご希望）',null,'枝肉（一頭分）。ご希望として承ります',650,1.0,0.5,3.0,true,true,true,false,true) returning id) insert into portal_product_prices (product_id,price_rank,unit_price) select id,'standard',3000 from ins union all select id,'local',2500 from ins union all select id,'startmember',2500 from ins;
