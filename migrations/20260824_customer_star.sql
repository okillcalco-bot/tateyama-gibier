-- 顧客管理: 手動スター（VIP優先フラグ）列を追加（追加のみ・非破壊）。
-- 背景: 請求書数・発送回数の多い顧客へ優先的に案内メールを送るため、顧客管理で
--       「実績による自動スター」に加え、担当者が任意でスターを付け外しできるようにする。
-- 自動スター（発送1回以上 or 請求書1回以上）はクライアント側で実績から算出するため列は不要。
-- 本列は手動のVIP指定のみを保持する。既存の同期・RLSには影響しない。

alter table public.customers
  add column if not exists is_starred boolean not null default false;
