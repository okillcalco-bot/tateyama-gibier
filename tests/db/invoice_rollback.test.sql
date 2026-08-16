-- ロールバックSQL（migrations/rollback/20260811_invoice_staging_rollback.sql）の完全性テスト
--
-- トランザクション内でロールバックSQLをそのまま実行し、今回追加した全オブジェクト
-- （5テーブル・admin_invoice_* 3関数・helper 4関数）が残っていないことを確認してから
-- rollback で元に戻す。本番のテーブル・関数・データには影響しない。
--
-- 合否判定: 残存オブジェクトが1件でもあれば raise exception でSQL全体が失敗する。
-- 全て消えていれば NOTICE『ROLLBACK TEST PASSED』が出て rollback で終わる。
begin;

-- ── ロールバックSQLの内容（rollbackファイルと同一・依存順） ──
drop function if exists admin_invoice_list(text, text);
drop function if exists admin_invoice_run_matching(text, uuid);
drop function if exists admin_invoice_stage_import(text, jsonb);
drop function if exists invoice_name_similarity(text, text);
drop function if exists invoice_norm_code(text);
drop function if exists invoice_norm_name(text);
drop function if exists invoice_norm_phone(text);
drop table if exists customer_purchase_facts;
drop table if exists product_name_aliases;
drop table if exists invoice_lines;
drop table if exists invoice_documents;
drop table if exists invoice_imports;

-- ── 残存チェック ──
do $$
declare v_left text;
begin
  select string_agg(obj, ', ') into v_left from (
    select 'table:' || tablename as obj from pg_tables
     where schemaname = 'public'
       and tablename in ('invoice_imports','invoice_documents','invoice_lines',
                         'customer_purchase_facts','product_name_aliases')
    union all
    select 'function:' || p.proname from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.proname in ('admin_invoice_stage_import','admin_invoice_run_matching',
                         'admin_invoice_list','invoice_norm_phone','invoice_norm_name',
                         'invoice_norm_code','invoice_name_similarity')
  ) s;
  if v_left is not null then
    raise exception 'ROLLBACK TEST FAILED — 残存オブジェクト: %', v_left;
  end if;
  raise notice 'ROLLBACK TEST PASSED — 対象12オブジェクトすべて削除された';
end $$;

rollback;
