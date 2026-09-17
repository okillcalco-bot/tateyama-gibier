-- 出店: 委託販売（ニイチク直売会など）の売上報告 → 請求書（2026-09-17）
-- 主催者から後日届く売上報告（税抜売上・消費税8%・手数料）を出店に記録し、
-- 手数料を引いた額の請求書（documents, INV-YYYYMM-NNN）を出す。追加のみ。

-- 出店先マスタ: 委託販売かどうか・手数料率・請求先（宛名・住所）を覚える
alter table event_venues add column if not exists consignment boolean not null default false;
alter table event_venues add column if not exists commission_pct numeric;
alter table event_venues add column if not exists bill_to text;
alter table event_venues add column if not exists bill_to_address text;
comment on column event_venues.consignment is '委託販売（主催者が売って後日売上報告が届く）の出店先';
comment on column event_venues.commission_pct is '販売手数料率（%・税抜売上に対して）';
comment on column event_venues.bill_to is '請求書の宛名';

-- 出店: 売上報告の数字と、発行した請求書
alter table sale_events add column if not exists consign_sales_ex integer;
alter table sale_events add column if not exists consign_tax integer;
alter table sale_events add column if not exists consign_fee integer;
alter table sale_events add column if not exists consign_doc_id uuid;
comment on column sale_events.consign_sales_ex is '売上報告: 売上額（税抜）';
comment on column sale_events.consign_tax is '売上報告: 消費税（8%）';
comment on column sale_events.consign_fee is '売上報告: 手数料';
comment on column sale_events.consign_doc_id is '発行した請求書 documents.id';

-- ニイチク直売会: 委託販売。手数料率は 2026-08-29 分の報告（9,059 ÷ 82,352 = 11.0%）から
update event_venues set consignment = true, commission_pct = 11
 where name = 'ニイチク直売会' and deleted_at is null and consignment = false;

-- 2026-08-29 ニイチク直売会の売上報告（税抜 82,352 ／ 消費税 6,588 ／ 合計 88,940 ／ 手数料 9,059 → 請求 79,881）
update sale_events set consign_sales_ex = 82352, consign_tax = 6588, consign_fee = 9059
 where id = '4001faa4-1ed9-4d30-92d3-0eaacdb21dc6' and consign_sales_ex is null;
