-- 20260811_invoice_staging.sql の取り消し
-- 依存順: RPC（helperと表に依存）→ helper関数 → 子テーブル → 親テーブル
drop function if exists admin_invoice_list(text, text);
drop function if exists admin_invoice_run_matching(text, uuid);
drop function if exists admin_invoice_stage_import(text, jsonb);
drop function if exists invoice_name_similarity(text, text);   -- invoice_norm_name に依存
drop function if exists invoice_norm_code(text);
drop function if exists invoice_norm_name(text);
drop function if exists invoice_norm_phone(text);
drop table if exists customer_purchase_facts;
drop table if exists product_name_aliases;
drop table if exists invoice_lines;      -- invoice_documents を参照
drop table if exists invoice_documents;  -- invoice_imports を参照
drop table if exists invoice_imports;
