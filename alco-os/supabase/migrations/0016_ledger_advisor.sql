-- ============================================================
-- ALCO OS  0016: 売上伝票（経理の入口）+ 士業相談
--
-- sales_slips: スタッフがスマホで入力する簡易売上伝票。
--   小売の手売り・解体体験・イベント販売など「領収書不要の売上」を記録する。
--   番号は月毎の自動採番（SL-202607-001）。取消はソフトデリート = 欠番。
--   月次集計とCSVで税理士連携する（会計ソフトAPI連携は段階2）。
-- advisor_consultations: 士業相談（税務/労務/法務/知財/行政）。
--   AIは論点整理・一般的な考え方・専門家への質問リストを作る「一次相談」。
--   法的助言ではない。重要判断は必ず資格を持つ専門家へ（プロンプトで強制）。
-- ============================================================

create table if not exists sales_slips (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  month text not null,                      -- 採番対象月 "2026-07"
  seq integer not null,
  slip_number text not null,                -- SL-202607-001
  sale_date date not null,
  category text not null default 'retail',  -- retail(手売り)/experience(解体体験)/event(イベント)/shipping(出荷その他)/other
  item text not null,                       -- 品目・内容（例: イノシシロース 300g）
  quantity numeric,                         -- 数量（任意）
  amount numeric not null,                  -- 金額（税込）
  payment_method text not null default 'cash', -- cash/paypay/card/transfer/other
  staff_name text,                          -- 対応スタッフ（staff から選択 or 手入力）
  note text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz                    -- 取消（欠番として残す）
);
create unique index if not exists idx_sales_slips_number
  on sales_slips (organization_id, month, seq);
create index if not exists idx_sales_slips_date on sales_slips (organization_id, sale_date desc);

drop trigger if exists trg_sales_slips_updated_at on sales_slips;
create trigger trg_sales_slips_updated_at before update on sales_slips
  for each row execute function set_updated_at();

select alco_add_member_policy('sales_slips');

create table if not exists advisor_consultations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  category text not null default 'tax',     -- tax/labor/legal/ip/gov/other
  title text not null,
  question text not null,                   -- 相談内容（状況・困りごと）
  approved_content jsonb,                   -- 承認済みの整理結果
  status text not null default 'open',      -- open / approved / closed（専門家相談済み等）
  expert_note text,                         -- 実際に専門家へ相談した結果のメモ
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists idx_advisor_org on advisor_consultations (organization_id, created_at desc);

drop trigger if exists trg_advisor_updated_at on advisor_consultations;
create trigger trg_advisor_updated_at before update on advisor_consultations
  for each row execute function set_updated_at();

select alco_add_member_policy('advisor_consultations');
