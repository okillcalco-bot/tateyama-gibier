-- テスト専用: 本番DB（clpdyrehdgzgiidbfucj）の受注まわりの定義を 2026-10-02 に読取りで写したもの。
-- 実データは含まない。ローカルの使い捨て PostgreSQL にだけ流す（本番には絶対に流さない）。
-- 列・既定値・NOT NULL・CHECK・一意索引・外部キー・RLSポリシーは本番の定義どおり。
-- Supabase 固有の部分（anon/authenticated ロール、request.headers、extensions スキーマ）は最小限で再現する。

create extension if not exists pgcrypto;
create schema if not exists extensions;
-- 本番では extensions.digest / extensions.crypt。ここでは public の pgcrypto をラップする
create or replace function extensions.digest(text, text) returns bytea language sql immutable as $$ select public.digest($1, $2) $$;
create or replace function extensions.digest(bytea, text) returns bytea language sql immutable as $$ select public.digest($1, $2) $$;
create or replace function extensions.crypt(text, text) returns text language sql immutable as $$ select public.crypt($1, $2) $$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema extensions to anon, authenticated, service_role;

-- FK 先のスタブ（列は必要最小限）
create table public.individuals (label_id text primary key, species text);
create table public.portal_products (id uuid primary key default gen_random_uuid(), name text);

create table public.app_secrets (key text not null primary key, hash text not null, updated_at timestamptz not null default now());
create table public.auth_attempts (id bigserial primary key, kind text, ok boolean, created_at timestamptz default now());
create table public.security_events (id bigserial primary key, event text, detail text, created_at timestamptz default now());

create table public.customers (id uuid not null default gen_random_uuid(), code text not null, name text not null, contact_name text, email text, phone text, address text, portal_token text default (gen_random_uuid())::text, price_rank text default 'standard'::text, notes text, created_at timestamp with time zone default now(), kana text, building text, portal_password text, default_item text, company1 text, company2 text, honorific text default '様'::text, requester_code text, requester_phone text, default_time_zone text default '0000'::text, is_active boolean default true, signup_source text, order_method text, notify_method text, default_carriers text[], portal_login_id text, portal_enabled boolean not null default false, is_starred boolean not null default false, search_aliases text[]);
alter table public.customers add constraint customers_pkey primary key (id);
alter table public.customers add constraint customers_code_key unique (code);
alter table public.customers add constraint customers_portal_token_key unique (portal_token);
alter table public.customers add constraint customers_price_rank_check check ((price_rank = any (array['standard'::text, 'local'::text, 'startmember'::text, 'premium'::text, 'wholesale'::text])));

create table public.orders (id uuid not null default gen_random_uuid(), order_code text not null, customer_id uuid, order_date date default current_date, delivery_date date, status text default '受付'::text, total_amount integer default 0, notes text, created_at timestamp with time zone default now(), customer_name text, delivery_time_zone text default '0000'::text, delivery_postal text, delivery_address text, delivery_building text, delivery_name text, delivery_phone text, price_rank text default 'standard'::text, memo text, channel text default 'ポータル'::text, updated_at timestamp with time zone default now(), carrier text, client_request_id text);
alter table public.orders add constraint orders_pkey primary key (id);
alter table public.orders add constraint orders_order_code_key unique (order_code);
alter table public.orders add constraint orders_customer_id_fkey foreign key (customer_id) references customers(id);
alter table public.orders add constraint orders_status_check check ((status = any (array['受注'::text, '確認済'::text, '発送済'::text, '納品完了'::text, 'キャンセル'::text])));
create index idx_orders_customer on public.orders (customer_id);
create index idx_orders_status on public.orders (status);
create index idx_orders_delivery_date on public.orders (delivery_date);
create unique index orders_client_request_uq on public.orders (customer_id, client_request_id) where (client_request_id is not null);
create or replace function public.update_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
create trigger trg_orders_updated before update on public.orders for each row execute function update_updated_at();

