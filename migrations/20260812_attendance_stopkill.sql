-- 出退勤（attendance）に止めさし回数を追加
--
-- 背景: 止めさし回数はこれまで月末にLINE等の自己申告を手集計していた（給与計算の都度）。
-- 止めさしを行う人は限られているため、退勤時の「今日の報告」で任意入力できるようにし、
-- 月末の集計を楽にする。産廃処理は既存の work_types（作業内容チップ）に選択肢を追加するだけで
-- 足りるため、こちらはカラム追加不要。
--
-- ロールバック: migrations/rollback/20260812_attendance_stopkill_rollback.sql

alter table attendance
  add column if not exists stopkill_count integer null;

do $$ begin
  alter table attendance
    add constraint attendance_stopkill_count_nonneg check (stopkill_count is null or stopkill_count >= 0);
exception when duplicate_object then null; end $$;

comment on column attendance.stopkill_count is
  '退勤時に本人が任意入力する、その日に行った止めさしの回数。該当者のみ（限られたスタッフ）。未入力はNULL（0回とは区別する）。';
