-- スタッフキーで守る関数は STABLE にしない（2026-10-10）
--
-- 不具合: 「🍱 お弁当・イベントの感想QR」の一覧が
--   「cannot execute INSERT in a read-only transaction」で読めなかった。
--   staff_key_ok は照合のたびに記録を書き込む（auth_attempts）。STABLE の関数から呼ぶと
--   PostgREST が読み取り専用の取引で実行するため、書き込みで失敗する。
--   同じ形の admin_order_allocations / admin_portal_credential_status も直す。
-- 再発防止: tests/e2e/staff-key-functions-volatile.e2e.js が migrations/ を読んで、
--   staff_key_ok を呼ぶ関数の最後の定義が STABLE/IMMUTABLE なら落ちる。
do $$ declare r record; begin
  for r in select p.oid::regprocedure as f from pg_proc p join pg_namespace n on n.oid=p.pronamespace
           where n.nspname='public' and p.provolatile <> 'v' and p.prosrc ilike '%staff_key_ok%' loop
    execute format('alter function %s volatile', r.f);
  end loop;
end $$;
