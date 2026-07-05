-- ============================================================
-- ALCO OS  0001: Core
-- organizations / profiles / roles / tasks / files /
-- ai_runs / audit_logs / generated_drafts + RLS 基盤
--
-- 注意: 既存ジビエ基幹のテーブル（individuals, hunters, staff,
-- attendance, products, product_movements 等）には一切触れない。
-- 統合方針は docs/09-gibier-integration.md を参照。
-- ============================================================

-- ── 組織 ──
create table if not exists organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,                    -- 合同会社アルコ
  slug text not null unique,             -- alco
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── プロフィール（auth.users 1:1） ──
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null references organizations(id),
  display_name text not null,
  email text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── ロール ──
create table if not exists roles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  key text not null,                     -- owner / manager / staff / partner
  name text not null,                    -- 表示名（日本語）
  permissions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (organization_id, key)
);

create table if not exists user_roles (
  user_id uuid not null references profiles(id) on delete cascade,
  role_id uuid not null references roles(id) on delete cascade,
  granted_at timestamptz not null default now(),
  granted_by uuid references profiles(id),
  primary key (user_id, role_id)
);

-- ── RLS ヘルパー ──
create or replace function current_organization_id()
returns uuid
language sql stable security definer set search_path = public
as $$
  select organization_id from profiles where id = auth.uid();
$$;

create or replace function has_role(role_key text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1
    from user_roles ur
    join roles r on r.id = ur.role_id
    where ur.user_id = auth.uid() and r.key = role_key
  );
$$;

-- ── タスク（全モジュール共通） ──
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  title text not null,
  description text,
  status text not null default 'open',           -- open / in_progress / done / cancelled
  priority text not null default 'normal',       -- low / normal / high / urgent
  due_date date,
  assignee_id uuid references profiles(id),
  module text,                                   -- core/voice_memo/gibier/grants/nature/crm/projects/hr
  related_table text,                            -- 関連レコード（汎用参照）
  related_id uuid,
  source_draft_id uuid,                          -- generated_drafts 承認経由で作成された場合
  created_by uuid references profiles(id),
  updated_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists idx_tasks_org_status on tasks (organization_id, status);
create index if not exists idx_tasks_assignee on tasks (assignee_id) where deleted_at is null;

-- ── ファイル（Supabase Storage のメタデータ台帳） ──
create table if not exists files (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  bucket text not null default 'alco-os',
  path text not null,
  filename text not null,
  mime_type text,
  size_bytes bigint,
  module text,
  related_table text,
  related_id uuid,
  captured_at timestamptz,                       -- 撮影日時（証跡用）
  gps_lat numeric,
  gps_lng numeric,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (bucket, path)
);
create index if not exists idx_files_related on files (related_table, related_id);

-- ── AI実行ログ（すべてのAI呼び出しを記録。絶対に削除しない） ──
create table if not exists ai_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  workflow text not null,                        -- classify_voice_memo / generate_grant_draft / ...
  provider text not null,                        -- anthropic / mock / ...
  model text not null,
  prompt_version text,
  input_summary text,                            -- 個人情報を含む生入力は保存しない。要約のみ
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  status text not null default 'succeeded',      -- succeeded / failed
  error text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_ai_runs_org_workflow on ai_runs (organization_id, workflow, created_at desc);

-- ── 監査ログ（重要な業務変更をすべて記録。絶対に削除しない） ──
create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  actor_id uuid references profiles(id),
  action text not null,                          -- insert / update / delete / approve / discard / export
  table_name text not null,
  record_id uuid,
  before jsonb,
  after jsonb,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_logs_record on audit_logs (table_name, record_id);
create index if not exists idx_audit_logs_org_time on audit_logs (organization_id, created_at desc);

-- ── AI生成ドラフト（AI出力は必ずここに保存 → 人間承認 → 反映） ──
create table if not exists generated_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  ai_run_id uuid references ai_runs(id),
  draft_type text not null,       -- voice_memo_result / grant_application / nature_report / meeting_minutes / crm_email / ...
  source_table text,              -- 元になったレコード（voice_memos 等）
  source_id uuid,
  title text,
  content jsonb not null,         -- ワークフローごとの構造化出力（Zodスキーマに一致）
  confidence numeric,
  needs_human_review boolean not null default true,
  warnings text[],
  status text not null default 'draft',   -- draft / approved / discarded
  reviewed_by uuid references profiles(id),
  reviewed_at timestamptz,
  applied_at timestamptz,                  -- 承認後、業務テーブルへ反映した日時
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_drafts_org_status on generated_drafts (organization_id, status, created_at desc);
create index if not exists idx_drafts_source on generated_drafts (source_table, source_id);

-- ── updated_at 自動更新 ──
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['organizations','profiles','tasks','generated_drafts']
  loop
    execute format('drop trigger if exists trg_%s_updated_at on %s', t, t);
    execute format('create trigger trg_%s_updated_at before update on %s
                    for each row execute function set_updated_at()', t, t);
  end loop;
end $$;

-- ── RLS ヘルパー: 標準の「組織メンバーCRUD」ポリシーを付与 ──
-- 以降のモジュール追加時は `select alco_add_member_policy('table_name');` を呼ぶだけでよい
create or replace function alco_add_member_policy(tbl text)
returns void language plpgsql as $$
begin
  execute format('alter table %I enable row level security', tbl);
  begin
    execute format(
      'create policy %I on %I for all
         using (organization_id = current_organization_id())
         with check (organization_id = current_organization_id())',
      tbl || '_member_all', tbl);
  exception when duplicate_object then null;
  end;
end;
$$;

-- ── RLS ──
alter table organizations enable row level security;
alter table profiles enable row level security;
alter table roles enable row level security;
alter table user_roles enable row level security;
alter table tasks enable row level security;
alter table files enable row level security;
alter table ai_runs enable row level security;
alter table audit_logs enable row level security;
alter table generated_drafts enable row level security;

-- 自組織のみ参照可（書き込みはテーブルごとに制御）
do $$ begin
  create policy org_select on organizations for select
    using (id = current_organization_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy profiles_select on profiles for select
    using (organization_id = current_organization_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy profiles_update_self on profiles for update
    using (id = auth.uid()) with check (id = auth.uid());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy roles_select on roles for select
    using (organization_id = current_organization_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy user_roles_select on user_roles for select
    using (user_id in (select id from profiles where organization_id = current_organization_id()));
exception when duplicate_object then null; end $$;

-- 組織メンバーの CRUD（tasks / files / generated_drafts）
do $$ begin
  create policy tasks_member_all on tasks for all
    using (organization_id = current_organization_id())
    with check (organization_id = current_organization_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy files_member_all on files for all
    using (organization_id = current_organization_id())
    with check (organization_id = current_organization_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy generated_drafts_member_all on generated_drafts for all
    using (organization_id = current_organization_id())
    with check (organization_id = current_organization_id());
exception when duplicate_object then null; end $$;

-- ai_runs / audit_logs: メンバーは insert と select のみ。update/delete は不可
do $$ begin
  create policy ai_runs_insert on ai_runs for insert
    with check (organization_id = current_organization_id());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy ai_runs_select on ai_runs for select
    using (organization_id = current_organization_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy audit_logs_insert on audit_logs for insert
    with check (organization_id = current_organization_id());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy audit_logs_select on audit_logs for select
    using (organization_id = current_organization_id());
exception when duplicate_object then null; end $$;
