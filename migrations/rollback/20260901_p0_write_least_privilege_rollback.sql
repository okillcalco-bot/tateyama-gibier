-- rollback: 20260901_p0_write_least_privilege.sql
-- anon の書き込み権限を元に戻す（RLSの allow_all は変更していないので grant のみ）。
begin;
grant insert, update, delete on customer_prices      to anon;
grant insert, update, delete on public_holidays       to anon;
grant insert, update, delete on staff_fixed_schedule  to anon;
commit;
