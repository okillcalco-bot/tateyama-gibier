-- ============================================================
-- P0-3: 使われていない anon 書き込み権限の剥奪
--
-- 監査(§C/§D)＋本実装での呼び出し元全追跡（frontend全HTML）の結果、
-- 以下の3テーブルは frontend から一切 INSERT/UPDATE/DELETE していない
-- （書き込みは cron / 管理 / 内部のみ）。anon の書き込みだけを止める。
-- SELECT は内部処理・表示のため残す（挙動を変えない）。
--
--   customer_prices      : frontendからの直接writeは0件（顧客別価格は
--                          admin_set_customer_price RPC 経由・staff_key必須）
--   public_holidays      : 祝日マスタ。書き込みは migration/cron のみ
--   staff_fixed_schedule : 所定勤務。書き込みは migration/cron のみ
--
-- ★ production へは Claude Code から適用しない（runbook参照）。
--
-- 適用前確認（現在の anon 書き込み権限）:
--   select table_name, privilege_type from information_schema.role_table_grants
--   where grantee='anon' and table_name in
--     ('customer_prices','public_holidays','staff_fixed_schedule')
--     and privilege_type in ('INSERT','UPDATE','DELETE') order by 1,2;
--
-- 適用後確認: 上記が0行になること。
-- rollback: rollback/20260901_p0_write_least_privilege_rollback.sql
-- ============================================================

begin;

revoke insert, update, delete on customer_prices      from anon;
revoke insert, update, delete on public_holidays       from anon;
revoke insert, update, delete on staff_fixed_schedule  from anon;

commit;
