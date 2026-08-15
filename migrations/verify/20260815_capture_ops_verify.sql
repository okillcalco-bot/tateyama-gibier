-- 20260815_capture_ops_verify.sql
-- 本番へ直接適用した一回性データ操作の検証（読み取りのみ・非破壊・再実行可）。
-- Codexレビュー P1-5 対応: マイグレーション外で行ったデータ変更を監査可能にする。
-- 期待値と実測が違えば例外を投げる。
do $$
declare
  n int; bad int;
begin
  -- A: 仮-4xx（有効）が残っていない
  select count(*) into n from individuals where label_id like '仮-4%' and deleted_at is null;
  if n <> 0 then raise exception 'A 仮-4xx 残: 期待0 実測%', n; end if;

  -- B: serial 418-457 は全て正式番号(TGC-08-T/M)・40件
  select count(*) into n from individuals
   where serial_number between 418 and 457 and label_id ~ '^TGC-08-[TM]\d+$' and deleted_at is null;
  if n <> 40 then raise exception 'B 付番済(418-457): 期待40 実測%', n; end if;

  -- C: 有効個体の label_id 重複なし
  select count(*) into bad from (
    select label_id from individuals where deleted_at is null group by label_id having count(*) > 1
  ) d;
  if bad <> 0 then raise exception 'C label_id重複: %件', bad; end if;

  -- D: 在庫の孤児（individuals.label_id 未参照）なし
  select count(*) into bad from inventory v
   where v.individual_id is not null
     and not exists (select 1 from individuals i where i.label_id = v.individual_id);
  if bad <> 0 then raise exception 'D 在庫の孤児: %件', bad; end if;

  -- E: 在庫の非正規化コード不一致（code <> id）なし
  select count(*) into bad from inventory
   where individual_code is not null and individual_id is not null and individual_code <> individual_id;
  if bad <> 0 then raise exception 'E 在庫コード不一致: %件', bad; end if;

  -- F: 放射能検査19個体が「検出下限値以下」
  select count(*) into n from individuals where radiation_result = '検出下限値以下' and label_id in (
    'TGC-08-M149','TGC-08-M150','TGC-08-M151','TGC-08-M152','TGC-08-M153','TGC-08-M154','TGC-08-M155','TGC-08-M156','TGC-08-M157',
    'TGC-08-T251','TGC-08-T252','TGC-08-T253','TGC-08-T254','TGC-08-T255','TGC-08-T256','TGC-08-T257','TGC-08-T258','TGC-08-T259','TGC-08-T260');
  if n <> 19 then raise exception 'F 放射能19件: 期待19 実測%', n; end if;

  -- G: anon の物理削除(DELETE)権限が剥奪されている
  if has_table_privilege('anon','public.individuals','DELETE') then
    raise exception 'G anon DELETE権限が残存';
  end if;

  raise notice 'capture ops verify: ALL OK';
  -- 注意: H(anon UPDATE権限)は現状「あり」。P0-2で専用RPCへ移行後に剥奪予定のため本検証では例外にしない。
end $$;
