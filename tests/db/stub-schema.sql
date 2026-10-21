-- 手元の PostgreSQL で migrations/ を検証するための最小の土台（本番の列構成に合わせた空の表・関数。データは入れない）。
-- 本番DBに触らずに、追加マイグレーションの文法・権限・お金の不変条件を試すために使う（tests/db/run.sh）。
create schema if not exists extensions;
create extension if not exists pgcrypto schema extensions;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;
grant usage on schema public to anon, authenticated;

create table public.app_secrets (key text primary key, hash text, updated_at timestamptz default now());
create table public.app_settings (key text primary key, value jsonb, updated_at timestamptz default now());
create table public.auth_attempts (id bigserial primary key, kind text, ok boolean, created_at timestamptz default now());
create table public.security_events (id uuid primary key default gen_random_uuid(), event text, detail text, created_at timestamptz default now());

create table public.customers (
  id uuid primary key default gen_random_uuid(), code text not null, name text not null, contact_name text, email text, phone text,
  address text, price_rank text, notes text, created_at timestamptz default now(), kana text, is_active boolean default true,
  search_aliases text[]);
create table public.documents (
  id uuid primary key default gen_random_uuid(), doc_type text not null, doc_number text not null, customer_id uuid references public.customers(id),
  order_id uuid, issue_date date, due_date date, total_amount integer, tax_amount integer, status text, created_at timestamptz default now(),
  tax_category text, payment_method text, billing_status text, partner_name text, subject text, honorific text, partner_address text,
  memo text, source text, snapshot jsonb);
create table public.payments (
  id uuid primary key default gen_random_uuid(), document_id uuid not null references public.documents(id) on delete cascade,
  paid_date date not null, amount integer not null, method text, note text, created_at timestamptz default now());
-- 本番と同じく、既存の payments は公開キーで読み書きできる（allow_all）
alter table public.payments enable row level security;
create policy allow_all on public.payments for all using (true) with check (true);
grant all on public.payments, public.customers, public.documents to anon, authenticated;

-- 本番の staff_key_ok と同じ定義（bcrypt 照合＋試行記録）
create or replace function public.staff_key_ok(p_staff_key text) returns boolean
language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_hash text; v_ok boolean; v_fail int;
begin
  select hash into v_hash from app_secrets where key = 'staff_key';
  v_ok := v_hash is not null and v_hash = extensions.crypt(coalesce(p_staff_key,''), v_hash);
  if v_ok then insert into auth_attempts (kind, ok) values ('staff_key', true); return true; end if;
  perform pg_advisory_xact_lock(hashtext('auth:staff_key'));
  select count(*) into v_fail from auth_attempts where kind = 'staff_key' and not ok and created_at > now() - interval '5 minutes';
  insert into auth_attempts (kind, ok) values ('staff_key', false);
  if v_fail >= 10 then insert into security_events (event, detail) values ('staff_key_bruteforce', '5分に誤り多数'); end if;
  return false;
end $function$;
insert into public.app_secrets (key, hash) values ('staff_key', extensions.crypt('TEST-staff-key', extensions.gen_salt('bf', 4)));
