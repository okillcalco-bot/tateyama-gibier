-- ============================================================
-- ALCO OS  0014: 帳票（請求書 / 納品書 / 領収書）
--
-- 受注（既存 orders / order_items）から帳票を発行し、台帳として保存する。
-- - 番号は「種類ごと・月ごと」に自動採番（例: INV-202607-001）
-- - 発行時点の明細・金額・発行者情報を jsonb でスナップショット
--   （後から注文やマスタが変わっても帳票は変わらない）
-- - 発行者情報は既存 org_settings の org_name / org_postal / org_address /
--   org_phone / invoice_number / org_bank_info キーを参照する（スキーマ変更なし）
-- ============================================================

create table if not exists billing_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  order_id uuid,                            -- 既存 orders.id（FKなし・汎用参照の流儀）
  doc_type text not null,                   -- invoice / delivery_note / receipt
  month text not null,                      -- 採番対象月 "2026-07"
  seq integer not null,                     -- 月内連番
  doc_number text not null,                 -- 例: INV-202607-001
  title text not null,                      -- ファイル名（任意入力。PDF保存時の既定名）
  issue_date date not null,
  due_date date,                            -- 請求書のお支払期限（任意）
  customer_name text,
  customer_address text,
  honorific text not null default '様',
  items jsonb not null default '[]',        -- 明細スナップショット
  subtotal numeric not null default 0,      -- 税抜相当額
  tax_rate integer not null default 8,      -- 8（軽減税率・食品）/ 10 / 0
  tax_amount numeric not null default 0,    -- 内消費税
  total numeric not null default 0,         -- 税込合計（受注の金額は税込扱い）
  note text,                                -- 備考 / 領収書の但し書き
  issuer jsonb,                             -- 発行者情報スナップショット
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create unique index if not exists idx_billing_documents_number
  on billing_documents (organization_id, doc_type, month, seq);
create index if not exists idx_billing_documents_order on billing_documents (order_id);

drop trigger if exists trg_billing_documents_updated_at on billing_documents;
create trigger trg_billing_documents_updated_at before update on billing_documents
  for each row execute function set_updated_at();

select alco_add_member_policy('billing_documents');
