-- 20260809_portal_security.sql の続き。
-- 画面側（order-portal.html / order-admin.html）が portal_login() 経由に切り替わり、
-- 本番で動くのを確かめてから流す。

-- 平文のパスワードを消す。列そのものは残す（古い画面が参照しても落ちないように）。
update customers set portal_password = null where portal_password is not null;

comment on column customers.portal_password is
  '使用しません。パスワードは customer_secrets に bcrypt で保管し、portal_login() 経由でのみ照合します。';
