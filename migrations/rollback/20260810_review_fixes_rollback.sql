-- 20260810_review_fixes.sql の取り消し。
-- 関数は 20260810_staffkey_governance.sql / 20260810_phase3_hardening.sql の定義を再適用して戻す。
drop function if exists admin_list_portal_products(text);
drop function if exists admin_resolve_price(text, uuid, uuid);
drop function if exists portal_session_touch(text);
grant execute on function resolve_unit_price(uuid, uuid, date) to anon, authenticated;
create policy portal_products_read on portal_products for select to anon using (true);
create policy portal_product_parts_read on portal_product_parts for select to anon using (true);
create policy portal_product_prices_read on portal_product_prices for select to anon using (true);
drop index if exists orders_client_request_uq;
create unique index if not exists orders_client_request_id_uq
  on orders (client_request_id) where client_request_id is not null;
drop index if exists customers_portal_login_id_lower_uq;
-- portal_session_customer / portal_login_v2 / portal_place_order / portal_toggle_favorite /
-- staff_key_ok / admin_rotate_staff_key / admin_upsert_product / public_signup_request /
-- portal_login / portal_change_password（旧ポータルの名前ログイン込みの定義）は
-- 旧マイグレーションの定義を再適用して復元する
