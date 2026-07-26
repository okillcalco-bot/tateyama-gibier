-- ============================================================
-- ALCO OS  0022: 捕獲報告（LINE経由）と会話状態
--
-- 改修指示書（沖代表・2026-07-25）対応:
--   リッチメニュー（2×3）の5キーワード
--   「捕獲報告 / 搬入連絡 / 受入状況 / 買取状況 / 使い方」+ 電話(tel:)
--   捕獲報告 → 写真・位置情報・本文を受け取り、職員が確認して個体化する。
--
-- 絶対ルール:
-- - AIは候補（ai_suggestion）を出すだけ。確定値ではない
-- - individuals への書き込みは「職員が /gibier/reports で承認したとき」のみ。
--   形式は既存の捕獲者フォーム（capture-form.html?hunter=）の仮登録と同じ
--   （label_id='仮-xxx' / serial_number=null / intake_status='搬入待ち'）
-- - 既存テーブルのスキーマは変更しない。individuals / hunters へは
--   FKなしの汎用参照で紐づける（0018・0021 と同じ流儀）
-- - 捕獲場所の座標は原座標を保存するが、画面表示・出力は必ず
--   domain/satoyama/geo-masking.ts を通す（docs/10。罠・捕獲地点は sensitive 相当）
--
-- org_settings（既存・キーバリュー。スキーマ変更なし）で使うキー:
--   gibier_accepting        '受入可' / '受入停止'
--   gibier_acceptance_note  捕獲者へ返す補足文（受付時間など）
-- ============================================================

-- ── 捕獲報告 ──
create table if not exists capture_reports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  hunter_line_link_id uuid references hunter_line_links(id),
  hunter_id uuid,                          -- 既存 hunters(id) への汎用参照（FKなし）
  line_channel_id text,
  line_user_id text,
  species text,                            -- AI候補または職員入力（確定は個体化のとき）
  capture_method text,                     -- くくり罠 / 箱罠 / 銃猟 など（既存の表記に合わせる）
  capture_date date,
  capture_lat numeric,                     -- 原座標。表示・出力は必ず geo-masking を通す
  capture_lng numeric,
  photo_file_id uuid references files(id), -- 写真は Storage(alco-os) + files 台帳
  raw_text text,                           -- 捕獲者が送ってきた本文
  ai_suggestion jsonb,                     -- AIの読み取り候補（確定値ではない）
  source_draft_id uuid references generated_drafts(id),
  status text not null default 'pending',  -- pending / accepted / rejected
  individual_id uuid,                      -- 承認時に作成した individuals への汎用参照（FKなし）
  reviewed_by uuid references profiles(id),
  reviewed_at timestamptz,
  note text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint capture_reports_status_check
    check (status in ('pending', 'accepted', 'rejected'))
);

create index if not exists idx_capture_reports_status
  on capture_reports (organization_id, status, created_at desc);

create index if not exists idx_capture_reports_hunter
  on capture_reports (hunter_id, created_at desc);

-- 1つの個体に複数の捕獲報告を紐づけない（二重個体化の防止）
create unique index if not exists idx_capture_reports_individual
  on capture_reports (individual_id) where individual_id is not null;

-- ── LINEの会話状態 ──
-- 「捕獲報告」を押したあと、写真や本文を報告の続きとして受け取るために使う。
-- 期限切れ（expires_at）を過ぎたら通常のメッセージとして扱う。
create table if not exists line_conversation_states (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  line_channel_id text not null,
  line_user_id text not null,
  state text not null default 'idle',      -- idle / awaiting_capture_photo / awaiting_capture_detail
  capture_report_id uuid references capture_reports(id),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint line_conversation_states_state_check
    check (state in ('idle', 'awaiting_capture_photo', 'awaiting_capture_detail'))
);

create unique index if not exists idx_line_conversation_states_user
  on line_conversation_states (line_channel_id, line_user_id);

-- ── RLS（標準ポリシー） ──
select alco_add_member_policy('capture_reports');
select alco_add_member_policy('line_conversation_states');

-- ── updated_at 自動更新トリガー ──
do $$
declare t text;
begin
  foreach t in array array['capture_reports','line_conversation_states']
  loop
    execute format('drop trigger if exists trg_%s_updated_at on %s', t, t);
    execute format('create trigger trg_%s_updated_at before update on %s
                    for each row execute function set_updated_at()', t, t);
  end loop;
end $$;
