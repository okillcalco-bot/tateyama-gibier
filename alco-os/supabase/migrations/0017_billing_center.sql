-- ============================================================
-- ALCO OS  0017: 帳票センター（Misoca型）
--
-- billing_documents を拡張（追加のみ）:
--   - 見積書（doc_type='quote'、番号 QT-YYYYMM-###）を追加
--   - 注文に紐づかない自由入力の帳票（order_id は元々 nullable）
--   - 書類変換の系譜: source_document_id（見積→納品→請求→領収 の変換元）
--   - source: 'alco'（本システム発行）/ 'misoca'（MisocaCSVインポート）
-- ============================================================

alter table billing_documents
  add column if not exists source_document_id uuid,
  add column if not exists source text not null default 'alco';

create index if not exists idx_billing_documents_source_doc
  on billing_documents (source_document_id);
