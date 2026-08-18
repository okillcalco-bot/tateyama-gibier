-- 「いつもの」は購入実績が2回以上の商品だけを対象にする（1回だけの購入は含めない）。
-- admin_recompute_usual_items に having count(*)>=2 を追加し、掃除条件も2回未満は除外に。
-- 本番適用済み。ロールバックは 20260817以前の定義（>=1）に戻す。
create or replace function public.admin_recompute_usual_items(p_staff_key text, p_customer_id uuid default null, p_by text default null)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
declare v_customers int; v_items int;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  with agg as (
    select f.customer_id, f.product_id,
           count(*) as purchase_count, sum(f.weight_kg) as total_kg, avg(f.weight_kg) as avg_order_kg,
           max(f.purchased_on) as last_purchased_on,
           case when count(*) > 1 then (max(f.purchased_on) - min(f.purchased_on))::numeric / (count(*) - 1) else null end as avg_interval_days
      from customer_purchase_facts f
      join portal_products p on p.id = f.product_id and coalesce(p.is_active, true) and coalesce(p.is_reorderable, true)
     where f.canceled_at is null and (p_customer_id is null or f.customer_id = p_customer_id)
     group by f.customer_id, f.product_id
     having count(*) >= 2
  ),
  ranked as (
    select a.*, row_number() over (partition by a.customer_id order by a.purchase_count desc, a.total_kg desc, a.last_purchased_on desc) as rk from agg a
  ),
  upserted as (
    insert into customer_usual_items (customer_id, product_id, rank, purchase_count, total_kg, avg_order_kg, usual_qty_kg, last_purchased_on, avg_interval_days, reason, computed_at)
    select customer_id, product_id, rk, purchase_count, round(total_kg,2), round(avg_order_kg,2), round(avg_order_kg,2), last_purchased_on, round(avg_interval_days,1),
           '購入実績 '||purchase_count||'回・合計'||round(total_kg,1)||'kg', now()
      from ranked
    on conflict (customer_id, product_id) do update set
      rank = excluded.rank, purchase_count = excluded.purchase_count, total_kg = excluded.total_kg,
      avg_order_kg = excluded.avg_order_kg, usual_qty_kg = excluded.usual_qty_kg,
      last_purchased_on = excluded.last_purchased_on, avg_interval_days = excluded.avg_interval_days,
      reason = excluded.reason, computed_at = now()
    returning customer_id
  )
  select count(distinct customer_id), count(*) into v_customers, v_items from ranked;
  delete from customer_usual_items u
   where (p_customer_id is null or u.customer_id = p_customer_id)
     and not u.is_pinned
     and not exists (
       select 1 from customer_purchase_facts f
        join portal_products p on p.id = f.product_id and coalesce(p.is_active, true) and coalesce(p.is_reorderable, true)
       where f.canceled_at is null and f.customer_id = u.customer_id and f.product_id = u.product_id
       group by f.customer_id, f.product_id
       having count(*) >= 2);
  return jsonb_build_object('ok', true, 'customers', v_customers, 'items', v_items);
end;
$function$;