create table public.inventory (id uuid not null default gen_random_uuid(), individual_id text, part_name text not null, barcode_num text, weight numeric not null, ident_code text, status text default '在庫'::text, operator text, grade text, unit_price integer, created_at timestamp with time zone default now(), updated_at timestamp with time zone default now(), individual_code text, species text, lot_code text, processed_by text, processed_at timestamp with time zone default now(), weight_kg numeric, deleted_at timestamp with time zone, tier integer not null default 2, parent_inventory_id uuid, process_type text, location_code text, scan_code text);
alter table public.inventory add constraint inventory_pkey primary key (id);
alter table public.inventory add constraint inventory_ident_code_key unique (ident_code);
alter table public.inventory add constraint inventory_individual_id_fkey foreign key (individual_id) references individuals(label_id) on update cascade;
alter table public.inventory add constraint inventory_parent_inventory_id_fkey foreign key (parent_inventory_id) references inventory(id) on delete set null;
alter table public.inventory add constraint inventory_status_check check ((status = any (array['在庫'::text, '引当済'::text, '出荷済'::text, '加工済'::text, '廃棄'::text])));
alter table public.inventory add constraint inventory_tier_check check ((tier = any (array[2, 3])));

create table public.order_items (id uuid not null default gen_random_uuid(), order_id uuid, inventory_id uuid, part_name text not null, species text, weight numeric, unit_price integer, amount integer, created_at timestamp with time zone default now(), product_id uuid, weight_kg numeric, subtotal numeric, product_id_v2 uuid, product_name text, grade_snapshot text, price_rank_applied text, price_source text, requested_kg numeric, allocated_kg numeric);
alter table public.order_items add constraint order_items_pkey primary key (id);
alter table public.order_items add constraint order_items_inventory_id_fkey foreign key (inventory_id) references inventory(id);
alter table public.order_items add constraint order_items_order_id_fkey foreign key (order_id) references orders(id) on delete cascade;
alter table public.order_items add constraint order_items_product_id_v2_fkey foreign key (product_id_v2) references portal_products(id);
create index idx_order_items_order on public.order_items (order_id);

create table public.inventory_allocations (id uuid not null default gen_random_uuid(), order_item_id uuid not null, inventory_id uuid not null, weight_kg numeric not null, created_at timestamp with time zone not null default now());
alter table public.inventory_allocations add constraint inventory_allocations_pkey primary key (id);
alter table public.inventory_allocations add constraint inventory_allocations_inventory_id_fkey foreign key (inventory_id) references inventory(id);
alter table public.inventory_allocations add constraint inventory_allocations_order_item_id_fkey foreign key (order_item_id) references order_items(id) on delete cascade;
create unique index inventory_allocations_pack_once on public.inventory_allocations (inventory_id);

create table public.shipments (id uuid not null default gen_random_uuid(), order_id uuid, customer_id uuid, shipment_date date default current_date, delivery_date date, status text default '準備中'::text, notes text, created_at timestamp with time zone default now(), carrier text, size_code integer, is_cool boolean, freight integer);
alter table public.shipments add constraint shipments_pkey primary key (id);
alter table public.shipments add constraint shipments_customer_id_fkey foreign key (customer_id) references customers(id);
alter table public.shipments add constraint shipments_order_id_fkey foreign key (order_id) references orders(id);
alter table public.shipments add constraint shipments_status_check check ((status = any (array['準備中'::text, '出荷済'::text, '配達済'::text])));

create table public.documents (id uuid not null default gen_random_uuid(), doc_type text not null, doc_number text not null, customer_id uuid, order_id uuid, issue_date date default current_date, due_date date, total_amount integer, tax_amount integer, status text default '発行済'::text, created_at timestamp with time zone default now(), tax_category text, payment_method text, billing_status text, partner_name text, subject text, honorific text, partner_address text, memo text, source text, snapshot jsonb);
alter table public.documents add constraint documents_pkey primary key (id);
alter table public.documents add constraint documents_doc_number_key unique (doc_number);
alter table public.documents add constraint documents_customer_id_fkey foreign key (customer_id) references customers(id);
alter table public.documents add constraint documents_order_id_fkey foreign key (order_id) references orders(id);
alter table public.documents add constraint documents_doc_type_check check ((doc_type = any (array['見積書'::text, '納品書'::text, '請求書'::text, '領収書'::text])));

