-- 20260815_hunters_furigana.sql
-- 目的: 捕獲者台帳(hunters)にふりがな列を追加。高齢の捕獲者でもかな入力で予測変換
--   （かとう→加藤茂）ができるよう、捕獲票入力の氏名予測にふりがなを使う。
-- 方針: 追加のみ・冪等。ふりがなの値は別途データ投入（暫定値・現場で確認・修正可）。

alter table public.hunters add column if not exists furigana text;
