-- 20260809_portal_sessions_rpc.sql の取り消し。
drop function if exists staff_key_register_header(text);
drop function if exists staff_key_header_ok();
drop function if exists admin_order_allocations(text, uuid);
drop function if exists admin_set_order_status(text, uuid, text);
drop function if exists portal_place_order(text, jsonb, date, text, text);
drop function if exists portal_rebuild_cart(text, uuid);
drop function if exists portal_last_order(text);
drop function if exists portal_my_orders(text, int);
drop function if exists portal_toggle_favorite(text, uuid);
drop function if exists portal_catalog(text);
drop function if exists portal_me(text);
drop function if exists portal_logout(text);
drop function if exists portal_login_v2(text, text, text);
drop function if exists portal_session_customer(text);
drop table if exists portal_sessions;
delete from app_secrets where key = 'staff_key_sha256';

-- staff_key_set を PR#114 時点の定義（sha256更新なし）へ戻す
create or replace function staff_key_set(p_current_key text, p_new_key text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  if length(coalesce(p_new_key, '')) < 12 then
    raise exception 'スタッフキーは12文字以上にしてください';
  end if;
  if not staff_key_ok(p_current_key) then return false; end if;
  update app_secrets
     set hash = extensions.crypt(p_new_key, extensions.gen_salt('bf')), updated_at = now()
   where key = 'staff_key';
  return true;
end;
$$;
