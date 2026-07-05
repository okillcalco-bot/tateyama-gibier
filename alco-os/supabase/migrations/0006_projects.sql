-- ============================================================
-- ALCO OS  0006: Projects（ROKA改修・拠点整備・行政調整）モジュール
-- 汎用プロジェクト管理 + 意思決定ログ + 業者・見積管理
-- ============================================================

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name text not null,                      -- 例: R.O.K.A. リノベーション
  project_type text,                       -- renovation / facility / admin_coordination / other
  status text not null default 'active',   -- active / on_hold / completed / cancelled
  description text,
  start_date date,
  target_end_date date,
  budget numeric,
  related_grant_project_id uuid references grant_projects(id),
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists project_phases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  project_id uuid not null references projects(id) on delete cascade,
  name text not null,                      -- 例: 水道引込 / 内装 / 保健所協議
  status text not null default 'planned',  -- planned / in_progress / done / blocked
  start_date date,
  end_date date,
  sort_order integer,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 課題・リスク
create table if not exists project_issues (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  project_id uuid not null references projects(id) on delete cascade,
  title text not null,
  issue_type text not null default 'issue', -- issue / risk / blocker
  severity text not null default 'medium',  -- low / medium / high / critical
  status text not null default 'open',      -- open / mitigating / resolved / accepted
  description text,
  owner_id uuid references profiles(id),
  due_date date,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 意思決定ログ（なぜその判断をしたかを残す。後から絶対に消さない）
create table if not exists project_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  project_id uuid not null references projects(id) on delete cascade,
  decided_on date not null,
  title text not null,
  context text,                             -- 背景・選択肢
  decision text not null,                   -- 決定内容
  consequences text,                        -- 影響・フォローアップ
  decided_by text,                          -- 決定者（社外含むため自由記述）
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

-- 業者
create table if not exists vendors (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name text not null,
  trade text,                               -- 水道 / 電気 / 内装 / 設備 等
  contact_person text,
  phone text,
  email text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- 見積
create table if not exists vendor_quotes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  project_id uuid references projects(id),
  vendor_id uuid references vendors(id),
  title text not null,
  amount numeric,
  quoted_on date,
  status text not null default 'received',  -- requested / received / accepted / rejected
  file_id uuid references files(id),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['projects','project_phases','project_issues',
                           'project_decisions','vendors','vendor_quotes']
  loop
    perform alco_add_member_policy(t);
  end loop;
  foreach t in array array['projects','project_phases','project_issues','vendors','vendor_quotes']
  loop
    execute format('drop trigger if exists trg_%s_updated_at on %s', t, t);
    execute format('create trigger trg_%s_updated_at before update on %s
                    for each row execute function set_updated_at()', t, t);
  end loop;
end $$;

create index if not exists idx_project_issues_project on project_issues (project_id, status);

do $$ begin
  alter table voice_memos
    add constraint fk_voice_memos_project foreign key (related_project_id) references projects(id);
exception when duplicate_object then null; end $$;
