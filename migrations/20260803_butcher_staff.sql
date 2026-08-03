-- 解体担当者（受入・解体情報）。複数人の場合はカンマ区切りで保持
-- 適用済み: 2026-08-03（Supabase migration: individuals_butcher_staff）
alter table individuals add column if not exists butcher_staff text;
