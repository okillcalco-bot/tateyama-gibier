-- 段階B（キー必須）の切戻し: 既存画面が止まって業務が回らないときだけ使う。
-- 2026-08-12 の状態（anon に SELECT/INSERT/UPDATE 全行許可）へ戻す。同時にシーモルト連携の新しい書込みを止める
-- （認可移行が済んでいない状態で、新しい注文個人情報の取込を続けないため）。登録済みの注文・外部参照・監査は消さない。
begin;
drop policy if exists orders_staff_all on public.orders;
create policy orders_anon_select on public.orders for select to anon, authenticated using (true);
create policy orders_anon_insert on public.orders for insert to anon, authenticated with check (true);
create policy orders_anon_update on public.orders for update to anon, authenticated using (true) with check (true);
drop policy if exists order_items_staff_all on public.order_items;
create policy order_items_anon_select on public.order_items for select to anon, authenticated using (true);
create policy order_items_anon_insert on public.order_items for insert to anon, authenticated with check (true);
create policy order_items_anon_update on public.order_items for update to anon, authenticated using (true) with check (true);
update order_link.settings set value = 'true'::jsonb, updated_at = now() where key = 'writes_paused';
commit;
