-- 捕獲者台帳に郵便番号（追加のみ）2026-09-17
--
--   買取金額通知（buyback.html）の宛名ラベル印刷（コメリ KML-506 24面）で使う。
--   住所（address）は既存列。郵便番号は無くても国内郵便は届くが、あれば印字する。
--   既存アプリへの影響: なし（NULL 許容・既存行はそのまま）

alter table hunters add column if not exists postal_code text;   -- 例: 294-0025（ハイフン有無どちらでも可）

comment on column hunters.postal_code is '郵便番号（宛名ラベル用・任意）';
