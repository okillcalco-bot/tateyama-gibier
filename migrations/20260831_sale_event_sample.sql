-- 出店・直売会の「試食に出した数」を持つ（追加のみ）
--
-- ニイチク直売会（2026-08-29）の実績を入れて分かったこと。
-- 持ち出し10のうち3を試食に出し、残りが0（売り切れ）なら、売れたのは7。
-- ところが sale_event_items には持ち出しと売れた数しか無いので、
-- 「10持って行って7売れた」＝「3が売れ残った」と読めてしまう。
--   ・完売したのに完売率が70%に見える
--   ・棚に戻ってくるはずの3個が帳簿上いつまでも残る
--   ・試食にどれだけ使ったかが誰にも分からない（原価にも販促の効果測定にも出てこない）
--
-- 実際の数（2026-08-29 ニイチク直売会）
--   ミニバーグ 持ち出し10 / 試食3 / 残り0 → 売れた7
--   つくね串   持ち出し10 / 試食2 / 残り1 → 売れた7
--   山さんが   持ち出し10 / 試食1 / 残り3 → 売れた6
--   この6個を試食として分けて初めて、売上報告 88,940円と明細がぴったり合った。
--
-- 残り = 持ち出し − 売れた − 試食 で出す。試食は売上にはしない（金額0のまま）。

begin;

alter table sale_event_items add column if not exists qty_sample numeric not null default 0;

comment on column sale_event_items.qty_taken  is '持ち出した数';
comment on column sale_event_items.qty_sold   is '売れた数（金額になる）';
comment on column sale_event_items.qty_sample is '試食に出した数（売上にはしない）';

-- 持ち出しを超えて「売れた＋試食」にはできない。
-- 既存の sale_event_items_qty_ck（qty_sold <= qty_taken）を、試食を含む条件に差し替える。
-- 条件は強くなるだけなので、いま入っているデータはそのまま通る。
alter table sale_event_items drop constraint if exists sale_event_items_qty_ck;
alter table sale_event_items add constraint sale_event_items_qty_ck
  check (qty_taken >= 0 and qty_sold >= 0 and qty_sample >= 0
         and qty_sold + qty_sample <= qty_taken);

commit;
