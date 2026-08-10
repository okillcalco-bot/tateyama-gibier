-- 20260811_invoice_staging.sql の取り消し
drop function if exists admin_invoice_list(text, text);
drop function if exists admin_invoice_run_matching(text, uuid);
drop function if exists admin_invoice_stage_import(text, jsonb);
drop function if exists invoice_name_similarity(text, text);
drop function if exists invoice_norm_name(text);
drop function if exists invoice_norm_phone(text);
drop table if exists customer_purchase_facts;
drop table if exists product_name_aliases;
drop table if exists invoice_lines;
drop table if exists invoice_documents;
drop table if exists invoice_imports;
