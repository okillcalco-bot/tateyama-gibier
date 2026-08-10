-- customers.price_rank の許可値を現行の運用に合わせる。
--
-- 既存の check 制約は standard / premium / wholesale（旧世代の値）だけを許しており、
-- 画面（order-admin.html / order-portal.html）が使っている local / startmember を
-- 設定できなかった（718件全員が standard のまま動かせない状態）。
-- 旧値も残して広げるだけなので、既存行はすべてそのまま有効。
--
-- ロールバック: migrations/rollback/20260809_price_rank_values_rollback.sql
alter table customers drop constraint if exists customers_price_rank_check;
alter table customers add constraint customers_price_rank_check
  check (price_rank = any (array['standard','local','startmember','premium','wholesale']));
