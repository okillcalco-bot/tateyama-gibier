-- ロールバック: admin_list_reservations / admin_list_bulletins を stable 指定に戻す
--   （＝20260817の元定義。read-only tx で監査INSERTが失敗する状態に戻る点に注意）

create or replace function admin_list_reservations(p_staff_key text, p_status text default '待ち')
returns table(id uuid, product_id uuid, product_name text, species text,
              customer_id uuid, customer_name text, customer_code text,
              requested_kg numeric, status text, queue_position int, waiting_count int,
              memo text, created_at timestamptz)
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  return query
    select r.id, r.product_id, p.display_name, p.species,
           r.customer_id, c.name, c.code, r.requested_kg, r.status,
           (select count(*)::int from portal_reservations x
             where x.product_id = r.product_id and x.status='待ち' and x.created_at <= r.created_at),
           (select count(*)::int from portal_reservations x
             where x.product_id = r.product_id and x.status='待ち'),
           r.memo, r.created_at
      from portal_reservations r
      join portal_products p on p.id = r.product_id
      left join customers c on c.id = r.customer_id
     where (p_status is null or r.status = p_status)
     order by p.display_name, r.created_at;
end;
$$;

create or replace function admin_list_bulletins(p_staff_key text)
returns table(id uuid, product_id uuid, product_name text, title text, body text,
              badge text, sort_order int, is_active boolean, created_at timestamptz)
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  return query
    select b.id, b.product_id, p.display_name, b.title, b.body, b.badge,
           b.sort_order, b.is_active, b.created_at
      from portal_bulletins b
      left join portal_products p on p.id = b.product_id
     order by b.is_active desc, b.sort_order, b.created_at desc;
end;
$$;
