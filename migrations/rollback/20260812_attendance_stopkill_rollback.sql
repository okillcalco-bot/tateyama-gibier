-- 20260812_attendance_stopkill.sql の取り消し
alter table attendance drop constraint if exists attendance_stopkill_count_nonneg;
alter table attendance drop column if exists stopkill_count;
