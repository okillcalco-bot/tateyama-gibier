-- 20260809_portal_products.sql の取り消し。
-- 既存テーブル（customers 以外）には触れていないため、作ったものを消すだけで元に戻る。
drop function if exists admin_set_customer_price(text, uuid, uuid, int, date, date, text, text);
drop function if exists admin_upsert_product(text, jsonb);
drop function if exists portal_stock_marks();
drop function if exists resolve_unit_price(uuid, uuid, date);
drop table if exists customer_product_prices;
drop table if exists portal_product_prices;
drop table if exists portal_product_parts;
drop table if exists portal_products cascade;
alter table customers drop column if exists portal_enabled;
