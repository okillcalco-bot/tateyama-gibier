-- tests/db/p0_security.test.sql
-- P0-A セキュリティ是正の DBテスト（negative 中心・positive も含む）。
--
-- 【安全性】このテストは migration の DDL をトランザクション内で適用し、
-- 最後に raise exception でロールバックする（CLAUDE.md の破壊的検証の流儀）。
-- 本番に対して流しても副作用はゼロ（全て巻き戻る）。
--
-- 検証する権限境界:
--   anon（staff-keyヘッダ無し） / staff-key相当（definer RPC経由） / トリガ・cron
--
-- 実行例（本番に無害・ロールバックされる）:
--   supabase execute_sql < tests/db/p0_security.test.sql
--   → 最終行に "TESTRESULT: ALL PASS" が出れば成功。

begin;

-- ===== 適用: P0-2 staff/hunters =====
create or replace view public.staff_public as
  select id, name, color, is_active, default_break_min from public.staff where deleted_at is null;
create or replace view public.hunters_public as
  select id, name, furigana, city, trap_area, (memo in ('逝去','返納')) as is_retired
  from public.hunters where deleted_at is null;
grant select on public.staff_public to anon, authenticated;
grant select on public.hunters_public to anon, authenticated;
drop policy if exists "Allow all access to staff" on public.staff;
drop policy if exists staff_all on public.staff;
drop policy if exists staff_select on public.staff;
create policy staff_select on public.staff for select to anon using ((select staff_key_header_ok()));
create policy staff_write on public.staff for all to anon using ((select staff_key_header_ok())) with check ((select staff_key_header_ok()));
drop policy if exists hunters_select on public.hunters;
drop policy if exists hunters_insert on public.hunters;
drop policy if exists hunters_update on public.hunters;
create policy hunters_select on public.hunters for select to anon using ((select staff_key_header_ok()));
create policy hunters_insert on public.hunters for insert to anon with check ((select staff_key_header_ok()));
create policy hunters_update on public.hunters for update to anon using ((select staff_key_header_ok())) with check ((select staff_key_header_ok()));
create or replace function public.admin_staff_list()
returns setof public.staff language plpgsql stable security definer set search_path to 'public' as $fn$
begin
  if not staff_key_header_ok() then raise exception 'staffkey' using errcode='42501'; end if;
  return query select * from public.staff where deleted_at is null order by name;
end $fn$;
grant execute on function public.admin_staff_list() to anon, authenticated;
create or replace function public.staff_set_break_default(p_staff_id uuid, p_minutes integer)
returns void language plpgsql volatile security definer set search_path to 'public' as $fn$
begin
  if p_staff_id is null then raise exception 'id'; end if;
  if p_minutes is null or p_minutes<0 or p_minutes>600 then raise exception 'range'; end if;
  update public.staff set default_break_min=p_minutes where id=p_staff_id and deleted_at is null;
end $fn$;
grant execute on function public.staff_set_break_default(uuid,integer) to anon, authenticated;
create or replace function public.public_hunter_provisional(p_name text)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $fn$
declare v_name text:=btrim(coalesce(p_name,'')); v_exists boolean;
begin
  if v_name='' then raise exception 'empty'; end if;
  if char_length(v_name)>50 then raise exception 'too long'; end if;
  select exists(select 1 from public.hunters where name=v_name and deleted_at is null) into v_exists;
  if v_exists then return jsonb_build_object('ok',true,'created',false); end if;
  insert into public.hunters(name,memo) values(v_name,'仮登録');
  return jsonb_build_object('ok',true,'created',true);
end $fn$;
grant execute on function public.public_hunter_provisional(text) to anon, authenticated;

