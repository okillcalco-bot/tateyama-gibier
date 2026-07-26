-- ============================================================
-- ALCO OS  0024: 職員チャット返信 と 捕獲報告の写真種別
--
-- 要望1: 職員が ALCO OS から捕獲者へテキスト返信できるようにする
--        （複数職員前提。送信者・送信時刻を残し、スレッドで読める）
-- 要望3: 市役所提出資料のために、写真に種別（全体 / 尻尾切除前 / 切除後）を持たせる
--
-- 絶対ルール:
-- - 既存ジビエ基幹テーブルのスキーマは変更しない
-- - 既存マイグレーション（0021〜0023）は編集しない。追加のみ
-- - 写真の実体は Storage(alco-os) + files 台帳。ここでは種別と並び順だけを持つ
-- ============================================================

-- ── 職員から捕獲者への送信（Push API） ──
-- webhook の replyToken は失効しているため、返信はすべてプッシュ送信になる。
-- 送信の成否も残す（届かなかったことが後から分かるように）。
create table if not exists line_outbound_messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  hunter_line_link_id uuid references hunter_line_links(id),
  line_channel_id text not null,
  line_user_id text not null,
  body text not null,
  /** どの受信メッセージへの返信か（雑談・お知らせなら null） */
  in_reply_to_id uuid references line_inbound_messages(id),
  status text not null default 'sent',      -- sent / failed
  error text,
  sent_at timestamptz not null default now(),
  sent_by uuid references profiles(id),     -- 送信した職員（複数職員前提）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint line_outbound_messages_status_check
    check (status in ('sent', 'failed'))
);

create index if not exists idx_line_outbound_messages_link
  on line_outbound_messages (hunter_line_link_id, sent_at desc);

create index if not exists idx_line_outbound_messages_reply
  on line_outbound_messages (in_reply_to_id);

create index if not exists idx_line_outbound_messages_recent
  on line_outbound_messages (organization_id, sent_at desc);

-- ── 捕獲報告の写真（種別つき・複数枚） ──
-- 市役所提出の台紙に「全体 / 尻尾を切る前 / 切った後」を並べるため、
-- 1報告に複数の写真を種別つきで持たせる。
-- 0022 の capture_reports.photo_file_id は「代表写真」として残す（後方互換）。
create table if not exists capture_report_photos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  capture_report_id uuid not null references capture_reports(id),
  file_id uuid not null references files(id),
  photo_kind text not null default 'unsorted',  -- unsorted / whole / tail_before / tail_after / other
  sort_order integer not null default 0,
  note text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint capture_report_photos_kind_check
    check (photo_kind in ('unsorted', 'whole', 'tail_before', 'tail_after', 'other'))
);

-- 同じ写真を1つの報告に二重登録しない
create unique index if not exists idx_capture_report_photos_unique
  on capture_report_photos (capture_report_id, file_id);

create index if not exists idx_capture_report_photos_report
  on capture_report_photos (capture_report_id, sort_order);

-- ── RLS（標準ポリシー） ──
select alco_add_member_policy('line_outbound_messages');
select alco_add_member_policy('capture_report_photos');

-- ── updated_at 自動更新トリガー ──
do $$
declare t text;
begin
  foreach t in array array['line_outbound_messages','capture_report_photos']
  loop
    execute format('drop trigger if exists trg_%s_updated_at on %s', t, t);
    execute format('create trigger trg_%s_updated_at before update on %s
                    for each row execute function set_updated_at()', t, t);
  end loop;
end $$;

comment on table line_outbound_messages is
  '職員から捕獲者へのLINE送信履歴。送信者(sent_by)と送信時刻を必ず残す（0024）';
comment on table capture_report_photos is
  '捕獲報告の写真と種別。市役所提出台紙で 全体/尻尾切除前/切除後 を並べるために使う（0024）';
