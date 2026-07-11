-- ============================================================
-- ALCO OS  0015: 共有ボード（スタッフ / 飲食店）+ 投稿一括更新
--
-- board_posts:      掲示板投稿。audience で スタッフ向け / 飲食店向け を分ける。
--                   タグは辞書ベースの自動付与 + 手動（domain/board）。
--                   飲食店向けは customer_levels.tier（初回/リピーター/太客）で配信先を絞る。
--                   在庫スナップショット（精肉DBリンク）を jsonb で添付できる。
-- customer_levels:  飲食店の信頼度設定。既存 customers はスキーマ変更せず、
--                   ALCO OS 側の別テーブルで customer_id に紐付ける（FKなし）。
-- social_projects:  一次データ（メモ/FB/動画/音声の文字起こし）→ 各チャンネル向け
--                   原稿（HP/Instagram/Facebook/YouTube）。AI生成 → 承認 → 投稿管理。
-- ============================================================

create table if not exists board_posts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  audience text not null default 'staff',       -- staff / customer
  title text,
  body text not null,
  tags text[] not null default '{}',            -- 自動 + 手動タグ
  target_roles text[] not null default '{}',    -- staff向け: staff.role の値。空 = 全員
  target_tiers text[] not null default '{}',    -- customer向け: new/repeat/vip。空 = 全店
  inventory_snapshot jsonb,                     -- 精肉在庫の添付（投稿時点のスナップショット）
  pinned boolean not null default false,
  status text not null default 'open',          -- open / archived
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists idx_board_posts_org on board_posts (organization_id, audience, status, created_at desc);
create index if not exists idx_board_posts_tags on board_posts using gin (tags);

drop trigger if exists trg_board_posts_updated_at on board_posts;
create trigger trg_board_posts_updated_at before update on board_posts
  for each row execute function set_updated_at();

select alco_add_member_policy('board_posts');

create table if not exists customer_levels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  customer_id uuid not null unique,             -- 既存 customers.id（FKなし）
  tier text not null default 'new',             -- new（初回）/ repeat（リピーター）/ vip（太客）
  note text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_customer_levels_updated_at on customer_levels;
create trigger trg_customer_levels_updated_at before update on customer_levels
  for each row execute function set_updated_at();

select alco_add_member_policy('customer_levels');

create table if not exists social_projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  title text not null,
  source_kind text not null default 'memo',     -- memo / facebook / video / audio
  source_text text not null,                    -- 一次データ（文字起こし含む）
  channels text[] not null default '{}',        -- hp / instagram / facebook / youtube
  approved_content jsonb,                       -- 承認済みの各チャンネル原稿
  posted_channels text[] not null default '{}', -- 投稿済みチャンネル
  status text not null default 'brief',         -- brief / approved / posted
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists idx_social_projects_org on social_projects (organization_id, created_at desc);

drop trigger if exists trg_social_projects_updated_at on social_projects;
create trigger trg_social_projects_updated_at before update on social_projects
  for each row execute function set_updated_at();

select alco_add_member_policy('social_projects');
