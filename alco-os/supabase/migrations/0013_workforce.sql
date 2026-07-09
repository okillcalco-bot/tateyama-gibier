-- ============================================================
-- ALCO OS  0013: 勤怠・シフト管理（HRMOS勤怠のシフト機能を参考）
--
-- 既存ジビエ基幹のテーブルをそのまま活かす:
--   staff      … スタッフ台帳（既存。変更しない）
--   attendance … 打刻実績（punch.html が書き込む。変更しない）
--   shifts     … シフト予定（既存だが未使用だったため ALCO OS が正式採用。
--                 スキーマ変更はせず、行の読み書きのみ行う）
-- ALCO OS 側で足りないものだけを追加する:
--   shift_patterns … シフトパターン（早番/日勤/遅番など。HRMOSのパターン登録に相当）
--   shift_requests … 希望シフト（スタッフの出勤希望・休み希望の収集）
-- ============================================================

create table if not exists shift_patterns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name text not null,                       -- パターン名（例: 日勤）。shifts.shift_type と対応させる
  short_label text not null default '',     -- シフト表のセル表示（例: 日）
  start_time time not null,
  end_time time not null,
  break_minutes integer not null default 60,
  color text not null default '#3B82F6',    -- シフト表の色分け
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_shift_patterns_org on shift_patterns (organization_id, sort_order);

drop trigger if exists trg_shift_patterns_updated_at on shift_patterns;
create trigger trg_shift_patterns_updated_at before update on shift_patterns
  for each row execute function set_updated_at();

select alco_add_member_policy('shift_patterns');

-- 希望シフト。staff_id は既存 staff テーブルの id を指すが、
-- 既存側の運用（削除等）を妨げないよう FK は張らない（汎用参照の流儀）
create table if not exists shift_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  staff_id uuid not null,                   -- staff.id（FKなし）
  work_date date not null,
  preference text not null default 'ok',    -- ok（出られる）/ ng（休み希望）/ partial（時間指定あり）
  start_time time,                          -- partial のときの出られる時間帯
  end_time time,
  note text,
  status text not null default 'open',      -- open（未反映）/ reflected（シフト反映済み）
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_shift_requests_org_date on shift_requests (organization_id, work_date);

drop trigger if exists trg_shift_requests_updated_at on shift_requests;
create trigger trg_shift_requests_updated_at before update on shift_requests
  for each row execute function set_updated_at();

select alco_add_member_policy('shift_requests');
