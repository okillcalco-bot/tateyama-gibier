-- ============================================================
-- ALCO OS  0003: Grants（補助金・行政文書）モジュール
-- 申請書・実績報告はAIがドラフト生成し、人間レビュー後にのみ確定する
-- ============================================================

-- 補助金の公募情報（機会）
create table if not exists grant_opportunities (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name text not null,                      -- 補助金名
  agency text,                             -- 実施機関（省庁・県・市 等）
  url text,
  summary text,
  max_amount numeric,                      -- 上限額
  subsidy_rate text,                       -- 補助率（例: 2/3）
  application_start date,
  application_deadline date,
  raw_requirements text,                   -- 公募要領の原文（改変禁止）
  status text not null default 'watching', -- watching / preparing / applied / closed
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- 申請案件（社内プロジェクトとしての補助金案件）
create table if not exists grant_projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  opportunity_id uuid references grant_opportunities(id),
  name text not null,
  target_business text,                    -- 対象事業（ジビエ / ROKA / 自然共生 等）
  status text not null default 'draft',
    -- draft / preparing / submitted / adopted / rejected / reporting / completed
  requested_amount numeric,
  adopted_amount numeric,
  submitted_at date,
  decided_at date,
  note text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- 要件の構造化（公募要領を分解したチェックリスト）
create table if not exists grant_requirements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  grant_project_id uuid not null references grant_projects(id) on delete cascade,
  requirement_text text not null,          -- 要件原文（改変禁止）
  category text,                           -- 資格 / 書類 / 経費 / 期限 / 採点観点
  is_met boolean,                          -- null = 未確認
  evidence_note text,                      -- 充足根拠のメモ
  evidence_file_id uuid references files(id),
  sort_order integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 申請書・報告書などの文書（本文はドラフト承認後にここへ確定保存）
create table if not exists grant_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  grant_project_id uuid not null references grant_projects(id) on delete cascade,
  doc_type text not null,                  -- application / business_plan / budget / report / attachment_list
  title text not null,
  body text,                               -- 確定本文（承認済みドラフトから反映）
  source_draft_id uuid references generated_drafts(id),
  version integer not null default 1,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 経費計画
create table if not exists grant_budget_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  grant_project_id uuid not null references grant_projects(id) on delete cascade,
  category text not null,                  -- 機械装置費 / 工事費 / 委託費 等
  item_name text not null,
  amount numeric not null default 0,
  subsidized_amount numeric,
  quote_file_id uuid references files(id), -- 見積書
  note text,
  sort_order integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['grant_opportunities','grant_projects','grant_requirements',
                           'grant_documents','grant_budget_items']
  loop
    perform alco_add_member_policy(t);
    execute format('drop trigger if exists trg_%s_updated_at on %s', t, t);
    execute format('create trigger trg_%s_updated_at before update on %s
                    for each row execute function set_updated_at()', t, t);
  end loop;
end $$;

create index if not exists idx_grant_projects_org on grant_projects (organization_id, status);
create index if not exists idx_grant_requirements_project on grant_requirements (grant_project_id, sort_order);
