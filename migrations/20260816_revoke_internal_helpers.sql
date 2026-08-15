-- 20260816_revoke_internal_helpers.sql
-- Codex再レビュー（内部helperはanon/authenticatedから実行不可にする）対応。
--
-- Supabaseは既定で anon/authenticated に public スキーマ関数のEXECUTEを付与するため、
-- 「revoke all from public」だけでは anon が内部ヘルパを直接呼べてしまう。
-- 内部ヘルパは SECURITY DEFINER のラッパ関数（所有者権限で実行）からのみ呼ばれるので、
-- anon/authenticated からのEXECUTEを明示的に剥奪しても正規経路は壊れない。
--
-- 特に _ind_apply（任意列の書込）・_issue_submission_token（任意個体のトークン発行）・
-- staff_devices_revoke_all（全端末失効）は、直接呼べると認可を迂回できるため必須。

revoke execute on function _ind_apply(text, uuid, jsonb, text[]) from anon, authenticated;
revoke execute on function _ind_require_staff(text) from anon, authenticated;
revoke execute on function _idem_begin(text, text, text) from anon, authenticated;
revoke execute on function _idem_store(text, text, text, jsonb) from anon, authenticated;
revoke execute on function _capture_validate(jsonb) from anon, authenticated;
revoke execute on function _reject_unknown_keys(jsonb, text[]) from anon, authenticated;
revoke execute on function _issue_submission_token(uuid) from anon, authenticated;
revoke execute on function staff_token_resolve(text) from anon, authenticated;
revoke execute on function staff_devices_revoke_all() from anon, authenticated;
