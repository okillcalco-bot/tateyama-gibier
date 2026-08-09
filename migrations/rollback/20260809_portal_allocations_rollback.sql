-- 20260809_portal_allocations.sql の取り消し。
-- order_items に追加した列はすべて nullable で、既存の画面はこれらを読まないため drop で戻る。
drop function if exists release_allocations_for_order(uuid);
drop function if exists allocate_for_order_item(uuid, uuid, numeric);
drop table if exists inventory_allocations;
alter table order_items
  drop column if exists product_id_v2,
  drop column if exists product_name,
  drop column if exists grade_snapshot,
  drop column if exists price_rank_applied,
  drop column if exists price_source,
  drop column if exists requested_kg,
  drop column if exists allocated_kg;
