-- 20260802_individuals_stopkill_pickup.sql
-- 買取価格計算用: 「止めさし・引取」フラグ（チェックで買取から3,000円減額）を individuals に追加。
-- 既存の yield_rate（歩留まり率%）/ meat_rank（並・上・極上）/ buyback_amount（買取価格）と併用。
alter table individuals add column if not exists stopkill_pickup boolean not null default false;
