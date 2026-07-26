-- ============================================================
-- ジビエ基幹  2026-07-26: hunters のRLS最小強化（第1段階）
--
-- 背景:
--   hunters は「RLS有効 + allow_all（全操作 using(true)）」のため、
--   anon キーで口座情報まで読み書き・**物理削除**ができる状態だった。
--   捕獲者台帳には206名の実データがあり、口座情報を含む。
--
-- 調査結果（既存アプリが anon キーで hunters に対して行っている操作）:
--   index.html       : GET ?select=*（台帳タブ / 国産ジビエ認証様式の帳票）
--                      POST・PATCH（台帳の追加・編集。口座欄を含む）
--   capture-form.html: GET ?select=name,memo / GET ?select=phone（捕獲票の電話番号）
--   DELETE を投げている箇所は無い（削除は deleted_at のソフトデリート運用）
--
-- 第1段階（このファイル・現場を止めない範囲）:
--   select / insert / update は今までどおり許可し、**delete だけを塞ぐ**。
--   既存アプリは DELETE を使っていないため、動作に影響しない。
--
-- 第2段階（口座列を anon から隠す。**このファイルでは実行しない**）:
--   列単位で revoke すると PostgREST の `?select=*` が 42501 で失敗するため、
--   先に index.html の 2箇所の `?select=*` を明示列リストへ変更し、
--   本番で表示確認したうえで、次のSQLを別ファイルで適用すること。
--
--     revoke select (bank_name, bank_branch, account_type, account_number, account_holder)
--       on hunters from anon;
--     revoke update (bank_name, bank_branch, account_type, account_number, account_holder)
--       on hunters from anon;
--
--   口座の閲覧・編集は ALCO OS（認証済み・owner/manager 限定・監査ログ付き）へ寄せる。
-- ============================================================

drop policy if exists allow_all on hunters;

do $$ begin
  create policy hunters_select on hunters for select using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy hunters_insert on hunters for insert with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy hunters_update on hunters for update using (true) with check (true);
exception when duplicate_object then null; end $$;

-- delete ポリシーは作らない = 物理削除不可（ソフトデリート deleted_at を使う）

comment on table hunters is
  '捕獲者台帳。RLSは select/insert/update のみ許可（delete不可）。口座列の anon 非公開化は第2段階（2026-07-26 hunters_rls_hardening のコメント参照）';
