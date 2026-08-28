-- 出店: 小分けパックに「加工商品」（productsマスタの商品）も載せられるようにする（追加のみ）
--
-- 出店で売るのは、精肉のパックだけではない。
-- 味付け肉・つくね串・ジャーキーなどの加工商品も持っていく。
-- これらも「どの一頭か」は特定できないので、小分け（kind='lot'）として扱い、
-- 売れた数だけ products.stock_qty から落とす。
--
--   sale_event_items.product_id … productsマスタの商品を指すときだけ入る
--
-- 在庫の落とし方（サイレント失敗を作らない）
--   確定 … 売れた数だけ stock_qty を減らし、product_movements に「出店販売」を残す。
--           在庫より多く売れていたら 0 で止めて、その事実を返す。
--   取消 … 同じ数だけ戻す。

begin;

alter table sale_event_items add column if not exists product_id uuid references products(id);
-- 確定のときに「実際に在庫から落とせた数」。取り消しはこれと同じ数だけ戻す。
-- （動きの記録から数え直すと、過去に取り消した分まで二重に戻ってしまう）
alter table sale_event_items add column if not exists stock_moved integer;
create index if not exists sale_event_items_product_idx on sale_event_items (product_id) where product_id is not null;

-- 加工商品の行は在庫のパックに紐づかない（小分けと同じ扱い）
alter table sale_event_items drop constraint if exists sale_event_items_product_ck;
alter table sale_event_items add  constraint sale_event_items_product_ck
  check (product_id is null or (kind = 'lot' and inventory_id is null));

create or replace function public.sale_event_settle(p_event_id uuid, p_by text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare v_ev record; v_sold int := 0; v_back int := 0; v_lot int := 0; v_prod int := 0; v_total int;
        v_bad jsonb; v_short jsonb := '[]'::jsonb; r record; k int; v_cur int;
begin
  select * into v_ev from sale_events where id = p_event_id and deleted_at is null for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'この出店が見つかりません'); end if;
  if v_ev.status <> '持ち出し済' then
    return jsonb_build_object('ok', false, 'error', '「持ち出し済」の出店だけ確定できます（今は' || v_ev.status || '）');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('ident', ident_code, 'sold', qty_sold, 'taken', qty_taken)), '[]'::jsonb)
    into v_bad
  from sale_event_items
  where event_id = p_event_id and inventory_id is not null and qty_sold not in (0, qty_taken);
  if jsonb_array_length(v_bad) > 0 then
    return jsonb_build_object('ok', false, 'error', 'パックは売れたか残ったかのどちらかで入れてください', 'blocked', v_bad);
  end if;

  update inventory inv set status = '出荷済', updated_at = now()
  from sale_event_items i
  where i.event_id = p_event_id and i.inventory_id = inv.id and i.qty_sold > 0
    and inv.deleted_at is null and inv.status in ('在庫', '引当済');
  get diagnostics v_sold = row_count;

  update inventory inv set status = '在庫', updated_at = now()
  from sale_event_items i
  where i.event_id = p_event_id and i.inventory_id = inv.id and i.qty_sold = 0
    and inv.deleted_at is null and inv.status = '引当済';
  get diagnostics v_back = row_count;

  -- 加工品の小分け（tier3の在庫）: 古い順に売れた数だけ落とす
  for r in select * from sale_event_items
           where event_id = p_event_id and kind = 'lot' and product_id is null
             and qty_sold > 0 and match_key is not null
  loop
    with pick as (
      select inv.id from inventory inv
      where inv.tier = 3 and inv.deleted_at is null and inv.status = '在庫'
        and coalesce(inv.process_type, inv.part_name) = r.match_key
      order by inv.processed_at nulls last, inv.created_at
      limit r.qty_sold::int
    )
    update inventory set status = '出荷済', updated_at = now() where id in (select id from pick);
    get diagnostics k = row_count;
    update sale_event_items set stock_moved = k where id = r.id;
    v_lot := v_lot + k;
    if k < r.qty_sold then
      v_short := v_short || jsonb_build_object('item', coalesce(r.item_name, r.match_key),
                                               'sold', r.qty_sold, 'stock_moved', k);
    end if;
  end loop;

  -- 加工商品（productsマスタ）: 売れた数だけ棚の在庫を減らす
  for r in select * from sale_event_items
           where event_id = p_event_id and product_id is not null and qty_sold > 0
  loop
    select coalesce(stock_qty, 0) into v_cur from products where id = r.product_id for update;
    k := least(v_cur, r.qty_sold::int);
    update products set stock_qty = v_cur - k, updated_at = now() where id = r.product_id;
    update sale_event_items set stock_moved = k where id = r.id;
    insert into product_movements (product_id, product_name, movement_type, qty, staff_name, note, destination)
    values (r.product_id, coalesce(r.item_name, '加工商品'), '出店販売', k, p_by,
            v_ev.venue_name || ' ' || to_char(v_ev.event_date, 'YYYY/MM/DD'), v_ev.venue_name);
    v_prod := v_prod + k;
    if k < r.qty_sold then
      v_short := v_short || jsonb_build_object('item', coalesce(r.item_name, '加工商品'),
                                               'sold', r.qty_sold, 'stock_moved', k);
    end if;
  end loop;

  select coalesce(sum(amount), 0) into v_total from sale_event_items where event_id = p_event_id;

  insert into product_movements (product_name, movement_type, qty, staff_name, note, destination)
  values ('出店売上', '出荷', v_sold + v_lot + v_prod, p_by,
          v_ev.venue_name || ' ' || to_char(v_ev.event_date, 'YYYY/MM/DD') || ' 売上 ' || v_total || '円',
          v_ev.venue_name);

  update sale_events set status = '実績確定', updated_at = now() where id = p_event_id;
  return jsonb_build_object('ok', true, 'sold', v_sold, 'lot_sold', v_lot, 'product_sold', v_prod,
                            'returned', v_back, 'total', v_total, 'short', v_short, 'status', '実績確定');
