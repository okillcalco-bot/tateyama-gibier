-- ============================================================
-- ALCO OS  0030: 経費（レシート撮影 → AI読み取り → 人が承認 → 記録）
--
-- 目的: 税理士へ紙の領収書を渡す作業をなくす。
--   撮る → AIが日付・金額・店名を読む → 人が確認して登録 → 消せない保管庫へ
--
-- 電子帳簿保存法（スキャナ保存）を意識した作り:
--   - 検索要件: 日付・金額・取引先を**列として**持ち、検索できるようにする
--   - 訂正削除: 物理削除しない（deleted_at のみ）。変更は audit_logs に残る
--   - 画像は既存 Storage バケット alco-os（0010でdeleteポリシーを与えていない）
--   ※ 実際に紙の原本を廃棄してよいかは税理士の確認が必要（システムの保証ではない）
--
-- AI出力の扱い（絶対ルール）: ai_suggestion に候補として保存し、
--   確定値（expense_date / amount / vendor 等）は人が承認したものだけを入れる
-- ============================================================

create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),

  -- 検索要件（電帳法）: この3つは必ず埋める
  expense_date date not null,               -- 日付
  amount integer not null,                  -- 金額（税込）
  vendor text not null,                     -- 取引先（店名）

  category text,                            -- 消耗品費 / 旅費交通費 / 燃料費 / 会議費 等
  payment_method text,                      -- 現金 / クレジット / 口座振替 / その他
  tax_rate integer,                         -- 10 / 8 / 0
  tax_amount integer,                       -- 内消費税（分かる場合）
  invoice_number text,                      -- 適格請求書発行事業者の登録番号（T+13桁）
  note text,
  items jsonb,                              -- 明細（読み取れた場合）

  receipt_file_id uuid references files(id), -- レシート画像
  ai_suggestion jsonb,                       -- AIの読み取り結果（確定値と分離して保持）
  ai_draft_id uuid references generated_drafts(id),
  /** 人が値を直したか（AIの精度を見るため） */
  corrected boolean not null default false,

  status text not null default 'recorded',   -- recorded / exported（会計ソフトへ出力済み）
  exported_at timestamptz,

  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,                    -- 物理削除はしない（電帳法・履歴優先）

  constraint expenses_amount_check check (amount >= 0)
);

create index if not exists idx_expenses_date
  on expenses (organization_id, expense_date desc);
create index if not exists idx_expenses_vendor
  on expenses (organization_id, vendor);
create index if not exists idx_expenses_amount
  on expenses (organization_id, amount);

select alco_add_member_policy('expenses');

drop trigger if exists trg_expenses_updated_at on expenses;
create trigger trg_expenses_updated_at before update on expenses
  for each row execute function set_updated_at();

comment on table expenses is
  '経費（レシート）。日付・金額・取引先で検索できる（電帳法の検索要件）。物理削除しない（0030）';
comment on column expenses.ai_suggestion is
  'AIの読み取り結果。確定値ではない。人が承認した値だけが各列に入る（0030）';
