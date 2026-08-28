-- 出店: 「個体が分かるもの」と「小分けパック」を分ける（追加のみ）
--
-- 出店で売る小分けパック（ミンチ・スライス等の加工品）は、300個のうちのどれが
-- どの個体か、という紐づけができない。個体1:1のパックと同じ扱いにすると嘘になる。
-- そこで明細の種類を3つに分ける。
--
--   inventory … 精肉のパック。1パック＝1個体。売れたか残ったかの二択。
--   lot       … 小分けパック。商品名と数量で持って行き、数量で売る。
--               原料の個体は「この商品に入っている頭たち」までしか分からない。
--   other     … うちの在庫でない品（仕入れ・グッズなど）。
--
-- あわせて、既存の欠陥を直す。
--   加工品ラベルのQRが、複数頭を混ぜたロットでも先頭の1頭だけを
--   「このお肉になった一頭」と表示していた（実測: 最大9頭混在）。
--   1頭のときは今までどおり、複数頭のときは全頭を並べるようにする。

begin;

-- ── 1) 小分けパックの行を持てるようにする ──
alter table sale_event_items add column if not exists lot_code      text;      -- 加工ロット（TGC-MIB-... など）
alter table sale_event_items add column if not exists match_key     text;      -- 在庫から落とすときの商品名
alter table sale_event_items add column if not exists member_labels text[];    -- この商品に入っている個体（記録時点）

alter table sale_event_items drop constraint if exists sale_event_items_kind_ck;
alter table sale_event_items add  constraint sale_event_items_kind_ck
  check (kind in ('inventory', 'lot', 'other'));

-- 個体1:1の行だけが inventory_id を持つ（小分けは持たない）
alter table sale_event_items drop constraint if exists sale_event_items_link_ck;
alter table sale_event_items add  constraint sale_event_items_link_ck
  check (kind = 'inventory' or inventory_id is null);

-- ── 2) 売上確定: 小分けは「売れた数だけ古い順に」在庫から落とす ──
create or replace function public.sale_event_settle(p_event_id uuid, p_by text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare v_ev record; v_sold int := 0; v_back int := 0; v_lot int := 0; v_total int;
        v_bad jsonb; v_short jsonb := '[]'::jsonb; r record; k int;
begin
  select * into v_ev from sale_events where id = p_event_id and deleted_at is null for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'この出店が見つかりません'); end if;
  if v_ev.status <> '持ち出し済' then
    return jsonb_build_object('ok', false, 'error', '「持ち出し済」の出店だけ確定できます（今は' || v_ev.status || '）');
  end if;

  -- 個体1:1のパックは「売れた」か「残った」かのどちらか
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

  -- 小分けパック: どの個体が売れたかは特定できないので、古い順に売れた数だけ落とす。
  -- 足りなければ黙って減らさずに報告する。
  for r in select * from sale_event_items
           where event_id = p_event_id and kind = 'lot' and qty_sold > 0 and match_key is not null
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
    v_lot := v_lot + k;
    if k < r.qty_sold then
      v_short := v_short || jsonb_build_object('item', coalesce(r.item_name, r.match_key),
                                               'sold', r.qty_sold, 'stock_moved', k);
    end if;
  end loop;

  select coalesce(sum(amount), 0) into v_total from sale_event_items where event_id = p_event_id;

  insert into product_movements (product_name, movement_type, qty, staff_name, note, destination)
  values ('出店売上', '出荷', v_sold + v_lot, p_by,
          v_ev.venue_name || ' ' || to_char(v_ev.event_date, 'YYYY/MM/DD') || ' 売上 ' || v_total || '円',
          v_ev.venue_name);

  update sale_events set status = '実績確定', updated_at = now() where id = p_event_id;
  return jsonb_build_object('ok', true, 'sold', v_sold, 'lot_sold', v_lot,
                            'returned', v_back, 'total', v_total, 'short', v_short, 'status', '実績確定');
end $function$;

