-- 20260819_portal_stock_mark_override.sql
-- 注文ポータルの在庫マークを手動で固定できるようにする（◎/◯/△/×）。
-- 目的: 鹿肉など、実在庫連動ではなく現場判断でマークを出したい商品に対応。
-- 方針: portal_products に stock_mark 列を追加し、非NULL時は portal_catalog がそれを最優先。
--       これまでのロジック（reserve_only→× / always_available→◎ / 在庫kg判定）は stock_mark 未設定時のみ適用。

-- 1) 手動マーク列（追加のみ）
alter table portal_products add column if not exists stock_mark text;
comment on column portal_products.stock_mark is
  '手動の在庫マーク（◎/◯/△/×）。設定時は portal_catalog で最優先。NULLなら従来ロジック（reserve_only/always_available/在庫連動）。';

-- 2) portal_catalog を stock_mark 優先に更新
create or replace function public.portal_catalog(p_token text)
 returns table(product_id uuid, species text, display_name text, grade_label text, description text, sort_order integer, min_order_kg numeric, step_kg numeric, mark text, unit_price integer, price_source text, is_orderable boolean, is_favorite boolean)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_id uuid := portal_session_customer(p_token); v_rank text;
begin
  if v_id is null then return; end if;
  select c.price_rank into v_rank from customers c where c.id = v_id;
  return query
  select p.id, p.species, p.display_name, p.grade_label, p.description, p.sort_order,
         p.min_order_kg, p.step_kg,
         case when coalesce(p.stock_mark,'') <> '' then p.stock_mark
              when p.reserve_only then '×'
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

-- 3) 鹿部位の在庫マークを現場指定値に設定し、予約固定を解除して「在庫あり」側へ
update portal_products set stock_mark = '◯', reserve_only = false where species = 'シカ' and display_name = '鹿ロース';
update portal_products set stock_mark = '◎', reserve_only = false where species = 'シカ' and display_name = '鹿モモ';
update portal_products set stock_mark = '◯', reserve_only = false where species = 'シカ' and display_name = '鹿肩ロース';
update portal_products set stock_mark = '◎', reserve_only = false where species = 'シカ' and display_name = '鹿カタ（ウデ）';
update portal_products set stock_mark = '◯', reserve_only = false where species = 'シカ' and display_name = '鹿ネック';
update portal_products set stock_mark = '△', reserve_only = false where species = 'シカ' and display_name = '鹿バラ';
update portal_products set stock_mark = '△', reserve_only = false where species = 'シカ' and display_name = '鹿スネ';
update portal_products set stock_mark = '△', reserve_only = false where species = 'シカ' and display_name = '鹿ヒレ';
update portal_products set stock_mark = '◯', reserve_only = false where species = 'シカ' and display_name = '鹿ミンチ';
