-- rollback: 20260901_p0a_staff_hunters_views_rpcs.sql
-- 追加したVIEW・RPCを削除する（先に p0b のrollbackで本体RLSを開放しておくこと）。
begin;
drop function if exists public.public_hunter_provisional(text);
drop function if exists public.staff_set_break_default(uuid, integer);
drop function if exists public.admin_hunters_list();
drop function if exists public.admin_staff_list();
drop view if exists public.hunters_public;
drop view if exists public.staff_public;
commit;
