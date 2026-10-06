-- 出荷で「どうやってパックを選んだか」を残す（2026-10-05）
-- きっかけ: 出荷済の記録なのに現物がセンターに残っていた、が3回続いた
--   （a La Bouteille のヒレ T300/T328、石川恵理のミンチ MI-20260918-010、ほか）。
--   ラベルを読まずに、同じ重さ・同じロットの番号を一覧やドロップダウンから選ぶと、記録と現物がずれる。
-- pick_method:
--   scan     … バーコードリーダーで読んだ（入力が機械の速さ）
--   typed    … 識別コードを手で打った（手元のラベルを見て打っている）
--   picker   … 個体の在庫一覧からタップで選んだ（ラベルを読んでいない）→ 要確認
--   dropdown … 注文の出荷画面のドロップダウンで選んだ（ラベルを読んでいない）→ 要確認
--   null     … この列ができる前の記録
-- pick_checked_at/by … 要確認の行を、現物と照らして確認した記録
-- 追加のみ（既存の行は変えない）。
alter table public.order_items add column if not exists pick_method text
  check (pick_method is null or pick_method in ('scan','typed','picker','dropdown'));
alter table public.order_items add column if not exists pick_checked_at timestamptz;
alter table public.order_items add column if not exists pick_checked_by text;
create index if not exists order_items_pick_unchecked_idx on public.order_items(created_at desc)
  where pick_method in ('picker','dropdown') and pick_checked_at is null;
