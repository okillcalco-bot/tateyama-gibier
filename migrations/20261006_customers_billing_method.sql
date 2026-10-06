-- 顧客ごとの請求書の送り方（2026-10-06）
--   pdf   : 請求書をPDFで送る（メール等）
--   paper : 紙で郵送する → 月まとめ発行で宛名ラベル（KML-506）を印刷する対象
--   cash  : 請求なし（その場で現金） → 月まとめ発行では最初からチェックを外す
--   null  : 未設定（従来どおり）
-- 追加のみ。既存の行は null のまま。
alter table public.customers add column if not exists billing_method text
  constraint customers_billing_method_chk check (billing_method is null or billing_method in ('pdf','paper','cash'));
comment on column public.customers.billing_method is '請求書の送り方: pdf=PDFで送る / paper=紙で郵送（宛名ラベル対象） / cash=請求なし・直接現金 / null=未設定';
