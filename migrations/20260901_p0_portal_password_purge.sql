-- ============================================================
-- P0-6: customers.portal_password 平文残置の消去（NULL化）
--
-- 監査(docs/security-privacy-ip-premeeting.md §A/§H)の指摘。
-- ただし監査を鵜呑みにせず、本実装時にDB・コードを再確認した結果:
--
--   ・現行ログインは customer_secrets（bcrypt）＋ portal_login_v2 経由。
--     この列を読む関数・トリガ・ビューは存在しない（DB実測: 参照0件）。
--   ・書き込み側も、index.html の CUST_FIELDS にこの列は無く、
--     order-admin.html は保存前に delete rec.portal_password している
--     （grep実測: 平文を書く経路は無い）。
--   ・NULL化SQLは 20260809_portal_security_step2.sql に既に用意されていたが、
--     「画面が portal_login 経由に切り替わり本番稼働を確認してから流す」
--     という条件のため未適用のまま残置（本番718件・DB実測）。その切替は
--     v2/v3（customer_secrets 運用）で完了済み。
--
--   → 判定: **B. NULL化可能**（列は残す＝古い画面が参照しても落ちない）。
--
-- ★ このファイルは Claude Code 側では production へ適用しない。
--   適用は docs/p0-security-remediation-runbook.md の手順に従い人間が行う。
--
-- 適用前確認（対象件数）:
--   select count(*) from customers where portal_password is not null;   -- 想定 718
--
-- backup/recovery:
--   平文パスワードは復元不要（設計上、以後 customer_secrets のみを使う）。
--   万一に備えるなら Supabase の PITR（Point-in-Time Recovery）で戻せる。
--   平文を別テーブルへ退避することは行わない（平文の複製を増やさないため）。
--
-- rollback:
--   値の復元は不要かつ非推奨（平文を再び持つことになる）。
--   列コメントだけ戻したい場合は rollback/20260901_p0_portal_password_purge_rollback.sql。
--
-- 適用後確認:
--   select count(*) from customers where portal_password is not null;   -- 期待 0
-- ============================================================

begin;

-- 影響件数を記録（適用ログに残す）
do $$
declare n int;
begin
  select count(*) into n from customers where portal_password is not null;
  raise notice 'P0-6: portal_password non-null before purge = %', n;
end $$;

-- 平文を消す。列そのものは残す（古い画面が参照しても落ちないように）。
update customers set portal_password = null where portal_password is not null;

comment on column customers.portal_password is
  '使用しません（2026-09 P0是正でNULL化）。パスワードは customer_secrets に bcrypt で保管し、portal_login_v2() 経由でのみ照合します。列は後方互換のため残置。';

commit;
