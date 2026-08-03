-- 請求書と注文の紐付け（締め請求・二重請求防止）
-- 設計指示書の document_links 相当。1請求書に複数注文をぶら下げる
-- 適用済み: 2026-08-03（Supabase migration: document_orders_link）
create table if not exists document_orders (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  order_id uuid not null,
  created_at timestamptz default now(),
  unique (document_id, order_id)
);
create index if not exists document_orders_order_id_idx on document_orders(order_id);
create index if not exists document_orders_document_id_idx on document_orders(document_id);
alter table document_orders enable row level security;
drop policy if exists document_orders_all on document_orders;
create policy document_orders_all on document_orders for all using (true) with check (true);
