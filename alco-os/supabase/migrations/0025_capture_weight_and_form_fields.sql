-- ============================================================
-- ALCO OS  0025: 体重（3パターン）と捕獲票の職員入力項目
--
-- 要望1: 体重は「ジビエセンターで計測 / 処理施設で計測 / 推定」の3区分。
--        値と区分の両方を持ち、推定の場合は提出書類に明記する。
-- 要望2: 市役所提出をPDFにしてメールで送れるようにする。
--        捕獲票の様式に必要だがLINEでは集まらない項目を職員が入力できるようにする。
--
-- 絶対ルール:
-- - 既存ジビエ基幹テーブル（individuals 等）のスキーマは変更しない。
--   体重は既存 individuals.weight_total に、区分は individuals.memo の
--   文言として渡す（既存 cityFormPrint が memo を「その他特記事項」に印字するため、
--   推定であることが既存の捕獲票にもそのまま出る）
-- - 既存マイグレーション（0021〜0024）は編集しない。追加のみ
-- ============================================================

-- ── 体重（値 + 計測区分） ──
alter table capture_reports
  add column if not exists weight_kg numeric,
  -- center = ジビエセンターで計測 / facility = 処理施設で計測 / estimated = 推定
  add column if not exists weight_measure text;

do $$ begin
  alter table capture_reports
    add constraint capture_reports_weight_measure_check
    check (weight_measure is null or weight_measure in ('center', 'facility', 'estimated'));
exception when duplicate_object then null; end $$;

-- ── 捕獲票の様式に必要な項目（まずは職員が /gibier/reports で入力する） ──
-- 既存 individuals の同名カラムへ承認時に転記する。列を増やすのは ALCO OS 側だけ。
alter table capture_reports
  add column if not exists sex text,                 -- オス / メス
  add column if not exists is_juvenile boolean,      -- 幼獣か
  add column if not exists body_length_cm numeric,
  add column if not exists trap_number text,         -- 箱わな番号（市貸与）
  add column if not exists bait_type text,           -- 餌の種類（箱わなのみ）
  add column if not exists trap_set_date date,       -- わな設置日
  add column if not exists finishing_method text,    -- 止め刺し方法（銃 / 刺殺 など）
  add column if not exists disposal_method text;     -- 処理方法（販売（館山ジビエセンター）等）

-- ── 会話状態に体重の聞き取りを追加 ──
-- 0022 の check 制約を張り替える（既存ファイルは編集しない）
alter table line_conversation_states
  drop constraint if exists line_conversation_states_state_check;

alter table line_conversation_states
  add constraint line_conversation_states_state_check
  check (state in (
    'idle',
    'awaiting_capture_photo',
    'awaiting_capture_detail',
    'awaiting_weight_kind',
    'awaiting_weight_value'
  ));

comment on column capture_reports.weight_measure is
  'center=ジビエセンターで計測 / facility=処理施設で計測 / estimated=推定。推定は提出書類に明記する（0025）';
