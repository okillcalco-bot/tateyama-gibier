-- 20260810_staffkey_governance.sql の取り消し。
-- staff_key_ok / portal_place_order / public_signup_request は
-- 20260810_phase3_hardening.sql（と 20260809_portal_sessions_rpc.sql）の定義を再適用して戻す。
drop function if exists admin_security_events(text, int);
drop function if exists admin_rotate_staff_key(text, text);
drop table if exists auth_attempts;
drop table if exists security_events;
alter role anon reset statement_timeout;
delete from app_secrets where key = 'recovery_code';
-- 旧 staff_key_set(text,text) を復元する場合は 20260809_portal_sessions_rpc.sql の定義を使う
