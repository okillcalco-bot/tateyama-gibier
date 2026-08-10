-- 20260809_price_rank_values.sql の取り消し。
-- 注意: local / startmember を設定した行がある状態で戻すと制約違反になるため、
-- 先にその行を standard へ戻してから実行すること。
alter table customers drop constraint if exists customers_price_rank_check;
alter table customers add constraint customers_price_rank_check
  check (price_rank = any (array['standard','premium','wholesale']));
