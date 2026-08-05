-- 打刻画面から報告する「今日の作業内容」（複数可・カンマ区切り）
-- 適用済み: 2026-08-03（Supabase migration: attendance_work_types）
alter table attendance add column if not exists work_types text;
