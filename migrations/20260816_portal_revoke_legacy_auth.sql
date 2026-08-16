-- 20260816_portal_revoke_legacy_auth.sql
-- P0-2: 旧認証RPCの匿名/認証EXECUTEをREVOKE（迂回経路の遮断）。
--   ・portal_login(p_login,p_password): 旧order-portal.html用。新order.htmlは portal_login_v2 のみ使用。
--   ・portal_change_password(p_login,p_old,p_new): 旧pwの匿名総当り経路（P0-1の根本原因）。
--     初回変更は portal_complete_temp_password（変更専用トークン方式）へ一本化。
--   旧order-portal.html は廃止済みのため復活させない。定義は残すが anon/authenticated からは呼べなくする。
-- 前提: 20260816_portal_temp_password_lifecycle.sql 適用済み（portal_login_v2 / portal_complete_temp_password 定義済み）。

begin;

-- 重要: これらの旧関数は作成時に PUBLIC へ EXECUTE が付与されている（proaclの "=X/..." 項）。
-- anon/authenticated は PUBLIC 経由でも実行できてしまうため、PUBLIC からも必ず剥奪する。
-- postgres / service_role は明示付与を保持するため影響なし。

-- 旧ログイン: PUBLIC・匿名・認証から実行不可に。
revoke execute on function public.portal_login(text, text) from public, anon, authenticated;

-- 旧変更（匿名総当り経路）: PUBLIC・匿名・認証から実行不可に。
revoke execute on function public.portal_change_password(text, text, text) from public, anon, authenticated;

-- 念のため新RPCの許可を明示（lifecycle側でも付与済みだが冪等に再確認）。
grant execute on function public.portal_login_v2(text, text, text) to anon, authenticated;
grant execute on function public.portal_complete_temp_password(text, text) to anon, authenticated;

commit;
