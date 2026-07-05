-- ============================================================
-- ALCO OS  0011: ジビエ基幹 KPI ビュー（統合 Step 2 / docs/09）
-- 既存ジビエ基幹のテーブル（individuals / products / product_movements /
-- orders）への読み取り専用ビュー。既存テーブルは一切変更しない。
--
-- 注: 在庫は既存アプリの正である products.stock_qty のスナップショットを
-- 使う（ALCO OS 側でムーブメント積算に切り替えるのは統合 Step 3 以降）。
-- ============================================================

-- 月次捕獲（獣種別）
create or replace view v_gibier_intake_monthly as
select
  date_trunc('month', capture_date)::date as month,
  species,
  count(*) as head_count,
  sum(coalesce(weight_total, 0)) as total_weight_kg,
  avg(yield_rate) as avg_yield_rate
from individuals
where deleted_at is null and capture_date is not null
group by 1, 2;

-- 完成品在庫（現在庫スナップショット）
create or replace view v_gibier_inventory as
select
  id as product_id,
  name,
  category,
  unit,
  price,
  coalesce(stock_qty, 0) as stock_qty,
  coalesce(stock_qty, 0) * coalesce(price, 0) as stock_value
from products
where deleted_at is null;

-- 月次売上（受注ベース。status 別に返すので画面側で除外を制御できる）
create or replace view v_gibier_sales_monthly as
select
  date_trunc('month', order_date)::date as month,
  status,
  count(*) as order_count,
  sum(coalesce(total_amount, 0)) as total_sales
from orders
where order_date is not null
group by 1, 2;

-- 月次の完成品ムーブメント（完成 / 持ち出し / 店頭販売 / 廃棄 / 棚卸調整）
create or replace view v_gibier_movements_monthly as
select
  date_trunc('month', created_at)::date as month,
  movement_type,
  sum(coalesce(qty, 0)) as total_qty
from product_movements
group by 1, 2;

alter view v_gibier_intake_monthly set (security_invoker = true);
alter view v_gibier_inventory set (security_invoker = true);
alter view v_gibier_sales_monthly set (security_invoker = true);
alter view v_gibier_movements_monthly set (security_invoker = true);
