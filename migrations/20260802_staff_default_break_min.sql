-- 20260802_staff_default_break_min.sql
-- 出退勤打刻: スタッフごとの休憩時間の初期値（分）。午後出勤で休憩なしの人は0など、各自で設定可能に。
-- null の場合は 60分 を既定として扱う（アプリ側フォールバック）。
alter table staff add column if not exists default_break_min integer;
