-- 20260816_revoke_anon_auth_rpcs.sql
-- Codex 4巡目 P0-1 の最終ステップ（段階適用・本番未適用）。
--
-- ★ 適用タイミング ★
--   Edge Function(auth-gate)を配置し、5画面(index/order-admin/order-portal/payroll/sales-dashboard)を
--   auth-gate 経由へ切替済み・回復経路(order-adminのキー変更)を確認したうえで、同一作業枠で適用する。
--   本ファイルを本番へ先行適用すると、切替前の画面のスタッフキー認証が止まるため、順序を厳守すること。
--
-- 効果:
--   staff_key_ok / admin_rotate_staff_key / staff_create_enrollment_token を anon/authenticated から
--   直接実行不可にし、service_role（=auth-gate だけが保持）にのみ EXECUTE を許可する。
--   これにより PostgREST 経由での直接ブルートフォースが不可能になり、認証は必ず auth-gate の
--   IP/端末/時間窓レート制限を通る。
--
-- 検証:
--   適用後、anon キーで /rest/v1/rpc/staff_key_ok を直接叩くと 403/permission denied になること、
--   auth-gate 経由(/functions/v1/auth-gate)では従来どおり true/false が返ることを実測する。
--   ロールバック内テスト(tests/db/auth_rate_limit.test.sql)で set role anon → 実行拒否を確認済み。

revoke execute on function staff_key_ok(text) from anon, authenticated;
grant  execute on function staff_key_ok(text) to service_role;

revoke execute on function admin_rotate_staff_key(text, text) from anon, authenticated;
grant  execute on function admin_rotate_staff_key(text, text) to service_role;

revoke execute on function staff_create_enrollment_token(text, text) from anon, authenticated;
grant  execute on function staff_create_enrollment_token(text, text) to service_role;
