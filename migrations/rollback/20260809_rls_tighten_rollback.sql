-- 20260809_rls_tighten.sql の取り消し。
-- 適用前のポリシー（2026-08-09 時点の pg_policies から採取した定義）へ戻す。
-- 注意: これを流すと anon 全許可の状態（情報が誰でも読める状態）に戻る。緊急時のみ。

drop policy if exists customers_staff_select on customers;
drop policy if exists customers_staff_update on customers;
drop policy if exists customers_staff_delete on customers;
drop policy if exists customers_insert on customers;
create policy allow_all on customers as permissive for all to public using (true) with check (true);
create policy allow_all_customers on customers as permissive for all to anon using (true) with check (true);
create policy portal_customers_select on customers as permissive for select to anon using (true);

drop policy if exists orders_staff_all on orders;
create policy allow_all on orders as permissive for all to public using (true) with check (true);
create policy allow_all_orders on orders as permissive for all to anon using (true) with check (true);
create policy portal_orders_insert on orders as permissive for insert to anon with check (true);
create policy portal_orders_select on orders as permissive for select to anon using (true);

drop policy if exists order_items_staff_all on order_items;
create policy allow_all on order_items as permissive for all to public using (true) with check (true);
create policy allow_all_order_items on order_items as permissive for all to anon using (true) with check (true);
create policy portal_items_insert on order_items as permissive for insert to anon with check (true);
create policy portal_items_select on order_items as permissive for select to anon using (true);
