-- 施設アプリ化 追加スキーマ（2026-07-03 適用済み）
-- 本番DB(clpdyrehdgzgiidbfucj)の実スキーマ確認後に調整した版。
-- 追加のみ（CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS）で、
-- 既存テーブル・既存カラム・既存データは変更しない。
-- RLSは既存テーブルと同じパターン（有効化 + allow_all ポリシー）に合わせる。
-- ※staffテーブルは既存（シフト管理用: id/name/color/is_active）のためカラム追加で拡張。

-- ── 捕獲者台帳 ──
create table if not exists hunters (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  city text,                -- 館山市 / 南房総市 / その他
  address text,
  phone text,
  trap_area text,           -- 罠の設置場所
  bank_name text,
  bank_branch text,
  account_type text,        -- 普通 / 当座
  account_number text,
  account_holder text,      -- 口座名義（カナ）
  memo text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted_at timestamptz
);

-- ── スタッフ（既存テーブルに人事・給与カラムを追加） ──
alter table staff add column if not exists role text;
alter table staff add column if not exists phone text;
alter table staff add column if not exists hire_date date;
alter table staff add column if not exists employment_type text;      -- 時給 / 月給
alter table staff add column if not exists hourly_wage numeric;
alter table staff add column if not exists monthly_salary numeric;
alter table staff add column if not exists social_insurance text;     -- 加入 / 未加入
alter table staff add column if not exists employment_insurance text; -- 加入 / 未加入
alter table staff add column if not exists memo text;
alter table staff add column if not exists deleted_at timestamptz;

-- ── 出退勤 ──
create table if not exists attendance (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid references staff(id),
  staff_name text,
  work_date date not null,
  clock_in text,            -- HH:MM
  clock_out text,           -- HH:MM
  break_minutes integer default 0,
  note text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists idx_attendance_date on attendance(work_date);

-- ── 清掃記録（HACCP・国産ジビエ認証準拠） ──
create table if not exists cleaning_logs (
  id uuid primary key default gen_random_uuid(),
  room text not null,       -- 解体室 / 精肉室 / 冷蔵・冷凍庫 / 前室・更衣室 / トイレ / 施設外周
  staff_name text not null,
  cleaned_at timestamptz not null default now(),
  items text,               -- 実施項目（読点区切り）
  temperature text,         -- 冷蔵・冷凍庫のみ
  note text,
  created_at timestamptz default now()
);
create index if not exists idx_cleaning_logs_at on cleaning_logs(cleaned_at);

-- ── 資材在庫（消耗品） ──
create table if not exists supplies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text,
  unit text,
  stock_qty numeric default 0,
  min_qty numeric default 0, -- 発注点
  supplier text,
  memo text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  deleted_at timestamptz
);

-- ── 冷凍庫ロケーションマスタ ──
create table if not exists freezers (
  id uuid primary key default gen_random_uuid(),
  code text not null unique, -- 例: F1
  name text,
  note text,
  created_at timestamptz default now()
);

-- ── 気になる点フラグ（データ管理） ──
create table if not exists data_flags (
  id uuid primary key default gen_random_uuid(),
  target text not null,     -- 例: inventory / TGC-08-T001-11
  comment text not null,
  flagged_by text,
  status text default '未対応', -- 未対応 / 対応済
  created_at timestamptz default now()
);

-- ── 個体（individuals）への追加カラム ──
alter table individuals add column if not exists intake_method text;      -- 持込 / 出張止め刺し
alter table individuals add column if not exists intake_staff text;       -- 出張対応者
alter table individuals add column if not exists organs_use text;         -- 内臓の活用
alter table individuals add column if not exists hide_status text;        -- 皮: 販売可 / 保管中 / 加工中 / 廃棄
alter table individuals add column if not exists hide_location text;      -- 皮の保管場所
alter table individuals add column if not exists processing_notes text;   -- 解体時メモ（欠損等）
alter table individuals add column if not exists aging_method text;       -- 熟成 / 直接分割
alter table individuals add column if not exists aging_started_at timestamptz;
alter table individuals add column if not exists aging_ended_at timestamptz;

-- ── 在庫（inventory）への追加カラム ──
alter table inventory add column if not exists location_code text;        -- 冷凍庫ロケーション

-- ── RLS: 既存テーブルと同じパターン（有効化 + allow_all） ──
alter table hunters enable row level security;
alter table attendance enable row level security;
alter table cleaning_logs enable row level security;
alter table supplies enable row level security;
alter table freezers enable row level security;
alter table data_flags enable row level security;

do $$ begin
  create policy allow_all on hunters for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy allow_all on attendance for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy allow_all on cleaning_logs for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy allow_all on supplies for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy allow_all on freezers for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy allow_all on data_flags for all using (true) with check (true);
exception when duplicate_object then null; end $$;

-- ── 冷凍庫の初期データ（実際の構成に合わせて後から編集可） ──
insert into freezers (code, name)
values ('F1', '冷凍庫1（大型ストッカー）'), ('F2', '冷凍庫2（大型ストッカー）'), ('F3', '冷凍庫3（小型）'), ('R1', '冷蔵庫1（熟成用）')
on conflict (code) do nothing;
