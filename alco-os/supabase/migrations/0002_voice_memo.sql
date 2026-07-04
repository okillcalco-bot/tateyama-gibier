-- ============================================================
-- ALCO OS  0002: Voice Memo モジュール
-- 音声メモ・現場メモ → AI分類 → generated_drafts → 承認 → tasks等へ反映
-- ============================================================

create table if not exists voice_memos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  title text,
  raw_text text not null,                 -- 文字起こし・メモ原文（絶対に上書きしない）
  source_type text not null default 'text_memo',
    -- voice_transcript / text_memo / meeting_note / field_note
  detected_category text,
    -- task / meeting_minutes / grant_material / nature_record / gibier_operation
    -- / crm_follow_up / roka_project / idea / personal_reminder / unclear
  status text not null default 'new',     -- new / classified / processed / archived
  related_project_id uuid,                -- projects(0006) 適用後にFK追加
  related_contact_id uuid,                -- contacts(0005)
  related_site_id uuid,                   -- sites(0004)
  related_grant_id uuid,                  -- grant_projects(0003)
  recorded_at timestamptz,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists idx_voice_memos_org on voice_memos (organization_id, status, created_at desc);

drop trigger if exists trg_voice_memos_updated_at on voice_memos;
create trigger trg_voice_memos_updated_at before update on voice_memos
  for each row execute function set_updated_at();

select alco_add_member_policy('voice_memos');
