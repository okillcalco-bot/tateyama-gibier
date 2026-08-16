-- rollback of 20260816_capture_rpcs_v2.sql
-- ★★ FORWARD-ONLY 方針（Codex 4巡目 P1-3 対応） ★★
-- 本セキュリティ改修は「巻き戻さない（forward-only）」。不具合は新しい追加マイグレーションで前進修正する。
--
-- このファイルは「監査つきRPC層をまるごと撤去する安全な teardown」専用であり、
-- 【脆弱な旧認証（raw-keyフォールバックの _ind_require_staff / anon が叩ける staff_device_register）を
--  再現（再作成）しない】。以前このファイルに含めていた脆弱定義の再作成ブロックは削除済み。
--
-- ■ 使い方（緊急時のみ・クライアントも同PRごと revert すること）:
--   下の DO ブロックのガードを外して実行すると、監査つき書込RPC層を撤去する。
--   撤去後は individuals への書込経路が無くなるため、必ず次のいずれかで復旧する:
--     (a) 前進修正: 新しい追加マイグレーションで問題箇所のみ CREATE OR REPLACE する（推奨）
--     (b) 完全復元: ハードニング済みマイグレーション群を順に再適用する
--         20260815_individuals_write_rpcs.sql → 20260815_staff_device_tokens.sql →
--         20260815_recovery_ratelimit_fix.sql → 20260816_capture_rpcs_v2.sql →
--         20260816_capture_rpcs_v2_fixes.sql → 20260816_enrollment_tokens.sql →
--         20260816_reason_and_inventory_check.sql → 20260816_revoke_internal_helpers.sql →
--         20260816_submission_token_hmac.sql → 20260816_relabel_reason_and_enrollment_audit.sql →
--         20260816_capture_photos_readonly.sql
--   ※ (b) は必ずハードニング済み定義を使う。脆弱な旧定義を手で再現してはならない。

-- 誤実行防止ガード。撤去を実行する場合はこの RAISE を一時的にコメントアウトすること。
do $$
begin
  raise exception 'この teardown はガードされています。実行するには 20260816_capture_rpcs_v2_rollback.sql 冒頭の RAISE を一時的に外してください（脆弱な旧認証は復元しません）。';
end $$;

-- ── 監査つき書込RPC層の撤去（脆弱定義の再現は一切しない） ──

-- 公開/スタッフの個体書込RPC
drop function if exists public_capture_submit(jsonb, text);
drop function if exists staff_capture_intake(text, jsonb, text);
drop function if exists staff_individual_edit(text, uuid, jsonb, text, text);
drop function if exists staff_individual_relabel(text, uuid, text, text);
drop function if exists staff_individual_update(text, uuid, jsonb);
drop function if exists staff_individual_create(text, jsonb);
drop function if exists staff_individual_soft_delete(text, uuid, text);
drop function if exists staff_individual_restore(text, uuid, text);
drop function if exists public_capture_update_survey(text, jsonb, text);
drop function if exists public_attach_capture_photo(text, text, text, text);

-- 端末トークン/招待/認証まわり（anon から叩けた脆弱経路は再現しない）
drop function if exists staff_device_register(text, text);          -- ← 脆弱: 再作成しない
drop function if exists staff_enroll_device(text, text);
drop function if exists staff_create_enrollment_token(text, text);
drop function if exists staff_token_resolve(text);
drop function if exists staff_devices_revoke_all();
drop function if exists _ind_require_staff(text);                   -- ← raw-keyフォールバック版は再作成しない

-- 内部ヘルパ
drop function if exists _ind_apply(text, uuid, jsonb, text[]);
drop function if exists _idem_begin(text, text, text);
drop function if exists _idem_store(text, text, text, jsonb);
drop function if exists _capture_validate(jsonb);
drop function if exists _reject_unknown_keys(jsonb, text[]);
drop function if exists _issue_submission_token(uuid);
drop function if exists _issue_submission_token(uuid, text);

-- v2固有の表
drop table if exists submission_tokens cascade;
drop table if exists enrollment_tokens cascade;
drop table if exists staff_device_tokens cascade;
drop table if exists request_log cascade;

-- 撤去後、individuals のRLSは本改修前のまま（anon直接書込は本PRではまだ剥奪していない）。
-- サービス復旧はハードニング済みマイグレーションの再適用、または前進修正で行うこと。
