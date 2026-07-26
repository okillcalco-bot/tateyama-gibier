-- ============================================================
-- ALCO OS  0028: 搬入連絡をスタッフのLINEグループへ通知
--
-- 目的: 捕獲者からの「搬入連絡」をスタッフ全員がすぐ見られるようにする。
--       捕獲者向けLINE公式アカウント（@889alcvb）をスタッフ用グループに招待し、
--       そのグループへ Push で通知する。
--
-- 守秘義務（docs/06・§8-2）:
-- - グループへ流すのは**最小限**（誰から・いつ・本日の受入可否まで）。
--   **買取額・口座・捕獲場所の座標・写真は流さない**
-- - グループからのメッセージは業務処理しない（誤爆防止）。
--   登録・解除のコマンドだけに反応する
--
-- 絶対ルール:
-- - 既存ジビエ基幹テーブルのスキーマは変更しない
-- - 既存マイグレーション（0021〜0027）は編集しない。追加のみ
-- - SQLは「参照より定義が先」の順に書く（0027の失敗を繰り返さない）
-- ============================================================

create table if not exists line_staff_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  /** チャネルの安定ラベル（channel:hunter など。0023の流儀） */
  line_channel_id text not null,
  /** LINEのグループID。招待されたときに自動で記録する */
  line_group_id text not null,
  /** 職員が分かる名前（画面で編集） */
  label text,
  /** 搬入連絡をこのグループへ通知するか */
  notify_delivery boolean not null default false,
  /** pending=招待されたが未登録 / active=通知する / disabled=止めている / left=退出済み */
  status text not null default 'pending',
  joined_at timestamptz,
  registered_at timestamptz,
  registered_by uuid references profiles(id),
  last_notified_at timestamptz,
  notify_count integer not null default 0,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint line_staff_groups_status_check
    check (status in ('pending', 'active', 'disabled', 'left'))
);

-- 同じグループを二重登録しない
create unique index if not exists idx_line_staff_groups_group
  on line_staff_groups (line_group_id);

create index if not exists idx_line_staff_groups_active
  on line_staff_groups (organization_id, status, updated_at desc);

select alco_add_member_policy('line_staff_groups');

do $$
begin
  execute 'drop trigger if exists trg_line_staff_groups_updated_at on line_staff_groups';
  execute 'create trigger trg_line_staff_groups_updated_at before update on line_staff_groups
           for each row execute function set_updated_at()';
end $$;

comment on table line_staff_groups is
  '搬入連絡を通知するスタッフのLINEグループ。通知内容は最小限（買取額・口座・座標は流さない）。0028';
comment on column line_staff_groups.notify_delivery is
  '搬入連絡をこのグループへ通知するか。職員画面 /line から切り替える（0028）';
