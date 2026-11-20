-- 仲卸用の注文（2026-11-20 沖「トレタテとかノブレスオブリージュは仲卸なので、そこから他の飲食店の注文がメインになるため、
--   仲卸用の注文バージョンも作っておいて。それと、冷蔵も選べるように」）
--
-- 実測（2026-11-20）: 仲卸経由の出荷は、ノブレスオブリージュ 51店・43件、トレタテ 16店・27件。
--   どれも「届け先のお店の名義（orders.customer_id＝お店）＋備考に仲卸の名前」で入っていて、請求書・書類発行・
--   出荷データはこの形を前提に動いている（order-admin.html の wholesalerTagOf）。
--
-- 方針: これまでの形を変えない。仲卸が注文ページから頼んだ注文も「お店の名義＋備考に仲卸の名前」で入れる。
--   誰が頼んだかは orders.ordered_by_customer_id に残し、仲卸の履歴・前回の注文・もう一度注文はこれで引く。
--   単価は頼んだ仲卸の単価。お店の住所・電話は注文の表に写さない（送り状は顧客台帳から引く）。
--
-- 追加のみ。既存の注文・顧客の行は、仲卸の印（下の2社）を除いて変更しない。
-- 既存の portal_place_order は変更しない（新しい portal_place_order_v2 が中で呼ぶ）。

alter table customers add column if not exists is_wholesaler boolean not null default false;
alter table orders add column if not exists ordered_by_customer_id uuid references customers(id);
alter table orders add column if not exists temp_zone text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'orders_temp_zone_ck') then
    alter table orders add constraint orders_temp_zone_ck check (temp_zone is null or temp_zone in ('冷凍','冷蔵'));
  end if;
end $$;
create index if not exists orders_ordered_by_idx on orders (ordered_by_customer_id) where ordered_by_customer_id is not null;

-- 仲卸の印（2社）。増やすときは顧客台帳のこの印を付ける
update customers set is_wholesaler = true where name in ('トレタテ','ノブレスオブリージュ') and not is_wholesaler;

-- このお店は、この仲卸の届け先か（顧客台帳の備考に仲卸の名前がある／仲卸の名前が備考に入った注文がある）
create or replace function public.portal_ws_shop_ok(p_wholesaler uuid, p_shop uuid)
 returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select exists (
    select 1 from customers w join customers c on c.id = p_shop
     where w.id = p_wholesaler and w.is_wholesaler and c.id <> w.id and c.is_active is not false
       and (position(w.name in coalesce(c.notes,'')) > 0
            or exists (select 1 from orders o where o.customer_id = c.id and position(w.name in coalesce(o.memo,'')) > 0)));
$function$;
revoke all on function public.portal_ws_shop_ok(uuid, uuid) from public, anon, authenticated;

-- 仲卸かどうかと、届け先のお店の一覧（名前と市区町村まで。番地・電話は返さない）
create or replace function public.portal_ship_to_list(p_token text)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_id uuid := portal_session_customer(p_token); v_ws boolean;
begin
  if v_id is null then return jsonb_build_object('is_wholesaler', false, 'shops', '[]'::jsonb); end if;
  select is_wholesaler into v_ws from customers where id = v_id;
  if not coalesce(v_ws, false) then return jsonb_build_object('is_wholesaler', false, 'shops', '[]'::jsonb); end if;
  return jsonb_build_object('is_wholesaler', true, 'shops', coalesce((
    select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'kana', c.kana,
             'area', substring(coalesce(c.address,'') from '^\s*(?:〒?[0-9-]+\s*)?((?:東京都|北海道|(?:京都|大阪)府|.{2,3}県)?[^市区町村0-9]{1,8}?[市区町村])'))
           order by coalesce(c.kana, c.name))
      from customers c where portal_ws_shop_ok(v_id, c.id)), '[]'::jsonb));
end; $function$;

-- 注文する（冷凍・冷蔵と、仲卸のときは届け先のお店を選べる）。中で今までの portal_place_order を呼ぶ
create or replace function public.portal_place_order_v2(p_token text, p_items jsonb, p_delivery_date date,
  p_time_zone text default null, p_memo text default null, p_request_id text default null,
  p_temp text default null, p_ship_to uuid default null)
 returns jsonb language plpgsql security definer set search_path to 'public', 'extensions'
as $function$
declare
  v_cid uuid := portal_session_customer(p_token);
  v_me customers%rowtype; v_shop customers%rowtype;
  v_dup record; v_res jsonb; v_oid uuid;
