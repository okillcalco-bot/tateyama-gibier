-- ============================================================
-- ALCO OS  0012: Media（プレゼン資料 / YouTube動画）モジュール
--
-- ブリーフ（ターゲット・時間・フォーマット・伝えたいこと・元資料・写真）
-- を入力 → AIが構成/台本を生成 → 承認 → 成果物化。
--   presentation:  承認後 PPTX ダウンロード
--   youtube_video: 承認後 台本+メタデータ確定 → （段階2）レンダリング → アップロード
-- ============================================================

create table if not exists media_projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  kind text not null,                       -- presentation / youtube_video
  title text not null,                      -- 案件名（例: ◯◯商工会 講演）
  target_audience text,                     -- ターゲット・聴講者
  duration_minutes integer,                 -- 講演時間 / 動画尺（分）
  format text,                              -- 講演 / セミナー / 営業提案 / 行政説明 / Vlog / 解説動画 等
  key_messages text,                        -- 聴講者に思ってもらいたいこと・気づき
  source_material text,                     -- まとめたい資料（貼り付けテキスト）
  status text not null default 'brief',
    -- brief（入力済）/ approved（構成承認済）
    -- youtube_video の段階2: rendering / uploaded / published
  approved_content jsonb,                   -- 承認済みの構成/台本（draft-service が書き込む）
  youtube_video_id text,                    -- アップロード後のYouTube動画ID（段階2）
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists idx_media_projects_org on media_projects (organization_id, kind, created_at desc);

drop trigger if exists trg_media_projects_updated_at on media_projects;
create trigger trg_media_projects_updated_at before update on media_projects
  for each row execute function set_updated_at();

select alco_add_member_policy('media_projects');

-- 写真・動画素材は files（0001）を related_table='media_projects' で紐付けて使う
