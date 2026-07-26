-- ============================================================
-- ALCO OS  0027: 捕獲票のセルフダウンロード と 定型文フロー
--
-- フェーズ3の決定事項:
--   1. 捕獲報告の写真は「尻尾切除前 / 切除後」の2枚（全体写真は不要）
--   2. 往復を減らすため、定型文（型）を1回送れば必要項目が埋まるようにする
--   3. 捕獲票は捕獲者が自分でダウンロードする（共有リンク・30日有効）
--
-- 絶対ルール:
-- - 既存ジビエ基幹テーブルのスキーマは変更しない
-- - 既存マイグレーション（0021〜0026）は編集しない。追加のみ
-- - 共有リンクは推測できないトークンで、期限つき。無効化（再発行）できること
-- ============================================================

-- ── 捕獲票の共有リンク ──
alter table capture_reports
  add column if not exists share_token text,
  add column if not exists share_expires_at timestamptz;

-- トークンは全体で一意（他人の捕獲票に当たらないように）
create unique index if not exists idx_capture_reports_share_token
  on capture_reports (share_token)
  where share_token is not null;

comment on column capture_reports.share_token is
  '捕獲者が自分で捕獲票を開くための推測不可能なトークン。無効化は null にする（0027）';
comment on column capture_reports.share_expires_at is
  '共有リンクの期限（発行から30日）。過ぎたら開けない（0027）';

-- ── 捕獲場所（大字）を保持する列。定型文の「場所：」を受ける ──
-- ※ 下の get_capture_form_by_token() がこの列を参照するため、
--   **関数の定義より前に必ず追加する**（SQL関数は作成時に本体を検証するため、
--   順序が逆だと "column r.capture_place does not exist" で適用に失敗する）。
alter table capture_reports
  add column if not exists capture_place text;

comment on column capture_reports.capture_place is
  '捕獲場所の地名表現（大字など）。座標とは別に、捕獲票の「捕獲場所」欄へそのまま入れる（0027）';

-- ── 会話状態に「定型文の記入まち」を追加 ──
-- 0025 で張り替えた check 制約をさらに更新する（既存ファイルは編集しない）
alter table line_conversation_states
  drop constraint if exists line_conversation_states_state_check;

alter table line_conversation_states
  add constraint line_conversation_states_state_check
  check (state in (
    'idle',
    'awaiting_capture_photo',
    'awaiting_capture_detail',
    'awaiting_capture_form',
    'awaiting_weight_kind',
    'awaiting_weight_value'
  ));

-- ── 匿名（トークン所持者）が捕獲票を1件だけ読むための関数 ──
-- RLSを迂回するが、**トークンが一致し期限内の1行だけ**を、
-- 捕獲票に必要な列だけ返す。口座・LINEユーザーID等は返さない。
create or replace function public.get_capture_form_by_token(p_token text)
returns table (
  id uuid,
  species text,
  capture_method text,
  capture_date date,
  capture_lat numeric,
  capture_lng numeric,
  weight_kg numeric,
  weight_measure text,
  sex text,
  is_juvenile boolean,
  body_length_cm numeric,
  trap_number text,
  bait_type text,
  trap_set_date date,
  finishing_method text,
  disposal_method text,
  capture_place text,
  hunter_name text,
  hunter_phone text
)
language sql
security definer
set search_path = public
as $$
  select
    r.id,
    r.species,
    r.capture_method,
    r.capture_date,
    r.capture_lat,
    r.capture_lng,
    r.weight_kg,
    r.weight_measure,
    r.sex,
    r.is_juvenile,
    r.body_length_cm,
    r.trap_number,
    r.bait_type,
    r.trap_set_date,
    r.finishing_method,
    r.disposal_method,
    r.capture_place,
    h.name  as hunter_name,
    h.phone as hunter_phone
  from capture_reports r
  left join hunters h on h.id = r.hunter_id
  where r.share_token = p_token
    and p_token is not null
    and length(p_token) >= 24
    and r.share_expires_at is not null
    and r.share_expires_at > now()
  limit 1;
$$;

comment on function public.get_capture_form_by_token(text) is
  '共有トークンで捕獲票1件を取得する。期限内のみ。捕獲票に必要な列だけを返し、口座やLINE識別子は返さない（0027）';

revoke all on function public.get_capture_form_by_token(text) from public;
grant execute on function public.get_capture_form_by_token(text) to anon, authenticated;
