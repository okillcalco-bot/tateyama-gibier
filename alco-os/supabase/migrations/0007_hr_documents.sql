-- ============================================================
-- ALCO OS  0007: HR（SOP・チェックリスト）+ Documents（社内Wiki）
--
-- 注意: シフト・勤怠は既存ジビエ基幹の staff / attendance テーブルが
-- 本番稼働中のため、ここでは新設しない（docs/09-gibier-integration.md 参照）。
-- ALCO OS 側では SOP・チェックリスト・ナレッジを担う。
-- ============================================================

-- 作業標準書（SOP）
create table if not exists sops (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  title text not null,                      -- 例: 解体作業手順 / 清掃手順 / 衛生管理
  category text,                            -- gibier / hygiene / roka / nature / office
  body text not null,                       -- Markdown
  version integer not null default 1,
  is_active boolean not null default true,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- チェックリスト定義
create table if not exists checklists (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  title text not null,                      -- 例: 解体室 作業前チェック
  category text,
  frequency text,                           -- daily / weekly / per_task
  items jsonb not null default '[]'::jsonb, -- [{ "key": "...", "label": "...", "required": true }]
  sop_id uuid references sops(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- チェックリスト実施記録
create table if not exists checklist_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  checklist_id uuid not null references checklists(id),
  run_date date not null,
  performed_by text,                        -- スタッフ名（既存staffと将来連携）
  results jsonb not null default '{}'::jsonb, -- { "key": { "checked": true, "note": "" } }
  note text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);

-- 社内Wiki / ナレッジ（判断基準・行政対応・過去資料・AI参照資料）
-- ※ テーブル名は knowledge_docs。既存ジビエ基幹に documents テーブル
--   （帳票用）が存在するため衝突を避けている。
create table if not exists knowledge_docs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  title text not null,
  doc_type text not null default 'note',    -- note / policy / template / reference / faq
  module text,                              -- 関連モジュール
  body text not null,                       -- Markdown
  tags text[],
  related_table text,
  related_id uuid,
  is_ai_reference boolean not null default false, -- AIワークフローの参照資料として使う
  created_by uuid references profiles(id),
  updated_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists idx_knowledge_docs_tags on knowledge_docs using gin (tags);

do $$
declare t text;
begin
  foreach t in array array['sops','checklists','checklist_runs','knowledge_docs']
  loop
    perform alco_add_member_policy(t);
  end loop;
  foreach t in array array['sops','checklists','knowledge_docs']
  loop
    execute format('drop trigger if exists trg_%s_updated_at on %s', t, t);
    execute format('create trigger trg_%s_updated_at before update on %s
                    for each row execute function set_updated_at()', t, t);
  end loop;
end $$;
