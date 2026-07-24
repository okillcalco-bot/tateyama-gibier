-- ============================================================
-- ALCO OS  0019: 里山OS（Satoyama OS）コア — 設計指示書 v2.0 の MVP
--
-- 既存の自然資本モジュール（0004: sites / survey_points / field_surveys /
-- biodiversity_observations / management_actions）を土台に**拡張**する。
-- 作り直さない（設計憲章: 新しく作るより既存を活かす）。
--
-- 中核原則の実装:
--   1. 証拠と推定の分離 … source_type（observed/ai_suggested/literature/expert）
--   2. 位置情報の最小公開 … taxa.sensitivity + mask_coordinate() でメッシュ丸め
--   3. 説明可能性     … confidence_score を要素分解して保存（confidence_factors）
--   4. AIは候補のみ    … ai_suggestion に保持し、確定値は人が入れる
-- ============================================================

-- ── 種マスタ（分類群・希少度） ──
create table if not exists taxa (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  common_name text not null,               -- 和名
  scientific_name text,                    -- 学名
  taxon_group text,                        -- 鳥類 / 両生類 / 哺乳類 / 昆虫 / 植物 / 菌類 等
  rank text default 'species',             -- species / genus / family
  red_list_status text,                    -- 環境省RL / 県RL
  sensitivity text not null default 'normal', -- normal / caution / sensitive（希少種・営巣地）
  external_ids jsonb,                      -- GBIF等の外部ID
  note text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists idx_taxa_org on taxa (organization_id, taxon_group, common_name);

-- ── 観察記録の拡張（既存列は変更しない・追加のみ） ──
alter table biodiversity_observations
  add column if not exists taxon_id uuid references taxa(id),
  add column if not exists source_type text not null default 'observed',
    -- observed（現場観察）/ ai_suggested / literature / expert / hearsay（聞き取り）
  add column if not exists evidence_type text,
    -- specimen（標本）/ stomach（胃内容物）/ photo / video / audio / track（痕跡）/ sighting / hearsay
  add column if not exists confidence_score integer,        -- 0〜100（参考値）
  add column if not exists confidence_grade text,           -- A〜E
  add column if not exists confidence_factors jsonb,        -- 分解した根拠（説明可能性）
  add column if not exists review_status text not null default 'pending',
    -- pending / approved / rejected / disputed
  add column if not exists reviewed_by uuid references profiles(id),
  add column if not exists reviewed_at timestamptz,
  add column if not exists review_note text,
  add column if not exists visibility_level text not null default 'members',
    -- public / members / restricted（機微。認定者のみ）
  add column if not exists ai_suggestion jsonb,             -- AI候補（確定値と分離して保持）
  add column if not exists sensitivity text;                -- 個別上書き（未設定なら taxa 準拠）

create index if not exists idx_observations_review
  on biodiversity_observations (organization_id, review_status, observed_at desc);

-- ── 証拠（根拠）。観察・相互作用に複数ぶら下がる ──
create table if not exists evidence (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  related_table text not null,             -- biodiversity_observations / ecological_interactions
  related_id uuid not null,
  evidence_type text not null,             -- specimen / stomach / photo / video / audio / track / literature / expert
  description text,
  citation text,                           -- 文献の出典
  file_id uuid references files(id),
  recorded_at timestamptz,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists idx_evidence_related on evidence (related_table, related_id);

-- ── 相互作用（Knowledge Graph エッジ） ──
-- 注: 既存CRMの interactions（顧客接点）と衝突するため ecological_ 接頭辞
create table if not exists ecological_interactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  subject_taxon_id uuid references taxa(id),   -- 主体（食べる側 等）
  object_taxon_id uuid references taxa(id),    -- 対象（食べられる側 等）
  object_label text,                            -- 分類群以外（農作物・環境要素・人間活動）
  edge_type text not null,
    -- CONSUMES / USES_HABITAT / COMPETES_WITH / POLLINATES / DISPERSES /
    -- DAMAGES / MANAGED_BY / CORRELATES_WITH / PREDICTED_TO
  site_id uuid references sites(id),
  season text,                                  -- spring / summer / autumn / winter / all
  life_stage text,
  strength text,                                -- weak / medium / strong
  source_type text not null default 'observed', -- observed / literature / expert / ai_suggested / model
  confidence_score integer,
  confidence_grade text,
  confidence_factors jsonb,
  evidence_count integer not null default 0,
  last_confirmed_at timestamptz,
  review_status text not null default 'pending',
  visibility_level text not null default 'members',
  note text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists idx_eco_interactions_subject on ecological_interactions (subject_taxon_id, edge_type);
create index if not exists idx_eco_interactions_object on ecological_interactions (object_taxon_id, edge_type);

-- ── 調査キャンペーン（有限タスク・100%達成可能） ──
create table if not exists survey_campaigns (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name text not null,
  purpose text,
  site_id uuid references sites(id),
  target_taxon_group text,
  season text,
  starts_on date,
  ends_on date,
  target_count integer not null default 0,      -- 達成条件（必要記録数）
  status text not null default 'draft',         -- draft / open / closed
  visibility_level text not null default 'members',
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ── 調査タスク（ギャップを埋める具体行動。AI提案は承認後に公開） ──
create table if not exists survey_tasks (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  campaign_id uuid references survey_campaigns(id) on delete cascade,
  site_id uuid references sites(id),
  title text not null,
  detail text,
  taxon_group text,
  season text,
  method text,
  priority integer not null default 50,         -- 0〜100（保全重要度×知識不足×実施可能性）
  restricted boolean not null default false,    -- 希少種など: 認定調査者のみに提示
  status text not null default 'open',          -- open / done / cancelled
  source_type text not null default 'manual',   -- manual / ai_suggested
  approved_by uuid references profiles(id),     -- AI提案は承認されるまで公開しない
  approved_at timestamptz,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists idx_survey_tasks_org on survey_tasks (organization_id, status, priority desc);

do $$
declare t text;
begin
  foreach t in array array['taxa','evidence','ecological_interactions','survey_campaigns','survey_tasks']
  loop
    perform alco_add_member_policy(t);
    execute format('drop trigger if exists trg_%s_updated_at on %s', t, t);
    execute format('create trigger trg_%s_updated_at before update on %s
                    for each row execute function set_updated_at()', t, t);
  end loop;
end $$;

-- ── 位置情報マスキング ──
-- 感度に応じて座標をメッシュ丸めする。公開用座標は原座標から都度生成し、
-- 公開テーブルへ複製しない（設計書 14章）。
create or replace function mask_coordinate(value numeric, precision_km numeric)
returns numeric
language sql
immutable
as $$
  -- 緯度1度 ≒ 111km。precision_km 単位のメッシュ中心へ丸める
  select case
    when value is null or precision_km is null or precision_km <= 0 then value
    else round(value / (precision_km / 111.0)) * (precision_km / 111.0)
  end;
$$;

-- 一般公開向けビュー（原座標列を含めない）。
-- sensitive は座標も地点も出さない。security_invoker で RLS を通す。
create or replace view v_public_observations
with (security_invoker = true) as
select
  o.id,
  o.organization_id,
  o.observed_at,
  o.species_name,
  o.taxon_group,
  o.count,
  o.evidence_type,
  o.confidence_grade,
  o.review_status,
  coalesce(o.sensitivity, t.sensitivity, 'normal') as sensitivity,
  case coalesce(o.sensitivity, t.sensitivity, 'normal')
    when 'sensitive' then null
    when 'caution' then mask_coordinate(o.lat, 5)
    else mask_coordinate(o.lat, 1)
  end as public_lat,
  case coalesce(o.sensitivity, t.sensitivity, 'normal')
    when 'sensitive' then null
    when 'caution' then mask_coordinate(o.lng, 5)
    else mask_coordinate(o.lng, 1)
  end as public_lng
from biodiversity_observations o
left join taxa t on t.id = o.taxon_id
where o.review_status = 'approved'
  and o.visibility_level = 'public'
  and coalesce(o.sensitivity, t.sensitivity, 'normal') <> 'sensitive';
