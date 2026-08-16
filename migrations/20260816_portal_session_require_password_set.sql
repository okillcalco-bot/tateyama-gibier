-- 20260816_portal_session_require_password_set.sql
-- 仮パスワード変更前のセッションでは、商品一覧・注文履歴・お気に入り・注文確定などの
-- データRPCを一切利用できないようにする（サーバー側で fail-closed）。
-- portal_session_customer を「must_change=false のときだけ顧客IDを解決する」よう変更する。
-- これにより、仮pwログインで作られたセッション（must_change=true）は portal_catalog /
-- portal_usual_items / portal_last_order / portal_place_order / portal_toggle_favorite / portal_me
-- のいずれからも解決されず拒否される。パスワード変更(portal_change_password)は login＋旧pw で
-- 行うためセッションに依存せず、成功時に新セッションを再発行する。

begin;

create or replace function public.portal_session_customer(p_token text)
returns uuid
language sql stable security definer set search_path to 'public','extensions'
as $function$
  select ps.customer_id
    from portal_sessions ps
    join customers c on c.id = ps.customer_id
    join customer_secrets s on s.customer_id = c.id
   where ps.token = encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex')
     and ps.expires_at > now()
     and c.is_active is not false
     and c.portal_enabled is true
     and coalesce(s.must_change, false) = false      -- 仮pw変更前は解決しない
   limit 1
$function$;

commit;
