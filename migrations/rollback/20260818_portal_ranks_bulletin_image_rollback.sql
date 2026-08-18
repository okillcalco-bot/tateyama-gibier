-- ロールバック: 20260818_portal_ranks_bulletin_image
-- 注: 相談ONCONFLICT修正(portal_submit_inquiry)はバグ修正のため戻さない（戻すと送信不可に戻る）。

-- ② イノシシ 上・極上ランク商品を削除（price/parts はFK cascade）
delete from portal_products
 where species='イノシシ' and grade_label in ('上','極上')
   and display_name like '猪%（%）';

-- ③ 掲示板の画像対応を戻す
drop function if exists portal_bulletins();
create or replace function portal_bulletins()
returns table(id uuid, product_id uuid, title text, body text, badge text, sort_order int, created_at timestamptz)
language sql stable security definer set search_path to 'public' as $$
  select b.id, b.product_id, b.title, b.body, b.badge, b.sort_order, b.created_at
    from portal_bulletins b where b.is_active order by b.sort_order, b.created_at desc;
$$;
grant execute on function portal_bulletins() to anon;

drop function if exists admin_list_bulletins(text);
create or replace function admin_list_bulletins(p_staff_key text)
returns table(id uuid, product_id uuid, product_name text, title text, body text,
              badge text, sort_order int, is_active boolean, created_at timestamptz)
language plpgsql security definer set search_path to 'public' as $$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  return query
    select b.id, b.product_id, p.display_name, b.title, b.body, b.badge,
           b.sort_order, b.is_active, b.created_at
      from portal_bulletins b left join portal_products p on p.id = b.product_id
     order by b.is_active desc, b.sort_order, b.created_at desc;
end;
$$;
grant execute on function admin_list_bulletins(text) to anon;

alter table portal_bulletins drop column if exists image_url;
