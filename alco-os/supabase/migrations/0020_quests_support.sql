-- ============================================================
-- ALCO OS  0020: 調査クエスト + 応援（支援）モデル
--
-- 目的: 外部の応援が増えるほど、不足している調査が進み、
--       それが地域の仕事（調査謝金）になる循環をつくる。
--
--   応援 → 資金 → クエスト実施（地域の調査員へ謝金）→ 成果報告 → 応援
--
-- 絶対ルール（里山OS 設計書 10章）:
-- - 希少種を含むクエスト（restricted）は公開・募集・課金の対象にしない
-- - 位置の暴露や乱獲につながる報酬は作らない（投稿数の競争を煽らない）
-- - 個人ランキングは前面に出さず、共同達成と地域レベルを主にする
-- ============================================================

-- ── 調査クエスト（既存 survey_tasks を拡張。作り直さない） ──
alter table survey_tasks
  add column if not exists target_count integer not null default 1,   -- 有限: 何件で達成か
  add column if not exists progress_count integer not null default 0, -- 達成済み件数
  add column if not exists funding_goal_yen integer not null default 0, -- 必要資金（謝金・交通費等）
  add column if not exists funded_yen integer not null default 0,       -- 入金確認済みの応援合計
  add column if not exists paid_out_yen integer not null default 0,     -- 調査員へ支払った合計
  add column if not exists reward_title text,                            -- 達成で得られる称号
  add column if not exists public_slug text,                             -- 公開URL（応援ページ）
  add column if not exists published_at timestamptz,                     -- 公開日時（未公開はnull）
  add column if not exists story text,                                   -- 応援者向けの説明
  add column if not exists completed_at timestamptz;

create unique index if not exists idx_survey_tasks_slug on survey_tasks (public_slug)
  where public_slug is not null;

-- ── 応援者（外部の個人・企業） ──
create table if not exists supporters (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  display_name text not null,            -- 公開表示名（匿名希望は「匿名の応援者」）
  real_name text,                        -- 内部管理用
  email text,
  is_public boolean not null default true, -- 名前を公開してよいか
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ── 応援（支援表明 → 入金確認） ──
-- 決済プロバイダ接続（Stripe等）は段階2。現状は振込・現地払いを人が確認する。
create table if not exists support_pledges (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  task_id uuid references survey_tasks(id) on delete set null, -- 応援先クエスト（null=里山全体）
  supporter_id uuid references supporters(id),
  amount_yen integer not null,
  method text not null default 'transfer',  -- transfer（振込）/ cash（現地）/ stripe（段階2）
  status text not null default 'pledged',   -- pledged（表明）/ confirmed（入金確認）/ cancelled / refunded
  message text,                              -- 応援メッセージ（公開される場合あり）
  message_public boolean not null default true,
  confirmed_by uuid references profiles(id),
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_pledges_task on support_pledges (task_id, status);

-- ── 調査への支払い（地域の仕事化の実体） ──
create table if not exists quest_payouts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  task_id uuid not null references survey_tasks(id) on delete cascade,
  payee_name text not null,              -- 調査員・協力者
  staff_id uuid,                          -- 既存 staff.id（任意・FKなし）
  amount_yen integer not null,
  paid_on date not null,
  purpose text,                           -- 謝金 / 交通費 / 機材 等
  note text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_payouts_task on quest_payouts (task_id, paid_on desc);

-- ── 称号の付与記録（定義はコード側 achievements.ts。乱獲を煽らない設計） ──
create table if not exists achievement_grants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  achievement_key text not null,          -- achievements.ts のキー
  profile_id uuid references profiles(id),
  supporter_id uuid references supporters(id),
  granted_for text,                       -- 根拠（クエスト名など）
  granted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_grants_org on achievement_grants (organization_id, achievement_key);

do $$
declare t text;
begin
  foreach t in array array['supporters','support_pledges','quest_payouts','achievement_grants']
  loop
    perform alco_add_member_policy(t);
    execute format('drop trigger if exists trg_%s_updated_at on %s', t, t);
    execute format('create trigger trg_%s_updated_at before update on %s
                    for each row execute function set_updated_at()', t, t);
  end loop;
end $$;

-- ── 公開クエスト一覧（応援ページ用。restricted は絶対に含めない） ──
create or replace view v_public_quests
with (security_invoker = true) as
select
  t.id,
  t.organization_id,
  t.public_slug,
  t.title,
  t.story,
  t.taxon_group,
  t.season,
  t.target_count,
  t.progress_count,
  t.funding_goal_yen,
  t.funded_yen,
  t.paid_out_yen,
  t.reward_title,
  t.status,
  t.published_at,
  t.completed_at
from survey_tasks t
where t.published_at is not null
  and t.restricted = false            -- 希少種クエストは公開しない
  and t.deleted_at is null;
