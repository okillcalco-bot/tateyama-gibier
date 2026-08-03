-- 請求書v2: 明細スナップショット・入金消込・下書き/取消（Misoca相当の軸）
-- documents = 帳票共通ヘッダー（既存流用）/ document_items = 明細 / payments = 入金
-- 適用済み: 2026-08-03（Supabase migration: invoice_v2_items_payments）

alter table documents add column if not exists subject text;          -- 件名
alter table documents add column if not exists honorific text;        -- 敬称
alter table documents add column if not exists partner_address text;  -- 請求先住所（発行時点）
alter table documents add column if not exists memo text;             -- 備考
alter table documents add column if not exists source text;           -- 'invoice_ui' | 'order_docs'
alter table documents add column if not exists snapshot jsonb;        -- 発行時スナップショット（発行元/振込先/明細/税集計）

create table if not exists document_items (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  line_no integer not null default 1,
  item_date date,                 -- 納品日（任意）
  name text not null,
  quantity numeric,
  unit text,
  unit_price numeric,
  tax_rate integer not null default 8,   -- 8=軽減 / 10=標準 / 0=対象外
  amount integer not null default 0,     -- 税抜・整数円
  created_at timestamptz default now()
);
create index if not exists document_items_document_id_idx on document_items(document_id);
alter table document_items enable row level security;
drop policy if exists document_items_all on document_items;
create policy document_items_all on document_items for all using (true) with check (true);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  paid_date date not null default current_date,
  amount integer not null,
  method text default '振込',
  note text,
  created_at timestamptz default now()
);
create index if not exists payments_document_id_idx on payments(document_id);
alter table payments enable row level security;
drop policy if exists payments_all on payments;
create policy payments_all on payments for all using (true) with check (true);

-- 請求書番号の重複防止（請求書作成UI発行分のみ。書類発行タブの注文別複数行は対象外）
create unique index if not exists documents_invoice_number_uniq
  on documents(doc_number) where doc_type = '請求書' and order_id is null and status <> '下書き';