end $function$;

create or replace function public.sale_event_reopen(p_event_id uuid, p_by text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare v_ev record; v_back int := 0; v_lot int := 0; v_prod int := 0; r record; k int;
begin
  select * into v_ev from sale_events where id = p_event_id and deleted_at is null for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'この出店が見つかりません'); end if;
  if v_ev.status = '準備中' then
    return jsonb_build_object('ok', false, 'error', 'この出店はまだ持ち出していません');
  end if;

  update inventory inv set status = '在庫', updated_at = now()
  from sale_event_items i
  where i.event_id = p_event_id and i.inventory_id = inv.id
    and inv.deleted_at is null and inv.status in ('引当済', '出荷済');
  get diagnostics v_back = row_count;

  if v_ev.status = '実績確定' then
    for r in select * from sale_event_items
             where event_id = p_event_id and kind = 'lot' and product_id is null
               and qty_sold > 0 and match_key is not null
    loop
      with pick as (
        select inv.id from inventory inv
        where inv.tier = 3 and inv.deleted_at is null and inv.status = '出荷済'
          and coalesce(inv.process_type, inv.part_name) = r.match_key
        order by inv.updated_at desc nulls last
        limit coalesce(r.stock_moved, r.qty_sold::int)
      )
      update inventory set status = '在庫', updated_at = now() where id in (select id from pick);
      get diagnostics k = row_count;
      v_lot := v_lot + k;
    end loop;
    update sale_event_items set stock_moved = null
    where event_id = p_event_id and kind = 'lot' and product_id is null;

    -- 加工商品は、確定のときに実際に落とせた数だけ戻す
    for r in select * from sale_event_items
             where event_id = p_event_id and product_id is not null and coalesce(stock_moved, 0) > 0
    loop
      update products set stock_qty = coalesce(stock_qty, 0) + r.stock_moved, updated_at = now()
      where id = r.product_id;
      insert into product_movements (product_id, product_name, movement_type, qty, staff_name, note, destination)
      values (r.product_id, coalesce(r.item_name, '加工商品'), '出店取消', r.stock_moved, p_by,
              v_ev.venue_name || ' ' || to_char(v_ev.event_date, 'YYYY/MM/DD') || ' の確定を取り消し', v_ev.venue_name);
      v_prod := v_prod + r.stock_moved;
    end loop;
    update sale_event_items set stock_moved = null
    where event_id = p_event_id and product_id is not null;
  end if;

  insert into product_movements (product_name, movement_type, qty, staff_name, note, destination)
  values ('出店取消', '戻し', v_back + v_lot + v_prod, p_by,
          v_ev.venue_name || ' ' || to_char(v_ev.event_date, 'YYYY/MM/DD') || ' の確定を取り消し', v_ev.venue_name);

  update sale_events set status = '準備中', updated_at = now() where id = p_event_id;
  return jsonb_build_object('ok', true, 'returned', v_back, 'lot_returned', v_lot,
                            'product_returned', v_prod, 'status', '準備中');
