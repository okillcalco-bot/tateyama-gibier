-- 20260812_orders_rls_relax.sql の取り消し
-- （20260809_rls_tighten.sql と同じ「スタッフキーのヘッダ必須」ポリシーへ戻す）
drop function if exists staff_lookup_customer_id(text);

drop policy if exists orders_anon_select on orders;
drop policy if exists orders_anon_insert on orders;
drop policy if exists orders_anon_update on orders;
create policy orders_staff_all on orders
  for all to anon using ((select staff_key_header_ok()))
  with check ((select staff_key_header_ok()));

drop policy if exists order_items_anon_select on order_items;
drop policy if exists order_items_anon_insert on order_items;
drop policy if exists order_items_anon_update on order_items;
create policy order_items_staff_all on order_items
  for all to anon using ((select staff_key_header_ok()))
  with check ((select staff_key_header_ok()));
