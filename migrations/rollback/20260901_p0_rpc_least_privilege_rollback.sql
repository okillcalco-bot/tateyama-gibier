-- rollback: 20260901_p0_rpc_least_privilege.sql
-- ラッパーを外して *_impl を元の名前へ戻し、anon EXECUTE を復旧する。
begin;

-- ガードした5関数: ラッパー drop → impl を元名へ rename → anon grant 復旧
drop function if exists public.sale_event_settle(uuid, text);
alter function public.sale_event_settle_impl(uuid, text) rename to sale_event_settle;
grant execute on function public.sale_event_settle(uuid, text) to anon, authenticated;

drop function if exists public.sale_event_reopen(uuid, text);
alter function public.sale_event_reopen_impl(uuid, text) rename to sale_event_reopen;
grant execute on function public.sale_event_reopen(uuid, text) to anon, authenticated;

drop function if exists public.sale_event_takeout(uuid, text);
alter function public.sale_event_takeout_impl(uuid, text) rename to sale_event_takeout;
grant execute on function public.sale_event_takeout(uuid, text) to anon, authenticated;

drop function if exists public.staff_voice_moderate(uuid, text, text);
alter function public.staff_voice_moderate_impl(uuid, text, text) rename to staff_voice_moderate;
grant execute on function public.staff_voice_moderate(uuid, text, text) to anon, authenticated;

drop function if exists public.staff_voices_list(text, integer);
alter function public.staff_voices_list_impl(text, integer) rename to staff_voices_list;
grant execute on function public.staff_voices_list(text, integer) to anon, authenticated;

-- 剥奪した anon EXECUTE を復旧
grant execute on function public.apply_fixed_schedule(date, date)      to anon;
grant execute on function public.apply_fixed_schedule_prev_month()      to anon;
grant execute on function public.tgc_assign_scan_code()                 to anon;
grant execute on function public.tgc_assign_individual_number()         to anon;
grant execute on function public.waste_summary(date, date)             to anon;
grant execute on function public._rl_hit(text, integer, integer)        to anon;
grant execute on function public.can_approve()                          to anon;
grant execute on function public.has_role(text)                         to anon;
grant execute on function public.current_organization_id()              to anon;
grant execute on function public.provision_profile(text)                to anon;
grant execute on function public.mail_import_outlet_day(text, date, timestamp with time zone, jsonb) to anon;
grant execute on function public.security_retention_purge()             to anon;
grant execute on function public.get_capture_form_by_token(text)        to anon;

commit;
