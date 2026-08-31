-- ============================================================
-- P0-1: anon から実行できる状態変更RPCの最小権限化
--
-- 呼び出し元を frontend 全HTMLで追跡した結果に基づく（監査は再検証済み）。
-- 全RPCの search_path は設定済み（注入リスクなし・DB実測）。
--
-- 【方式】使用中の状態変更RPCには、本体を1行も書き換えずに認可を足すため
--   既存関数を *_impl にリネームし、同名の薄いラッパーで staff_key_header_ok()
--   を確認してから impl を呼ぶ。挙動は完全に保存される。
--   （staff_key_header_ok は x-staff-key ヘッダのSHA256照合。customers を守って
--    いる実績パターン: migrations/20260809_rls_tighten.sql）
--
-- ★ production へは Claude Code から適用しない（runbook参照）。
--
-- --- 分類 ---
--  A. anon実行が必要（公開フォーム/QR/ポータル）: 本ファイル対象外（変更なし）
--     public_signup_request / story_add_voice* / portal_* / base_exchange(OAuth) /
--     staff_payslip_view(token) は据え置き。
--  B. staff認証が必要（現状anonで状態変更できる）: 下記5関数にガード付与。
--  D. サーバ/cron/トリガ専用（frontend未使用）: anon EXECUTE を剥奪。
--  E. 未使用（frontend）: 同上。
--
-- 【本ファイルで“据え置き”とし report/P1 に回すもの（理由明記）】
--  ・base_update_stock/base_dispatch/base_* : 定義が本リポ外(本番直適用)で、かつ
--    認証なしの outlet.html が base_update_stock を使う。ガードすると道の駅の
--    在庫反映が止まる。→ 別途(本番定義の取得＋outlet認証設計)。
--  ・tgc_reserve_scan_codes : 認証なし相当の精肉モードが採番先取りに使用。定義は
--    本リポ外。実害は採番の消費のみ（トリガが必ず採番するため機能は継続）。→ P1。
--  ・staff_lookup_customer_id : 直接出荷（日次業務）で氏名→顧客ID解決に使用。
--    読み取りのみ・単一IDのみ返す。ガードは直接出荷に staffKeyEnsure を要し
--    日次業務に摩擦。→ P1（customersは既に staff-key 保護済みなので優先度は低）。
-- ============================================================

begin;

-- ---------- B: 使用中の状態変更RPCに staff-key ガードを付与 ----------
-- sale_event_settle（出店/直売の精算：在庫を確定・戻す）
alter function public.sale_event_settle(uuid, text) rename to sale_event_settle_impl;
revoke all on function public.sale_event_settle_impl(uuid, text) from anon, authenticated;
create or replace function public.sale_event_settle(p_event_id uuid, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $fn$
begin
  if not staff_key_header_ok() then
    raise exception 'この操作にはスタッフキーが必要です' using errcode = '42501';
  end if;
  return public.sale_event_settle_impl(p_event_id, p_by);
end $fn$;
grant execute on function public.sale_event_settle(uuid, text) to anon;

-- sale_event_reopen（精算の取消：在庫を戻す）
alter function public.sale_event_reopen(uuid, text) rename to sale_event_reopen_impl;
revoke all on function public.sale_event_reopen_impl(uuid, text) from anon, authenticated;
create or replace function public.sale_event_reopen(p_event_id uuid, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $fn$
begin
  if not staff_key_header_ok() then
    raise exception 'この操作にはスタッフキーが必要です' using errcode = '42501';
  end if;
  return public.sale_event_reopen_impl(p_event_id, p_by);
end $fn$;
grant execute on function public.sale_event_reopen(uuid, text) to anon;

-- sale_event_takeout（持ち出し：在庫を引当）
alter function public.sale_event_takeout(uuid, text) rename to sale_event_takeout_impl;
revoke all on function public.sale_event_takeout_impl(uuid, text) from anon, authenticated;
create or replace function public.sale_event_takeout(p_event_id uuid, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $fn$
begin
  if not staff_key_header_ok() then
    raise exception 'この操作にはスタッフキーが必要です' using errcode = '42501';
  end if;
  return public.sale_event_takeout_impl(p_event_id, p_by);
end $fn$;
grant execute on function public.sale_event_takeout(uuid, text) to anon;

-- staff_voice_moderate（消費者の声の公開/却下/復元）
alter function public.staff_voice_moderate(uuid, text, text) rename to staff_voice_moderate_impl;
revoke all on function public.staff_voice_moderate_impl(uuid, text, text) from anon, authenticated;
create or replace function public.staff_voice_moderate(p_id uuid, p_action text, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $fn$
begin
  if not staff_key_header_ok() then
    raise exception 'この操作にはスタッフキーが必要です' using errcode = '42501';
  end if;
  return public.staff_voice_moderate_impl(p_id, p_action, p_by);
end $fn$;
grant execute on function public.staff_voice_moderate(uuid, text, text) to anon;

-- staff_voices_list（未公開の声の下書き閲覧＝モデレーション一覧）
alter function public.staff_voices_list(text, integer) rename to staff_voices_list_impl;
revoke all on function public.staff_voices_list_impl(text, integer) from anon, authenticated;
create or replace function public.staff_voices_list(p_status text default 'pending', p_limit integer default 200)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
begin
  if not staff_key_header_ok() then
    raise exception 'この操作にはスタッフキーが必要です' using errcode = '42501';
  end if;
  return public.staff_voices_list_impl(p_status, p_limit);
end $fn$;
grant execute on function public.staff_voices_list(text, integer) to anon;

-- ---------- D/E: frontend未使用（cron/トリガ/内部/alco-os）→ anon 剥奪 ----------
-- cron 専用（pg_cron は postgres 権限で実行するので anon 剥奪の影響なし）
revoke execute on function public.apply_fixed_schedule(date, date)      from anon;
revoke execute on function public.apply_fixed_schedule_prev_month()      from anon;
-- トリガ関数（トリガ発火はEXECUTE権限に依存しないので anon 剥奪しても発火する）
revoke execute on function public.tgc_assign_scan_code()                 from anon;
revoke execute on function public.tgc_assign_individual_number()         from anon;
-- 集計read・frontend未使用
revoke execute on function public.waste_summary(date, date)             from anon;
-- 内部レート制限（他RPCがdefiner権限で内部呼び出し。anon直呼び不要）
revoke execute on function public._rl_hit(text, integer, integer)        from anon;
-- alco-os 用の判定関数（Supabase Auth の authenticated が使う。anon は不要）
revoke execute on function public.can_approve()                          from anon;
revoke execute on function public.has_role(text)                         from anon;
revoke execute on function public.current_organization_id()              from anon;
revoke execute on function public.provision_profile(text)                from anon;
-- サーバ/cron専用（定義は本リポ外・frontend未使用）
revoke execute on function public.mail_import_outlet_day(text, date, timestamp with time zone, jsonb) from anon;
revoke execute on function public.security_retention_purge()             from anon;
revoke execute on function public.get_capture_form_by_token(text)        from anon;

commit;
