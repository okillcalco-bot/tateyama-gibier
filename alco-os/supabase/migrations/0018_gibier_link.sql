-- ============================================================
-- ALCO OS  0018: 帳票・伝票とジビエ在庫管理システムの紐づけ
--
-- - sales_slips.product_id: 売上伝票の品目を既存 products（完成品マスタ）に
--   紐づける（FKなし・汎用参照。既存テーブルはスキーマ変更しない）
-- - 帳票（billing_documents.items jsonb）には product_id / species / part_name を
--   スナップショットとして持たせる（スキーマ変更不要）
-- - 在庫数量の増減は既存システム（product_movements）が正。
--   ALCO OS は参照とトレース記録のみ行い、在庫を書き換えない（docs/09）
-- ============================================================

alter table sales_slips
  add column if not exists product_id uuid;

create index if not exists idx_sales_slips_product on sales_slips (product_id);
