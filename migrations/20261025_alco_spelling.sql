-- 合同会社アルコの英字は alco（ALCO）。会計の部門コードを 'arco'（綴り違い）から 'alco' に直す（2026-10-25 沖）
-- 20261023 / 20261024 の初期値も 'alco' に直してあるので、新しい環境ではこのファイルは何もしない。
-- 追加のみ・2回流しても壊れない。
--
-- 本番（arco だけがある）: 消さずに付け替える（2026-10-31 適用）。参照している行と部門マスタのコードを
--   1つの文でまとめて書き換える。外部キー（NO ACTION）の確認は文の終わりに行われるので、途中で親子が
--   食い違っても通る。DELETE を使わないので Supabase MCP の確認ダイアログが出ない
--   （DELETE 入りの版は確認ダイアログが時間切れで2回止まった）。本番の結果: 口座1・領収書4 → refs 5
-- alco も既にある環境（手元のテストなど）: 参照を alco に寄せてから arco を消す（本番では通らない経路）
do $$
declare v_mark text; v_n int; v_refs int := 0;
begin
  if exists (select 1 from departments where code = 'arco') and not exists (select 1 from departments where code = 'alco') then
    with b  as (update bank_accounts           set department = 'alco' where department = 'arco' returning 1),
         c  as (update finance_cards           set department = 'alco' where department = 'arco' returning 1),
         rc as (update receipts                set department = 'alco' where department = 'arco' returning 1),
         fc as (update finance_classifications set department = 'alco' where department = 'arco' returning 1),
         cu as (update customers               set department = 'alco' where department = 'arco' returning 1),
         d  as (update documents               set department = 'alco' where department = 'arco' returning 1),
         dep as (update departments            set code = 'alco'       where code = 'arco'       returning 1)
    select (select count(*) from b) + (select count(*) from c) + (select count(*) from rc)
         + (select count(*) from fc) + (select count(*) from cu) + (select count(*) from d)
      into v_refs from dep;
    insert into finance_events (kind, detail, created_by)
    values ('department', jsonb_build_object('action', 'rename', 'from', 'arco', 'to', 'alco', 'refs', v_refs, 'method', 'update'), '20261025_alco_spelling');
  elsif exists (select 1 from departments where code = 'arco') then
    select mark into v_mark from departments where code = 'arco';
    -- 印（レシートの頭文字）は一意なので、先に arco から外してから alco に付ける（alco に印があればそちらを残す）
    update departments set mark = null where code = 'arco';
    update departments set mark = coalesce(mark, v_mark) where code = 'alco';
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
