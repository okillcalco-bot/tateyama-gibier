-- ============================================================
-- ALCO OS  0021: 捕獲者向けLINE公式アカウントの統合
--
-- 目的: 館山ジビエセンターの捕獲者向けLINE公式アカウント（既存・開設済み）を
--       ALCO OS に取り込み、搬入連絡・現場引取の相談・受入方法の問い合わせを
--       職員が1か所で確認し、承認のうえ返信できるようにする。
--
-- 絶対ルール:
-- - 既存ジビエ基幹テーブル（hunters / individuals / orders / order_items /
--   products / attendance / staff 等）はスキーマ変更しない。
--   hunters へは「FKなしの汎用参照」で紐づける（0018 sales_slips.product_id と同じ流儀）
-- - AIは正式データを直接変更しない。generated_drafts → 人間承認 →
--   draft-service.approveDraft() のみが反映経路
-- - 位置情報（捕獲場所・罠位置）は sensitive 相当（docs/10）。
--   このマイグレーションのテーブルには原座標を保存しない（has_location フラグのみ）
-- ============================================================

-- ── 捕獲者とLINEユーザーの紐付け ──
-- 1人の捕獲者が複数のLINEアカウントを持つことを許容する（1捕獲者 : N リンク）。
-- 同一チャネル内での line_user_id は一意。
-- hunter_id は職員が画面で確認して初めて入る（AI・自動処理では埋めない）。
create table if not exists hunter_line_links (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  hunter_id uuid,                          -- 既存 hunters(id) への汎用参照（FKなし）。未照合は null
  line_channel_id text not null,           -- チャネル識別子（LINE webhook の destination）
  line_user_id text not null,              -- LINEユーザーID（チャネル単位で一意）
  line_display_name text,                  -- 表示名のスナップショット（任意）
  status text not null default 'pending',  -- pending / verified / blocked
  verified_at timestamptz,
  verified_by uuid references profiles(id),
  note text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hunter_line_links_status_check
    check (status in ('pending', 'verified', 'blocked'))
);

-- 同一チャネル内で line_user_id は一意（重複リンクを作らせない）
create unique index if not exists idx_hunter_line_links_channel_user
  on hunter_line_links (line_channel_id, line_user_id);

create index if not exists idx_hunter_line_links_hunter
  on hunter_line_links (hunter_id);

create index if not exists idx_hunter_line_links_status
  on hunter_line_links (organization_id, status, created_at desc);

-- ── Webhookイベントの冪等性台帳 ──
-- LINEは200が返らない場合に同一イベントを再送する。
-- webhook_event_id の unique 制約で二重処理（メモ二重作成・AI二重課金）を防ぐ。
-- 生ペイロードは保存しない（種別と処理結果のみ）。
create table if not exists line_webhook_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  webhook_event_id text not null,          -- LINE の event.webhookEventId
  line_channel_id text not null,
  channel_key text not null,               -- secretary / hunter
  event_type text not null,                -- message / follow / unfollow / postback / ...
  message_type text,                       -- text / image / location / ...
  line_user_id text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  process_status text not null default 'received',  -- received / processed / skipped / failed
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint line_webhook_events_status_check
    check (process_status in ('received', 'processed', 'skipped', 'failed'))
);

create unique index if not exists idx_line_webhook_events_event_id
  on line_webhook_events (webhook_event_id);

create index if not exists idx_line_webhook_events_recent
  on line_webhook_events (organization_id, received_at desc);

-- ── 捕獲者からの受信メッセージ ──
-- 職員が /line 画面で確認・返信する対象。
-- AI分類の結果は generated_drafts 側に入り、承認するまでタスクにならない。
-- 位置情報は has_location フラグのみ保持し、原座標は保存しない（docs/10）。
create table if not exists line_inbound_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  hunter_line_link_id uuid references hunter_line_links(id),
  line_channel_id text not null,
  line_user_id text not null,
  webhook_event_id text,
  message_type text not null default 'text',
  body text,                                    -- テキスト本文（原座標は入れない）
  has_location boolean not null default false,  -- 位置情報を伴うか（座標そのものは保持しない）
  detected_intent text,                         -- delivery_notice / pickup_consult / acceptance_info / other
  status text not null default 'new',           -- new / classified / handled / ignored
  replied_at timestamptz,
  replied_by uuid references profiles(id),
  received_at timestamptz not null default now(),
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint line_inbound_messages_status_check
    check (status in ('new', 'classified', 'handled', 'ignored'))
);

create index if not exists idx_line_inbound_messages_status
  on line_inbound_messages (organization_id, status, received_at desc);

create index if not exists idx_line_inbound_messages_link
  on line_inbound_messages (hunter_line_link_id, received_at desc);

-- ── RLS（標準ポリシー: 自組織の行のみCRUD可） ──
select alco_add_member_policy('hunter_line_links');
select alco_add_member_policy('line_webhook_events');
select alco_add_member_policy('line_inbound_messages');

-- ── updated_at 自動更新トリガー ──
do $$
declare t text;
begin
  foreach t in array array['hunter_line_links','line_webhook_events','line_inbound_messages']
  loop
    execute format('drop trigger if exists trg_%s_updated_at on %s', t, t);
    execute format('create trigger trg_%s_updated_at before update on %s
                    for each row execute function set_updated_at()', t, t);
  end loop;
end $$;
