-- ============================================================
-- ALCO OS  0004: Nature Capital（自然共生サイト / TNFD / 自然資本）モジュール
-- 現場観察 → 証跡付きレポート・提案書。AIは観察記録を創作してはならない
-- ============================================================

-- 対象地（里山・候補地・支援先サイト）
create table if not exists sites (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name text not null,
  site_type text,                          -- own_field / client_site / candidate
  address text,
  area_ha numeric,
  center_lat numeric,
  center_lng numeric,
  description text,
  oecm_status text,                        -- none / preparing / applied / certified（自然共生サイト）
  client_contact_id uuid,                  -- contacts(0005) 支援先企業
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- 調査地点
create table if not exists survey_points (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  site_id uuid not null references sites(id) on delete cascade,
  name text not null,                      -- 地点名（例: P-01 湿地北側）
  lat numeric,
  lng numeric,
  habitat_type text,                       -- 湿地 / 雑木林 / 竹林 / 水田 等
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 調査（1回の現地調査）
create table if not exists field_surveys (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  site_id uuid not null references sites(id) on delete cascade,
  survey_date date not null,
  surveyor text,                           -- 調査者名
  method text,                             -- 目視 / 捕獲 / カメラトラップ / 音声 等
  weather text,
  summary text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 生物観察記録（証跡の最小単位）
create table if not exists biodiversity_observations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  site_id uuid not null references sites(id) on delete cascade,
  survey_id uuid references field_surveys(id),
  survey_point_id uuid references survey_points(id),
  observed_at timestamptz not null,
  species_name text not null,              -- 和名
  species_scientific text,                 -- 学名
  taxon_group text,                        -- 鳥類 / 両生類 / 昆虫 / 植物 等
  count integer,
  red_list_status text,                    -- 環境省RL / 県RL カテゴリ
  observer text,
  lat numeric,
  lng numeric,
  note text,
  photo_file_id uuid references files(id), -- 証跡写真
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 管理作業履歴（下草刈り・間伐・水路整備など）
create table if not exists management_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  site_id uuid not null references sites(id) on delete cascade,
  action_date date not null,
  action_type text not null,               -- 草刈り / 間伐 / 竹林整備 / 水辺整備 / 外来種駆除 等
  description text,
  workers text,
  hours numeric,
  photo_file_id uuid references files(id),
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['sites','survey_points','field_surveys',
                           'biodiversity_observations','management_actions']
  loop
    perform alco_add_member_policy(t);
    execute format('drop trigger if exists trg_%s_updated_at on %s', t, t);
    execute format('create trigger trg_%s_updated_at before update on %s
                    for each row execute function set_updated_at()', t, t);
  end loop;
end $$;

create index if not exists idx_observations_site on biodiversity_observations (site_id, observed_at desc);
create index if not exists idx_actions_site on management_actions (site_id, action_date desc);

-- voice_memos から sites への参照を確定
do $$ begin
  alter table voice_memos
    add constraint fk_voice_memos_site foreign key (related_site_id) references sites(id);
exception when duplicate_object then null; end $$;
