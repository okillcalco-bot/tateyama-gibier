-- ロールバック: migrations/20260813_phase4_usual_prices.sql
-- 3/3 で追加した6つのRPCを削除する（テーブル customer_usual_items 等は既存のため触らない）。
-- customer_usual_items のデータは再集計で作られたもの。削除したい場合は別途 SQL Editor から
-- `delete from customer_usual_items;` を実行する（本ロールバックでは消さない）。

drop function if exists admin_set_portal_enabled(text, uuid, boolean, text);
drop function if exists admin_list_portal_enabled(text, text);
drop function if exists admin_customer_price_comparison(text, uuid);
drop function if exists admin_customer_usual_items(text, uuid);
drop function if exists admin_recompute_usual_items(text, uuid, text);

notify pgrst, 'reload schema';