-- ===== 適用: P0-1 RPC（代表として sale_event_settle をガード + トリガrevoke） =====
alter function public.sale_event_settle(uuid, text) rename to sale_event_settle_impl;
revoke all on function public.sale_event_settle_impl(uuid, text) from anon, authenticated;
create or replace function public.sale_event_settle(p_event_id uuid, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $fn$
begin
  if not staff_key_header_ok() then raise exception 'staffkey' using errcode='42501'; end if;
  return public.sale_event_settle_impl(p_event_id, p_by);
end $fn$;
grant execute on function public.sale_event_settle(uuid, text) to anon;
revoke execute on function public.tgc_assign_scan_code() from anon;

-- ===== 適用: P0-3 write revoke =====
revoke insert, update, delete on customer_prices      from anon;
revoke insert, update, delete on public_holidays       from anon;
revoke insert, update, delete on staff_fixed_schedule  from anon;

-- ===== 適用: P0-6 portal_password purge =====
update customers set portal_password = null where portal_password is not null;

-- ===== アサーション =====
do $$
declare
  s int; h int; sp int; hp int; pw int; bd int; msg text := '';
  v_scan text; v_staff uuid; prov1 jsonb; prov2 jsonb;
begin
  -- P0-6: 平文0件
  select count(*) into pw from customers where portal_password is not null;
  if pw <> 0 then msg := msg || format('portal_password残=%s(want0); ', pw); end if;

  -- P0-2 negative: anon(ヘッダ無し)は staff/hunters が0行
  set local role anon;
  select count(*) into s from staff;
  select count(*) into h from hunters;
  select count(*) into sp from staff_public;
  select count(*) into hp from hunters_public;
  reset role;
  if s <> 0  then msg := msg || format('anon staff可視=%s(want0); ', s); end if;
  if h <> 0  then msg := msg || format('anon hunters可視=%s(want0); ', h); end if;
  if sp = 0  then msg := msg || 'staff_public空(want>0); '; end if;
  if hp = 0  then msg := msg || 'hunters_public空(want>0); '; end if;

  -- P0-2 negative: anon は staff/hunters に書けない（RLS with check false）
  begin
    set local role anon;
    insert into staff(name) values('P0不正');
    reset role; msg := msg || 'anon staff INSERT通過(want不可); ';
  exception when others then reset role; end;

  -- P0-1 negative: sale_event_settle は staff-key無しで 42501
  begin
    set local role anon;
    perform sale_event_settle('00000000-0000-0000-0000-000000000000'::uuid, null);
    reset role; msg := msg || 'settle未ガード; ';
  exception when insufficient_privilege then reset role;
           when others then reset role; msg := msg || 'settle想定外:'||sqlerrm||'; ';
  end;

  -- P0-1 negative: admin_staff_list も staff-key無しで 42501
  begin
    set local role anon;
    perform admin_staff_list();
    reset role; msg := msg || 'admin_staff_list未ガード; ';
  exception when insufficient_privilege then reset role;
           when others then reset role; msg := msg || 'adminlist想定外:'||sqlerrm||'; ';
  end;

  -- P0-3 negative: anon は未使用テーブルへ書けない
  begin
    set local role anon;
    insert into public_holidays(holiday_date, name) values('2099-01-01','X');
    reset role; msg := msg || 'anon public_holidays INSERT通過(want不可); ';
  exception when others then reset role; end;

  -- positive(業務継続): トリガはanon剥奪後も発火し scan_code を採番
  set local role anon;
  insert into inventory(part_name, weight) values('P0テスト', 1.0) returning scan_code into v_scan;
  reset role;
  if v_scan is null or v_scan !~ '^[0-9]{8}$' then msg := msg || 'トリガ採番失敗:'||coalesce(v_scan,'NULL')||'; '; end if;

  -- positive: punch用の列固定RPC は anon でも動く（休憩初期値のみ更新）
  select id into v_staff from staff where deleted_at is null limit 1;
  if v_staff is not null then
    set local role anon;
    perform staff_set_break_default(v_staff, 45);
    reset role;
    select default_break_min into bd from staff where id=v_staff;
    if bd <> 45 then msg := msg || 'staff_set_break_default反映されず; '; end if;
  end if;

  -- positive: 仮登録RPC は冪等（2回目は created=false）
  set local role anon;
  prov1 := public_hunter_provisional('P0テスト捕獲者ZZZ');
  prov2 := public_hunter_provisional('P0テスト捕獲者ZZZ');
  reset role;
  if (prov1->>'created')::boolean is not true then msg := msg || '仮登録1回目created≠true; '; end if;
  if (prov2->>'created')::boolean is not false then msg := msg || '仮登録2回目created≠false(冪等でない); '; end if;

  raise exception 'TESTRESULT: %', case when msg = '' then 'ALL PASS' else 'FAIL: '||msg end;
end $$;
