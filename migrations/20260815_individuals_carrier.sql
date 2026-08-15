-- 20260815_individuals_carrier.sql
-- 目的: 搬入者（捕獲者と別に個体を持ち込んだ人）を記録する列を追加。
--   捕獲票入力で捕獲者の下に「搬入者」欄（ふりがな予測つき）を設ける。
-- 方針: 追加のみ・冪等。空欄なら「捕獲者と同じ」扱い。

alter table public.individuals add column if not exists carrier_name text;
