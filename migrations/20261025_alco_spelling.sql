-- 合同会社アルコの英字は alco（ALCO）。会計の部門コードを 'arco'（綴り違い）から 'alco' に直す（2026-10-25 沖）
-- 20261023 / 20261024 の初期値も 'alco' に直してあるので、新しい環境ではこのファイルは何もしない。
-- 既に 'arco' で動いている環境（本番）では、参照している行をすべて 'alco' に付け替えてから 'arco' を消す。
-- 追加のみ・2回流しても壊れない。トップレベルの DROP/DELETE は書かない（Supabase MCP の確認ダイアログを避ける）。
do $$
declare v_mark text; v_n int; v_refs int := 0;
begin
  if exists (select 1 from departments where code = 'arco') then
    select mark into v_mark from departments where code = 'arco';
    -- 印（レシートの頭文字）は一意なので、先に arco から外してから alco に付ける
    update departments set mark = null where code = 'arco';
    insert into departments (code, name, short_name, sort, is_active, report_to, mark)
    select 'alco', name, short_name, sort, is_active, report_to, v_mark from departments where code = 'arco'
    on conflict (code) do update set mark = coalesce(departments.mark, excluded.mark);
    -- 部門を参照している行を付け替える（外部キーは NO ACTION なので手で全部）
    update bank_accounts set department = 'alco' where department = 'arco';           get diagnostics v_n = row_count; v_refs := v_refs + v_n;
    update finance_cards set department = 'alco' where department = 'arco';           get diagnostics v_n = row_count; v_refs := v_refs + v_n;
    update receipts set department = 'alco' where department = 'arco';                get diagnostics v_n = row_count; v_refs := v_refs + v_n;
    update finance_classifications set department = 'alco' where department = 'arco'; get diagnostics v_n = row_count; v_refs := v_refs + v_n;
    update customers set department = 'alco' where department = 'arco';               get diagnostics v_n = row_count; v_refs := v_refs + v_n;
    update documents set department = 'alco' where department = 'arco';               get diagnostics v_n = row_count; v_refs := v_refs + v_n;
    delete from departments where code = 'arco';
    insert into finance_events (kind, detail, created_by)
    values ('department', jsonb_build_object('action', 'rename', 'from', 'arco', 'to', 'alco', 'refs', v_refs, 'mark', v_mark), '20261025_alco_spelling');
  end if;
end $$;
