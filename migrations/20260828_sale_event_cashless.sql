-- 出店の入金を「現金」と「キャッシュレス」に分けて持つ（追加のみ）
--
-- これまで sale_events には cash_total（実際の入金）しか無かった。
-- 実際の出店（2026-08-29/30 川島夜店市）では
--     8/29  現金 40,700 + PayPay 15,200 = 55,900
--     8/30  現金 42,600 + PayPay 14,700 = 57,300
-- のように必ず2本立てで、PayPayは後日入金される。
-- 1つの欄に合算して入れてしまうと
--   ・レジ締めの現金と突き合わせられない
--   ・PayPayの入金確認ができない
--   ・「キャッシュレス比率が伸びているか」という傾向が取れない
-- ので、欄を分ける。合計（実際の入金）は cash_total + cashless_total で出す。
--
-- cash_total の意味は変えない（現金）。これまで入っていた値は現金として扱える。

begin;

alter table sale_events add column if not exists cashless_total integer;

comment on column sale_events.cash_total     is '現金の入金額（円）';
comment on column sale_events.cashless_total is 'PayPay等キャッシュレスの入金額（円）';

commit;
