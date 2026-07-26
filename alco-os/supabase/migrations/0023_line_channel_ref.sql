-- ============================================================
-- ALCO OS  0023: LINEチャネル識別子を「安定ラベル」に統一
--
-- 背景:
--   LINE Developers の画面で Bot User ID（destination。U で始まる値）を
--   見つけられないケースがある。ベーシックID（@889alcvb）しか分からなくても
--   運用できるようにする。
--
-- 方針:
--   - チャネルの特定は「登録済み全チャネルのシークレットで順に署名検証」で
--     行っており、destination は不要。
--   - DBに保存する識別子は destination の生値ではなく、
--     **安定ラベル 'channel:hunter' / 'channel:secretary'** にする。
--     これにより「後から環境変数にIDを入れたら既存リンクが引けなくなる」問題が
--     構造的に起きなくなる。
--   - destination は初回受信時に自動記録し、職員が画面で確認できるようにする
--     （設定作業の助けになる。ルーティングには使わない）。
-- ============================================================

-- ── チャネル台帳（destination の自動記録） ──
create table if not exists line_channel_registry (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  channel_key text not null,               -- secretary / hunter
  channel_ref text not null,               -- 保存に使う安定ラベル（channel:hunter）
  destination text,                        -- 初回受信で自動記録する Bot User ID
  basic_id text,                           -- @889alcvb など（任意・参考用）
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  event_count integer not null default 0,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint line_channel_registry_key_check
    check (channel_key in ('secretary', 'hunter'))
);

create unique index if not exists idx_line_channel_registry_key
  on line_channel_registry (organization_id, channel_key);

select alco_add_member_policy('line_channel_registry');

do $$
begin
  execute 'drop trigger if exists trg_line_channel_registry_updated_at on line_channel_registry';
  execute 'create trigger trg_line_channel_registry_updated_at before update on line_channel_registry
           for each row execute function set_updated_at()';
end $$;

-- ── 保存済みの識別子を安定ラベルへ移行 ──
-- 0021・0022 のテーブルに書き込むのは捕獲者チャネルの処理だけなので、
-- 'channel:' で始まらない値はすべて捕獲者チャネルのものとして読み替えてよい。
-- （0021・0022 が未適用の環境では対象行が無く、何も起きない）
update hunter_line_links
   set line_channel_id = 'channel:hunter'
 where line_channel_id is not null
   and line_channel_id not like 'channel:%';

update line_inbound_messages
   set line_channel_id = 'channel:hunter'
 where line_channel_id is not null
   and line_channel_id not like 'channel:%';

update capture_reports
   set line_channel_id = 'channel:hunter'
 where line_channel_id is not null
   and line_channel_id not like 'channel:%';

update line_conversation_states
   set line_channel_id = 'channel:hunter'
 where line_channel_id is not null
   and line_channel_id not like 'channel:%';

-- webhook台帳は channel_key を持つのでそれに合わせる
update line_webhook_events
   set line_channel_id = 'channel:' || channel_key
 where line_channel_id is not null
   and line_channel_id not like 'channel:%';

-- ── 列の意味をDB側にも残す（誤解防止） ──
comment on column hunter_line_links.line_channel_id is
  'チャネルの安定ラベル（channel:hunter など）。LINEの destination 生値は入れない（0023）';
comment on column line_inbound_messages.line_channel_id is
  'チャネルの安定ラベル（channel:hunter など）。LINEの destination 生値は入れない（0023）';
comment on column capture_reports.line_channel_id is
  'チャネルの安定ラベル（channel:hunter など）。LINEの destination 生値は入れない（0023）';
comment on column line_conversation_states.line_channel_id is
  'チャネルの安定ラベル（channel:hunter など）。LINEの destination 生値は入れない（0023）';
comment on column line_webhook_events.line_channel_id is
  'チャネルの安定ラベル（channel:hunter など）。LINEの destination 生値は入れない（0023）';
comment on table line_channel_registry is
  '受信したLINEチャネルの台帳。destination は初回受信時に自動記録し、画面で確認するためだけに使う（ルーティングには使わない）';