create table public.document_orders (id uuid not null default gen_random_uuid(), document_id uuid not null, order_id uuid not null, created_at timestamp with time zone default now());
alter table public.document_orders add constraint document_orders_pkey primary key (id);
alter table public.document_orders add constraint document_orders_document_id_order_id_key unique (document_id, order_id);
alter table public.document_orders add constraint document_orders_document_id_fkey foreign key (document_id) references documents(id) on delete cascade;

create table public.price_master (id uuid not null default gen_random_uuid() primary key, species text not null, part_name text not null, barcode_num text, grade text default 'standard'::text, price_standard integer default 0, price_premium integer default 0, price_wholesale integer default 0, created_at timestamp with time zone default now(), price_local numeric, price_startmember numeric);

-- 本番と同じ「スタッフキー（ヘッダ）」判定
create or replace function public.staff_key_header_ok() returns boolean language plpgsql stable security definer set search_path to 'public', 'extensions' as $function$
declare v_hdr text; v_hash text;
begin
  begin v_hdr := (current_setting('request.headers', true))::jsonb ->> 'x-staff-key'; exception when others then v_hdr := null; end;
  if v_hdr is null or v_hdr = '' then return false; end if;
  select hash into v_hash from app_secrets where key = 'staff_key_sha256';
  if v_hash is null then return false; end if;
  return encode(extensions.digest(v_hdr, 'sha256'), 'hex') = v_hash;
end; $function$;
create or replace function public.staff_key_ok(p_staff_key text) returns boolean language plpgsql security definer set search_path to 'public', 'extensions' as $function$
declare v_hash text;
begin
  select hash into v_hash from app_secrets where key = 'staff_key';
  return v_hash is not null and v_hash = extensions.crypt(coalesce(p_staff_key,''), v_hash);
end; $function$;
insert into app_secrets(key, hash) values
  ('staff_key_sha256', encode(digest('test-staff-key', 'sha256'), 'hex')),
  ('staff_key', crypt('test-staff-key', gen_salt('bf')));

-- 本番と同じ admin_set_order_status（引当解放の詳細は省略）
create or replace function public.admin_set_order_status(p_staff_key text, p_order_id uuid, p_status text) returns jsonb language plpgsql security definer set search_path to 'public' as $function$
declare v_cur text;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if p_status not in ('受注','確認済','発送済','納品完了','キャンセル') then raise exception 'ステータスが正しくありません: %', p_status; end if;
  select status into v_cur from orders where id = p_order_id;
  if v_cur is null then raise exception '注文が見つかりません'; end if;
  update orders set status = p_status, updated_at = now() where id = p_order_id;
  return jsonb_build_object('ok', true);
end; $function$;

-- 本番の RLS（2026-10-02 時点）: orders / order_items は anon に全行 SELECT/INSERT/UPDATE、customers はスタッフキー必須
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.customers enable row level security;
alter table public.shipments enable row level security;
alter table public.documents enable row level security;
alter table public.document_orders enable row level security;
alter table public.inventory enable row level security;
alter table public.inventory_allocations enable row level security;
create policy orders_anon_select on orders for select to anon, authenticated using (true);
create policy orders_anon_insert on orders for insert to anon, authenticated with check (true);
create policy orders_anon_update on orders for update to anon, authenticated using (true) with check (true);
create policy order_items_anon_select on order_items for select to anon, authenticated using (true);
create policy order_items_anon_insert on order_items for insert to anon, authenticated with check (true);
create policy order_items_anon_update on order_items for update to anon, authenticated using (true) with check (true);
create policy customers_staff_select on customers for select to anon using ((select staff_key_header_ok()));
create policy customers_insert on customers for insert to anon with check ((select staff_key_header_ok()));
create policy customers_staff_update on customers for update to anon using ((select staff_key_header_ok())) with check ((select staff_key_header_ok()));
create policy allow_all on shipments for all using (true) with check (true);
create policy allow_all on documents for all using (true) with check (true);
create policy document_orders_all on document_orders for all using (true) with check (true);
create policy inventory_all on inventory for all using (true) with check (true);
-- inventory_allocations: RLS有効・ポリシーなし（SECURITY DEFINER の引当関数からのみ書く）
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;
grant all on all tables in schema public to service_role;
