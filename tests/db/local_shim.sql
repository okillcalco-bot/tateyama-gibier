-- tests/db/local_shim.sql
-- 本番DBに触れずに P0 migration とDBテストを流すための「最小の模擬土台」。
-- 本番の全スキーマではない。P0 migration が触る関数・テーブルを、同じシグネチャ・同じ
-- 既定権限（関数は PUBLIC に EXECUTE、テーブルは anon に allow-all）で用意するだけ。
-- 使い方: tests/db/run-local.sh（一時的な PostgreSQL を起動して流す）

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
grant usage on schema public to anon, authenticated;

-- PostgREST はリクエストヘッダを request.headers（JSON）に入れる。staff-key はそのSHA256照合（本番と同じ形）
create table public.app_secrets (k text primary key, v text);
insert into public.app_secrets values ('staff_key_sha256', encode(sha256(convert_to('test-staff-key', 'UTF8')), 'hex'));
create or replace function public.staff_key_header_ok() returns boolean
language plpgsql stable security definer set search_path to 'public' as $$
declare h text;
begin
  h := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb ->> 'x-staff-key';
  if h is null then return false; end if;
  return encode(sha256(convert_to(h, 'UTF8')), 'hex') = (select v from app_secrets where k = 'staff_key_sha256');
end $$;
grant execute on function public.staff_key_header_ok() to anon, authenticated;

-- レート制限（本番は本リポ外定義。形だけ合わせる）
create table public._rl (bucket text, at timestamptz default now());
create or replace function public._rl_hit(p_bucket text, p_window integer, p_max integer) returns jsonb
language plpgsql volatile security definer set search_path to 'public' as $$
declare n int;
begin
  select count(*) into n from _rl where bucket = p_bucket and at > now() - make_interval(secs => p_window);
  if n >= p_max then return jsonb_build_object('allowed', false); end if;
  insert into _rl(bucket) values (p_bucket);
  return jsonb_build_object('allowed', true);
end $$;

create table public.staff (
  id uuid primary key default gen_random_uuid(), name text not null, color text, is_active boolean default true,
  default_break_min integer default 60, phone text, hourly_wage numeric, monthly_salary numeric, deleted_at timestamptz);
create table public.hunters (
  id uuid primary key default gen_random_uuid(), name text not null, furigana text, memo text, phone text, address text,
  city text, trap_area text, bank_name text, account_number text, name_public boolean, deleted_at timestamptz);
create table public.customers (id uuid primary key default gen_random_uuid(), name text, portal_password text);
create table public.customer_prices (id serial primary key, customer_id uuid, price numeric);
create table public.public_holidays (holiday_date date primary key, name text);
create table public.staff_fixed_schedule (id serial primary key, staff_id uuid, weekday int);
create table public.inventory (id serial primary key, part_name text, weight numeric, scan_code text);

alter table public.staff enable row level security;
alter table public.hunters enable row level security;
create policy "Allow all access to staff" on public.staff for all to anon using (true) with check (true);
create policy hunters_select on public.hunters for select to anon using (deleted_at is null);
create policy hunters_insert on public.hunters for insert to anon with check (true);
create policy hunters_update on public.hunters for update to anon using (true) with check (true);
grant select, insert, update, delete on public.staff, public.hunters, public.customers, public.customer_prices,
  public.public_holidays, public.staff_fixed_schedule, public.inventory to anon, authenticated;
grant usage on all sequences in schema public to anon, authenticated;

insert into public.staff(name) values ('模擬スタッフA'), ('模擬スタッフB');
insert into public.hunters(name, phone, city, trap_area) values ('模擬捕獲者A', '000-0000-0000', '館山市', '模擬地区');
insert into public.customers(name, portal_password) values ('模擬顧客', 'plain');

-- トリガ採番（形だけ。8桁）
create or replace function public.tgc_assign_scan_code() returns trigger language plpgsql as $$
begin new.scan_code := lpad((floor(random() * 1e8))::bigint::text, 8, '0'); return new; end $$;
create trigger inventory_scan before insert on public.inventory for each row execute function public.tgc_assign_scan_code();
create or replace function public.tgc_assign_individual_number() returns trigger language plpgsql as $$ begin return new; end $$;

-- 状態変更RPC（本体は模擬。シグネチャは本番と同じ）
create or replace function public.sale_event_settle(p_event_id uuid, p_by text default null) returns jsonb
  language sql security definer set search_path to 'public' as $$ select jsonb_build_object('ok', true, 'fn', 'settle') $$;
create or replace function public.sale_event_reopen(p_event_id uuid, p_by text default null) returns jsonb
  language sql security definer set search_path to 'public' as $$ select jsonb_build_object('ok', true, 'fn', 'reopen') $$;
create or replace function public.sale_event_takeout(p_event_id uuid, p_by text default null) returns jsonb
  language sql security definer set search_path to 'public' as $$ select jsonb_build_object('ok', true, 'fn', 'takeout') $$;
create or replace function public.staff_voice_moderate(p_id uuid, p_action text, p_by text default null) returns jsonb
  language sql security definer set search_path to 'public' as $$ select jsonb_build_object('ok', true) $$;
create or replace function public.staff_voices_list(p_status text default 'pending', p_limit integer default 200) returns jsonb
  language sql stable security definer set search_path to 'public' as $$ select '[]'::jsonb $$;
grant execute on function public.sale_event_settle(uuid, text), public.sale_event_reopen(uuid, text),
  public.sale_event_takeout(uuid, text), public.staff_voice_moderate(uuid, text, text),
  public.staff_voices_list(text, integer) to anon, authenticated;

-- anon 剥奪の対象（中身は模擬）
create or replace function public.apply_fixed_schedule(date, date) returns void language sql as $$ select $$;
create or replace function public.apply_fixed_schedule_prev_month() returns void language sql as $$ select $$;
create or replace function public.waste_summary(date, date) returns jsonb language sql as $$ select '{}'::jsonb $$;
create or replace function public.can_approve() returns boolean language sql as $$ select false $$;
create or replace function public.has_role(text) returns boolean language sql as $$ select false $$;
create or replace function public.current_organization_id() returns uuid language sql as $$ select null::uuid $$;
create or replace function public.provision_profile(text) returns void language sql as $$ select $$;
create or replace function public.mail_import_outlet_day(text, date, timestamp with time zone, jsonb) returns void language sql as $$ select $$;
create or replace function public.security_retention_purge() returns void language sql as $$ select $$;
create or replace function public.get_capture_form_by_token(text) returns jsonb language sql as $$ select null::jsonb $$;