begin
  if v_cid is null then raise exception 'ログインし直してください'; end if;
  if p_temp is not null and p_temp not in ('冷凍','冷蔵') then raise exception '配送の温度を確認してください'; end if;
  select * into v_me from customers where id = v_cid;
  if p_ship_to is not null and p_ship_to <> v_cid then
    if not portal_ws_shop_ok(v_cid, p_ship_to) then raise exception 'お届け先のお店を選び直してください'; end if;
    select * into v_shop from customers where id = p_ship_to;
  end if;

  -- 同じ注文の送り直し（届け先をお店に付け替えた後は、頼んだ人で探す）
  if p_request_id is not null and length(p_request_id) between 8 and 64 then
    select o.id, o.order_code, o.total_amount into v_dup from orders o
     where o.client_request_id = p_request_id and o.ordered_by_customer_id = v_cid;
    if v_dup.id is not null then
      return jsonb_build_object('order_id', v_dup.id, 'order_code', v_dup.order_code,
        'total_amount', v_dup.total_amount, 'duplicate', true, 'estimated', true,
        'items', coalesce((select jsonb_agg(jsonb_build_object(
            'name', oi.product_name, 'requested_kg', oi.requested_kg, 'allocated_kg', oi.allocated_kg,
            'unit_price', oi.unit_price, 'price_source', oi.price_source, 'amount', oi.amount) order by oi.created_at)
          from order_items oi where oi.order_id = v_dup.id), '[]'::jsonb));
    end if;
  end if;

  v_res := portal_place_order(p_token, p_items, p_delivery_date, p_time_zone, p_memo, p_request_id);
  if coalesce((v_res->>'duplicate')::boolean, false) then return v_res; end if;
  v_oid := (v_res->>'order_id')::uuid;

  update orders set temp_zone = p_temp, ordered_by_customer_id = v_cid where id = v_oid;
  if v_shop.id is not null then
    update orders set
      customer_id = v_shop.id, customer_name = v_shop.name, delivery_name = v_shop.name,
      delivery_address = '', delivery_building = '', delivery_phone = '',
      delivery_time_zone = coalesce(nullif(p_time_zone,''), v_shop.default_time_zone, '0000'),
      memo = v_me.name || '（仲卸からのご注文）' || case when nullif(p_memo,'') is not null then E'\n' || p_memo else '' end
    where id = v_oid;
  end if;
  return v_res || jsonb_build_object('temp_zone', p_temp, 'ship_to_name', v_shop.name);
end; $function$;

-- 履歴: 自分が頼んだ注文（届け先がお店のものを含む）も出す。届け先のお店の名前と温度を返す。
--   出荷の備考（社内メモ）と注文メモは返さない（20261120_portal_my_orders_no_internal_notes.sql と同じ）。
--   請求書・領収書の発行（can_doc）は、自分の名義の注文だけ。
create or replace function public.portal_my_orders(p_token text, p_limit integer default 50)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_id uuid := portal_session_customer(p_token);
begin
  if v_id is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(o2 order by o2->>'created_at' desc) from (
      select jsonb_build_object(
        'id', o.id, 'order_code', o.order_code, 'status', o.status,
        'order_date', o.order_date, 'delivery_date', o.delivery_date,
        'delivery_time_zone', o.delivery_time_zone,
        'total_amount', o.total_amount, 'created_at', o.created_at,
        'temp_zone', o.temp_zone,
        'ship_to_name', case when o.customer_id <> v_id then o.customer_name end,
        'can_doc', (o.customer_id = v_id and o.status in ('発送済','納品完了')),
        'receipt_issued', (select count(*) from portal_document_issues d
                             where d.order_id = o.id and d.doc_type='領収書'),
        'freight', (select sum(s.freight) from shipments s where s.order_id = o.id and s.freight is not null),
        'items', coalesce((select jsonb_agg(jsonb_build_object(
            'name', coalesce(oi.product_name, oi.part_name),
            'species', oi.species,
            'requested_kg', oi.requested_kg,
            'kg', coalesce(oi.allocated_kg, oi.weight_kg, oi.weight),
            'unit_price', oi.unit_price, 'amount', coalesce(oi.amount, oi.subtotal::int))
            order by oi.created_at)
          from order_items oi where oi.order_id = o.id), '[]'::jsonb),
        'shipments', coalesce((select jsonb_agg(jsonb_build_object(
            'shipment_date', s.shipment_date, 'delivery_date', s.delivery_date,
            'status', s.status,
            'tracking_no', substring(s.notes from '(?:^|[^0-9-])([0-9]{4}-?[0-9]{4}-?[0-9]{4})(?![0-9-])'),
            'carrier', s.carrier, 'size_code', s.size_code, 'is_cool', s.is_cool, 'freight', s.freight)
            order by s.shipment_date)
          from shipments s where s.order_id = o.id), '[]'::jsonb)
      ) as o2
      from orders o
      where (o.customer_id = v_id or o.ordered_by_customer_id = v_id) and coalesce(o.status,'') <> 'キャンセル'
      order by o.created_at desc
      limit least(coalesce(p_limit,50), 100)
    ) t), '[]'::jsonb);
end; $function$;

-- 前回の注文・もう一度注文: 自分が頼んだ注文（届け先がお店のもの）も対象にする。
--   いまの関数の本体を読み、持ち主の条件の1か所だけを書き換える（ほかは1文字も変えない）。
--   条件が見つからない・2か所以上あるときは止める（黙って別物にしない）。
do $$
declare v_def text; v_new text; r record;
begin
  for r in select * from (values
      ('portal_rebuild_cart', 'o.id = p_order_id and o.customer_id = v_id)', 'o.id = p_order_id and (o.customer_id = v_id or o.ordered_by_customer_id = v_id))'),
      ('portal_last_order',   'where o.customer_id = v_id and',              'where (o.customer_id = v_id or o.ordered_by_customer_id = v_id) and')
    ) as t(fn, old, new) loop
    select pg_get_functiondef(p.oid) into strict v_def from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = r.fn;
    if position(r.new in v_def) > 0 then continue; end if;   -- 適用済み
    if (length(v_def) - length(replace(v_def, r.old, ''))) / length(r.old) <> 1 then
      raise exception '% の持ち主の条件が1か所ではありません。手で確認してください', r.fn;
    end if;
    execute replace(v_def, r.old, r.new);
  end loop;
end $$;
