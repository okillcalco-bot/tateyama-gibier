-- 20260816_revoke_security_table_grants.sql
-- Codex 4巡目 P1-4 (7): セキュリティ関連テーブルへの anon/authenticated の直接権限を剥奪する。追加のみ。
--
-- これらの表は SECURITY DEFINER 関数（所有者権限で実行）からのみ読み書きされ、
-- クライアント(anon)が PostgREST 経由で直接触れる必要は無い。RLSでポリシー不在＝行は返らないが、
-- テーブル権限(GRANT)自体を剥奪して「直接SELECT/INSERT/UPDATE/DELETEを試みても拒否」を明確化する。
-- （クライアントのどのHTMLもこれらの表へ直接アクセスしていないことを確認済み）

do $$
declare t text;
begin
  foreach t in array array[
    'enrollment_tokens','submission_tokens','staff_device_tokens','auth_rate_buckets',
    'auth_attempts','security_events','request_log','individual_audit','app_secrets'
  ] loop
    if to_regclass('public.'||t) is not null then
      execute format('revoke all on table public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;