end $function$;

-- 出店の一覧ページ: 加工商品も小分けとして出す（原料の頭が分かるものは並べる）
create or replace function public.story_get_event(p_event_id uuid)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_ev record; v_inds jsonb; v_lots jsonb;
begin
  if p_event_id is null then return null; end if;
  select * into v_ev from sale_events where id = p_event_id and deleted_at is null;
  if not found then return null; end if;

  select coalesce(jsonb_agg(x order by x->>'capture_date' desc), '[]'::jsonb) into v_inds
  from (
    select distinct on (ind.label_id) jsonb_build_object(
      'label', ind.label_id, 'species', ind.species, 'sex', ind.sex, 'weight_total', ind.weight_total,
      'capture_date', to_char(ind.capture_date, 'YYYY/MM/DD'),
      'place', trim(both ' ' from coalesce(ind.capture_city,'') || ' ' || coalesce(ind.capture_area,'')),
      'method', ind.capture_method,
      'radiation_date', to_char(ind.radiation_test_date, 'YYYY/MM/DD'),
      'radiation_result', ind.radiation_result,
      'processed_date', to_char(ind.processing_done_at at time zone 'Asia/Tokyo', 'YYYY/MM/DD'),
      'aging_days', case when ind.processing_done_at is null or ind.capture_date is null then null
                         else ((ind.processing_done_at at time zone 'Asia/Tokyo')::date - ind.capture_date) end,
      'parts', (select coalesce(jsonb_agg(distinct i2.part_name), '[]'::jsonb) from sale_event_items i2
                where i2.event_id = p_event_id and i2.individual_label = ind.label_id)) x, ind.label_id
    from sale_event_items i
    join individuals ind on ind.label_id = i.individual_label and ind.deleted_at is null
    where i.event_id = p_event_id and i.kind = 'inventory') s;

  select coalesce(jsonb_agg(jsonb_build_object(
           'name', coalesce(i.item_name, i.match_key), 'qty', i.qty_taken,
           'kind', case when i.product_id is not null then 'product' else 'lot' end,
           'members', (select coalesce(jsonb_agg(jsonb_build_object('label', ind.label_id,
                          'place', trim(both ' ' from coalesce(ind.capture_city,'') || ' ' || coalesce(ind.capture_area,'')),
                          'capture_date', to_char(ind.capture_date, 'YYYY/MM/DD')) order by ind.capture_date), '[]'::jsonb)
                       from individuals ind
                       where ind.label_id = any(coalesce(i.member_labels, '{}')) and ind.deleted_at is null))
           order by i.created_at), '[]'::jsonb) into v_lots
  from sale_event_items i where i.event_id = p_event_id and i.kind = 'lot';

  return jsonb_build_object(
    'event', jsonb_build_object('title', v_ev.title, 'venue', v_ev.venue_name,
      'date', to_char(v_ev.event_date, 'YYYY/MM/DD'), 'end_date', to_char(v_ev.end_date, 'YYYY/MM/DD')),
    'individuals', v_inds, 'lots', v_lots);
end $function$;

commit;
