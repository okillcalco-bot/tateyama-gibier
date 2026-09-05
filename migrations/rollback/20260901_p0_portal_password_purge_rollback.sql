-- rollback: 20260901_p0_portal_password_purge.sql
--
-- 平文パスワードの値は復元しない（設計上不要・平文を再度持たないため）。
-- 列コメントのみ元の状態（20260809_portal_security_step2.sql 時点）へ戻す。
begin;
comment on column customers.portal_password is
  '使用しません。パスワードは customer_secrets に bcrypt で保管し、portal_login() 経由でのみ照合します。';
commit;