-- ── 3) 取り消し: 小分けで落とした分も戻す ──
create or replace function public.sale_event_reopen(p_event_id uuid, p_by text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare v_ev record; v_back int := 0; v_lot int := 0; r record; k int;
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

  -- 小分けは個体が特定できないので、落としたのと同じ数を新しい順に戻す
  if v_ev.status = '実績確定' then
    for r in select * from sale_event_items
             where event_id = p_event_id and kind = 'lot' and qty_sold > 0 and match_key is not null
    loop
      with pick as (
        select inv.id from inventory inv
        where inv.tier = 3 and inv.deleted_at is null and inv.status = '出荷済'
          and coalesce(inv.process_type, inv.part_name) = r.match_key
        order by inv.updated_at desc nulls last
        limit r.qty_sold::int
      )
      update inventory set status = '在庫', updated_at = now() where id in (select id from pick);
      get diagnostics k = row_count;
      v_lot := v_lot + k;
    end loop;
  end if;

  insert into product_movements (product_name, movement_type, qty, staff_name, note, destination)
  values ('出店取消', '戻し', v_back + v_lot, p_by,
          v_ev.venue_name || ' ' || to_char(v_ev.event_date, 'YYYY/MM/DD') || ' の確定を取り消し', v_ev.venue_name);

  update sale_events set status = '準備中', updated_at = now() where id = p_event_id;
  return jsonb_build_object('ok', true, 'returned', v_back, 'lot_returned', v_lot, 'status', '準備中');
end $function$;

-- ── 4) 加工品ラベルのQR: 混ざっている頭を1頭と言わない ──
create or replace function public.story_get(p_code text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_inv record; v_ind record; v_out jsonb; v_parts jsonb; v_voices jsonb;
        v_label text; v_labels text[]; v_many jsonb;
begin
  if p_code is null or btrim(p_code) = '' then return null; end if;

  select i.ident_code, i.part_name, i.process_type, i.weight, i.weight_kg,
         i.individual_id, i.individual_code, i.tier, i.processed_at
    into v_inv
  from inventory i
  where i.scan_code = btrim(p_code) and i.deleted_at is null
  limit 1;
  if not found then return null; end if;

  -- 原料の個体をすべて拾う（加工品は複数頭が混ざる）
  if v_inv.individual_id is not null then
    v_labels := array[v_inv.individual_id];
  elsif v_inv.individual_code is not null then
    select coalesce(array_agg(distinct l.individual_id), '{}')
      into v_labels
    from processing_log l
    where l.child_ident_code = v_inv.individual_code and l.individual_id is not null;
  else
    v_labels := '{}';
  end if;

  v_label := case when array_length(v_labels, 1) = 1 then v_labels[1] else null end;

  select ind.label_id, ind.species, ind.sex, ind.weight_total, ind.capture_date,
         ind.capture_city, ind.capture_area, ind.capture_method, ind.is_juvenile,
         ind.radiation_test_date, ind.radiation_result, ind.processing_done_at
    into v_ind
  from individuals ind
  where ind.label_id = v_label and ind.deleted_at is null
  limit 1;

  -- 複数頭のときは「この商品に入っている頭たち」として全部返す
  select coalesce(jsonb_agg(jsonb_build_object(
           'label', ind.label_id, 'species', ind.species, 'sex', ind.sex,
           'capture_date', to_char(ind.capture_date, 'YYYY/MM/DD'),
           'place', trim(both ' ' from coalesce(ind.capture_city,'') || ' ' || coalesce(ind.capture_area,'')),
           'method', ind.capture_method,
           'radiation_result', ind.radiation_result)
           order by ind.capture_date), '[]'::jsonb)
    into v_many
  from individuals ind
  where ind.label_id = any(v_labels) and ind.deleted_at is null;

  -- 部位は1頭に絞れるときだけ出す（混ざっていると意味を成さない）
  if v_label is not null then
    select coalesce(jsonb_agg(jsonb_build_object('part', p.part_name, 'kg', coalesce(p.weight, p.weight_kg))
                              order by p.created_at), '[]'::jsonb)
      into v_parts
    from inventory p
    where p.individual_id = v_label and p.deleted_at is null and p.tier = 2;
  else
    v_parts := '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'nickname', v.nickname, 'rating', v.rating, 'dish', v.dish,
           'comment', v.comment, 'at', to_char(v.created_at at time zone 'Asia/Tokyo','YYYY/MM/DD'))
           order by v.created_at desc), '[]'::jsonb)
    into v_voices
  from meal_voices v
  where v.individual_label = any(v_labels)
    and v.deleted_at is null
    and v.published_at is not null;

  v_out := jsonb_build_object(
    'scan_code', btrim(p_code),
    'product', jsonb_build_object(
      'name', coalesce(v_inv.process_type, v_inv.part_name),
      'kg', coalesce(v_inv.weight, v_inv.weight_kg),
      'ident', v_inv.ident_code),
    'individual', case when v_ind.label_id is null then null else jsonb_build_object(
      'label', v_ind.label_id, 'species', v_ind.species, 'sex', v_ind.sex,
      'weight_total', v_ind.weight_total,
      'capture_date', to_char(v_ind.capture_date, 'YYYY/MM/DD'),
      'place', trim(both ' ' from coalesce(v_ind.capture_city,'') || ' ' || coalesce(v_ind.capture_area,'')),
      'method', v_ind.capture_method, 'is_juvenile', v_ind.is_juvenile,
      'radiation_date', to_char(v_ind.radiation_test_date, 'YYYY/MM/DD'),
      'radiation_result', v_ind.radiation_result,
      'processed_date', to_char(v_ind.processing_done_at at time zone 'Asia/Tokyo', 'YYYY/MM/DD'),
      'aging_days', case when v_ind.processing_done_at is null or v_ind.capture_date is null then null
                         else ((v_ind.processing_done_at at time zone 'Asia/Tokyo')::date - v_ind.capture_date) end
      ) end,
    'blend', case when coalesce(array_length(v_labels, 1), 0) > 1 then v_many else null end,
    'parts', v_parts,
    'voices', v_voices);
  return v_out;
