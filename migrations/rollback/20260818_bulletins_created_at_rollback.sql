-- ロールバック: portal_bulletins() を created_at 無しの元の返却に戻す

drop function if exists portal_bulletins();
create or replace function portal_bulletins()
returns table(id uuid, product_id uuid, title text, body text, badge text, sort_order int)
language sql stable security definer set search_path to 'public' as $$
  select b.id, b.product_id, b.title, b.body, b.badge, b.sort_order
    from portal_bulletins b
   where b.is_active
   order by b.sort_order, b.created_at desc;
$$;
grant execute on function portal_bulletins() to anon;
