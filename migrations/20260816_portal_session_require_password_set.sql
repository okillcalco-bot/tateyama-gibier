-- 20260816_portal_session_require_password_set.sql
-- 多層防御: データ系RPCが使う portal_session_customer を、初回変更が完了(must_change=false)した
-- セッションだけに限定する。これにより「変更専用トークン」で商品/履歴/注文などのRPCを呼べない。
-- 前提: 20260816_portal_temp_password_lifecycle.sql 適用済み（customer_secrets.must_change 追加済み）。

begin;

create or replace function public.portal_session_customer(p_token text)
returns uuid
language sql stable security definer set search_path to 'public','extensions'
as $function$
  select ps.customer_id
    from portal_sessions ps
    join customers c on c.id = ps.customer_id
    join customer_secrets cs on cs.customer_id = c.id
   where ps.token = encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex')
     and ps.expires_at > now()
     and c.is_active is not false
     and c.portal_enabled is true
     and coalesce(cs.must_change, false) = false
   limit 1
$function$;

commit;
