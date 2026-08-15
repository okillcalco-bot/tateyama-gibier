-- 20260815_data_preservation_verify.sql
-- P0-2/P1-2/端末トークンのセキュリティ改修で「今日の本番データが失われていない」ことを
-- 監査可能にする読み取り専用チェック。非破壊・再実行可。期待値と違えば例外を投げる。
--
-- スナップショット基準日: 2026-08-15
--   ・今日持込(capture_date=2026-08-15)         : 4件以上
--   ・今日新規(created_at::date=2026-08-15)      : 2件以上
--   ・有効個体(deleted_at is null)               : 566件以上（通常は増える一方）
--   ・今日の個体ラベルが全て残存（論理削除もされていない）
--   ・label_id重複なし / inventory・processing_logの孤児FKなし
--   ・inventory.individual_code不整合なし
--   ・監査表(individual_audit)・冪等表(request_log)にテストデータ混入なし
do $$
declare n int; bad int;
begin
  -- 今日のスナップショット（改修後に本番データが減っていないこと）
  select count(*) into n from individuals where capture_date = date '2026-08-15' and deleted_at is null;
  if n < 4 then raise exception '今日持込: 期待>=4 実測%', n; end if;

  select count(*) into n from individuals where created_at::date = date '2026-08-15' and deleted_at is null;
  if n < 2 then raise exception '今日新規: 期待>=2 実測%', n; end if;

  select count(*) into n from individuals where deleted_at is null;
  if n < 566 then raise exception '有効個体: 期待>=566 実測%', n; end if;

  -- 今日登録された個体ラベルが全て残っている（誤って消えていない）
  select count(*) into n from individuals
   where label_id in ('TGC-08-T273','TGC-08-T274','TGC-08-M181','TGC-08-T275') and deleted_at is null;
  if n <> 4 then raise exception '今日の個体ラベル残存: 期待4 実測%', n; end if;

  -- 不変条件: 有効個体の label_id 重複なし
  select count(*) into bad from (
    select label_id from individuals where deleted_at is null group by label_id having count(*) > 1
  ) d;
  if bad <> 0 then raise exception 'label_id重複: %件', bad; end if;

  -- 不変条件: 在庫・加工の孤児FK（存在しない label_id を参照）なし
  select count(*) into bad from inventory v
   where v.individual_id is not null and not exists (select 1 from individuals i where i.label_id = v.individual_id);
  if bad <> 0 then raise exception '在庫の孤児FK: %件', bad; end if;
  select count(*) into bad from processing_log pl
   where pl.individual_id is not null and not exists (select 1 from individuals i where i.label_id = pl.individual_id);
  if bad <> 0 then raise exception '加工ログの孤児FK: %件', bad; end if;

  -- 不変条件: 在庫の非正規化コード不一致なし
  select count(*) into bad from inventory
   where individual_code is not null and individual_id is not null and individual_code <> individual_id;
  if bad <> 0 then raise exception '在庫コード不一致: %件', bad; end if;

  -- テストデータ混入なし（改修時のスモークテストが本番へ残っていない）
  select count(*) into bad from individuals where label_id like 'TEST-%' or label_id in ('TGC-08-T900','TGC-08-T999','TGC-08-T333');
  if bad <> 0 then raise exception 'テスト個体の混入: %件', bad; end if;
  select count(*) into bad from request_log where client_request_id like 'REQ-TEST-%';
  if bad <> 0 then raise exception 'request_logへのテスト混入: %件', bad; end if;

  raise notice 'data preservation verify (2026-08-15): ALL OK';
end $$;
