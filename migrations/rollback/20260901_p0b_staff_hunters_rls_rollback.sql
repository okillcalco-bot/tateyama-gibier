-- rollback: 20260901_p0b_staff_hunters_rls.sql
-- staff/hunters を元の allow-all（anon全開放）に戻す。
begin;
drop policy if exists staff_select on public.staff;
drop policy if exists staff_write  on public.staff;
create policy "Allow all access to staff" on public.staff for all using (true) with check (true);

drop policy if exists hunters_select on public.hunters;
drop policy if exists hunters_insert on public.hunters;
drop policy if exists hunters_update on public.hunters;
create policy hunters_select on public.hunters for select using (true);
create policy hunters_insert on public.hunters for insert with check (true);
create policy hunters_update on public.hunters for update using (true) with check (true);
commit;
