-- 請求書を紙で送る先（郵送先）が登録住所と違う顧客のための欄（2026-11-05 沖）
--   例: 町の加工施設の請求書は、施設ではなく町役場の担当課（「○○町役場　産業振興課　御中」）へ郵送する
-- 受発注管理の顧客編集「請求書の郵送先」と、顧客管理の「🏷 宛名ラベル」（コメリ KML-506・A4 24面）で使う。
-- 空なら登録住所（address・building）と顧客名・敬称でラベルを作る（今までどおり）。
-- 追加のみ・2回流しても壊れない。customers の権限（スタッフキー）はそのまま。
alter table public.customers add column if not exists mail_name text;       -- 郵送先の宛名（空なら顧客名）
alter table public.customers add column if not exists mail_honorific text;  -- 郵送先の敬称（空なら「御中」）
alter table public.customers add column if not exists mail_address text;    -- 郵送先の住所（〒を含めてよい。空なら登録住所）
comment on column public.customers.mail_name is '請求書の郵送先の宛名（登録住所と違う先に紙で送るとき）';
comment on column public.customers.mail_honorific is '請求書の郵送先の敬称（空なら御中）';
comment on column public.customers.mail_address is '請求書の郵送先の住所（〒込み可。空なら address・building）';
