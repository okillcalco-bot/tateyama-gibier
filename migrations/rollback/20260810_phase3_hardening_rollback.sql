-- 20260810_phase3_hardening.sql の取り消し。
-- 注意: portal_login_v2 / portal_session_customer / portal_logout / place_order /
-- admin_set_order_status は 20260809_portal_sessions_rpc.sql の定義に戻す必要がある。
-- 個別に create or replace で旧定義を流すこと（旧定義はそのファイルにある）。
drop function if exists portal_usual_items(text);
drop table if exists customer_usual_items;
drop function if exists portal_place_order(text, jsonb, date, text, text, text);
drop function if exists public_signup_request(text,text,text,text,text,text,text,text,text,text,text,text);
alter table orders drop column if exists client_request_id;
-- 旧シグネチャの place_order 等は migrations/20260809_portal_sessions_rpc.sql を再適用して復元する
