-- 修正: 管理向け一覧RPCの 25006（read-only transaction でINSERT不可）
--
-- 症状: order-admin の「予約・掲示板」タブで
--   掲示板の読込みに失敗しました: {"code":"25006", ... "cannot execute INSERT in a read-only transaction"}
--
-- 原因: staff_key_ok() は認証成功/失敗のたびに auth_attempts へ監査INSERTする（VOLATILE）。
--   ところが admin_list_bulletins / admin_list_reservations を stable で定義したため、
--   PostgREST がこれらを READ ONLY トランザクションで実行し、内部の監査INSERTが 25006 で失敗していた。
--
-- 対処: この2関数から stable を外し（＝VOLATILE）、read-write トランザクションで走らせる。
--   返す内容・引数・権限は不変。追加のみ（create or replace）。grantは据え置き（replaceで維持）。
--
-- ロールバック: migrations/rollback/20260818_fix_admin_list_readonly_rollback.sql

-- 予約（入荷待ち）一覧。時系列。既定は「待ち」のみ
create or replace function admin_list_reservations(p_staff_key text, p_status text default '待ち')
returns table(id uuid, product_id uuid, product_name text, species text,
              customer_id uuid, customer_name text, customer_code text,
              requested_kg numeric, status text, queue_position int, waiting_count int,
              memo text, created_at timestamptz)
language plpgsql security definer set search_path to 'public' as $$
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
language plpgsql security definer set search_path to 'public' as $$
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

grant execute on function admin_list_reservations(text, text) to anon;
grant execute on function admin_list_bulletins(text) to anon;