end $function$;

-- ── 5) 出店の一覧ページ（会場に貼るQRの行き先） ──
create or replace function public.story_get_event(p_event_id uuid)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_ev record; v_inds jsonb; v_lots jsonb;
begin
  if p_event_id is null then return null; end if;
  select * into v_ev from sale_events where id = p_event_id and deleted_at is null;
  if not found then return null; end if;

  -- 個体が分かるもの（1パック＝1頭）
  select coalesce(jsonb_agg(x order by x->>'capture_date' desc), '[]'::jsonb) into v_inds
  from (
    select distinct on (ind.label_id) jsonb_build_object(
      'label', ind.label_id, 'species', ind.species, 'sex', ind.sex,
      'weight_total', ind.weight_total,
      'capture_date', to_char(ind.capture_date, 'YYYY/MM/DD'),
      'place', trim(both ' ' from coalesce(ind.capture_city,'') || ' ' || coalesce(ind.capture_area,'')),
      'method', ind.capture_method,
      'radiation_date', to_char(ind.radiation_test_date, 'YYYY/MM/DD'),
      'radiation_result', ind.radiation_result,
      'processed_date', to_char(ind.processing_done_at at time zone 'Asia/Tokyo', 'YYYY/MM/DD'),
      'aging_days', case when ind.processing_done_at is null or ind.capture_date is null then null
                         else ((ind.processing_done_at at time zone 'Asia/Tokyo')::date - ind.capture_date) end,
      'parts', (select coalesce(jsonb_agg(distinct i2.part_name), '[]'::jsonb)
                from sale_event_items i2
                where i2.event_id = p_event_id and i2.individual_label = ind.label_id)
      ) x, ind.label_id
    from sale_event_items i
    join individuals ind on ind.label_id = i.individual_label and ind.deleted_at is null
    where i.event_id = p_event_id and i.kind = 'inventory'
  ) s;

  -- 小分けパック（どの個体かは特定できない。入っている頭たちを並べる）
  select coalesce(jsonb_agg(jsonb_build_object(
           'name', coalesce(i.item_name, i.match_key),
           'qty', i.qty_taken,
           'members', (select coalesce(jsonb_agg(jsonb_build_object(
                          'label', ind.label_id,
                          'place', trim(both ' ' from coalesce(ind.capture_city,'') || ' ' || coalesce(ind.capture_area,'')),
                          'capture_date', to_char(ind.capture_date, 'YYYY/MM/DD'))
                          order by ind.capture_date), '[]'::jsonb)
                       from individuals ind
                       where ind.label_id = any(coalesce(i.member_labels, '{}')) and ind.deleted_at is null))
           order by i.created_at), '[]'::jsonb)
    into v_lots
  from sale_event_items i
  where i.event_id = p_event_id and i.kind = 'lot';

  return jsonb_build_object(
    'event', jsonb_build_object(
      'title', v_ev.title,
      'venue', v_ev.venue_name,
      'date', to_char(v_ev.event_date, 'YYYY/MM/DD'),
      'end_date', to_char(v_ev.end_date, 'YYYY/MM/DD')),
    'individuals', v_inds,
    'lots', v_lots);
end $function$;

grant execute on function public.story_get_event(uuid) to anon, authenticated;

commit;
