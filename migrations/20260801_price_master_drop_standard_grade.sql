-- 20260801_price_master_drop_standard_grade.sql
-- 価格マスタから旧 grade='standard'（並/上/極上 移行前の重複行・barcodeなし）を削除。
-- ランクは 並→上→極上 の3つに統一。注文カタログは grade='上'/barcode を参照するため影響なし。
-- price_rank（顧客の standard/local/startmember）とは無関係（あちらはカラム名）。

delete from price_master where grade='standard';
