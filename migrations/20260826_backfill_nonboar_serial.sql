-- 令和7年度の非イノシシ116件に通し番号を補完（現行ルールを過去分にも適用するだけ）
--
-- 背景: 個体一覧の通し番号欄が116件で空だった。中身は令和7年度(TGC-07-)の
--       キョン・ハクビシン・アライグマ・シカ・タヌキ・ノウサギで、番号自体は
--       ラベルに入っている（TGC-07-ア058 = アライグマ58番目）。
--
-- 現行の採番トリガ tgc_assign_individual_number は既に
--   ・イノシシ  → 種で共有する通し番号
--   ・それ以外  → ラベルの番号をそのまま通し番号にする
-- という規則なので、過去分にも同じ規則を当てるだけ。
--
-- 今後の採番に影響しないことの根拠:
--   ・イノシシの採番は species='イノシシ' で絞っており、非イノシシを見ない
--   ・ラベル番号の採番は label_id ~ '^TGC-08-' で絞っており、TGC-07 を見ない
-- 実測（ロールバック検証済み）: 対象116件、適用後もイノシシ最大serial=491で不変。

update public.individuals
   set serial_number = (substring(label_id from '([0-9]+)$'))::int
 where deleted_at is null
   and serial_number is null
   and species is distinct from 'イノシシ'
   and label_id ~ '^TGC-[0-9]{2}-.+[0-9]+$';
