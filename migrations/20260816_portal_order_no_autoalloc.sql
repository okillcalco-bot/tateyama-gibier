-- 20260816_portal_order_no_autoalloc.sql
-- 注文時の自動在庫引当を廃止する。注文は「希望リスト」として受け、金額は概算（希望kg×単価）で記録。
--   ・在庫パックの確保（allocate_for_order_item）は呼ばない → パックは '在庫' のまま。
--   ・スタッフが注文状況を見てから、出荷処理で在庫商品を手動引当する運用に一本化。
--   ・在庫が無い商品（×）も「希望（お取り寄せ）」として注文可能（product.is_orderable かつ価格ありが条件）。
--   ・allocated_kg / weight_kg は null（未割当）。amount/subtotal は概算。
--   ・完了画面は「確保・確定」ではなく「受注・概算（後日センターで確定）」を表示する（クライアント側で対応）。
-- 前提: portal_products / resolve_unit_price / orders / order_items は既存のまま。

begin;

create or replace function public.portal_place_order(p_token text, p_items jsonb, p_delivery_date date, p_time_zone text DEFAULT NULL::text, p_memo text DEFAULT NULL::text, p_request_id text DEFAULT NULL::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare
  v_cid uuid := portal_session_customer(p_token);
  v_cust customers%rowtype;
  v_order_id uuid; v_code text;
  it jsonb; v_prod portal_products%rowtype;
  v_kg numeric; v_rkg numeric; v_price int; v_src text; v_rank_applied text;
  v_item_id uuid; v_amount int; v_total int := 0;
  v_lines jsonb := '[]'::jsonb; v_n int := 0;
  v_dup record;
begin
  if v_cid is null then raise exception 'ログインし直してください'; end if;
  perform portal_session_touch(p_token);
  select * into v_cust from customers where id = v_cid;

  -- 冪等: 同じ request_id は既存注文をそのまま返す（二重注文防止）
  if p_request_id is not null and length(p_request_id) between 8 and 64 then
    select o.id, o.order_code, o.total_amount into v_dup
      from orders o where o.client_request_id = p_request_id and o.customer_id = v_cid;
    if v_dup.id is not null then
      return jsonb_build_object('order_id', v_dup.id, 'order_code', v_dup.order_code,
        'total_amount', v_dup.total_amount, 'duplicate', true, 'estimated', true,
        'items', coalesce((select jsonb_agg(jsonb_build_object(
            'name', oi.product_name, 'requested_kg', oi.requested_kg,
            'allocated_kg', oi.allocated_kg, 'unit_price', oi.unit_price,
            'price_source', oi.price_source, 'amount', oi.amount) order by oi.created_at)
          from order_items oi where oi.order_id = v_dup.id), '[]'::jsonb));
    end if;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception '商品を選んでください'; end if;
  if jsonb_array_length(p_items) > 20 then
    raise exception '一度に注文できるのは20品目までです'; end if;
  if p_delivery_date is null or p_delivery_date < current_date then
    raise exception '納品希望日を確認してください'; end if;
  if p_delivery_date > current_date + 60 then
    raise exception '納品希望日は60日先までで指定してください'; end if;
  if length(coalesce(p_memo,'')) > 500 then
    raise exception '備考は500文字までにしてください'; end if;

  v_code := 'ORD-' || to_char(now() at time zone 'Asia/Tokyo', 'YYYYMMDD-HH24MISS')
            || '-' || upper(substr(encode(extensions.gen_random_bytes(2),'hex'),1,4));
  insert into orders (order_code, customer_id, customer_name, status, order_date,
                      delivery_date, delivery_time_zone, delivery_address, delivery_building,
                      delivery_name, delivery_phone, price_rank, channel, memo, total_amount,
                      client_request_id)
  values (v_code, v_cust.id, v_cust.name, '受注', (now() at time zone 'Asia/Tokyo')::date,
          p_delivery_date, coalesce(nullif(p_time_zone,''), v_cust.default_time_zone, '0000'),
          coalesce(v_cust.address,''), coalesce(v_cust.building,''),
          v_cust.name, coalesce(v_cust.phone,''), coalesce(v_cust.price_rank,'standard'),
          'ポータル', nullif(p_memo,''), 0,
          case when p_request_id is not null and length(p_request_id) between 8 and 64
               then p_request_id end)
  returning id into v_order_id;

  for it in select * from jsonb_array_elements(p_items) loop
    v_n := v_n + 1;
    select * into v_prod from portal_products where id = (it->>'product_id')::uuid;
    if v_prod.id is null then raise exception '%品目め: 商品が見つかりません', v_n; end if;
    -- 在庫の有無は問わない（在庫切れも「希望」として受ける）。商品として注文可＋価格ありのみ確認。
    if not (v_prod.is_active and v_prod.portal_visible and v_prod.is_orderable
            and (v_prod.visible_ranks is null
                 or coalesce(v_cust.price_rank,'standard') = any(v_prod.visible_ranks))) then
      raise exception '「%」は現在ご注文いただけません', v_prod.display_name;
    end if;

    v_kg := (it->>'kg')::numeric;
    if v_kg is null or v_kg <= 0 then
      raise exception '「%」の数量を確認してください', v_prod.display_name; end if;
    if v_kg < v_prod.min_order_kg then
      raise exception '「%」は%kgからご注文いただけます', v_prod.display_name, v_prod.min_order_kg; end if;
    v_rkg := round(v_kg / v_prod.step_kg) * v_prod.step_kg;
    if abs(v_rkg - v_kg) > 0.0005 then
      raise exception '「%」は%kg単位でご注文ください', v_prod.display_name, v_prod.step_kg; end if;

    select r.unit_price, r.price_source, coalesce(r.price_rank_applied, '')
      into v_price, v_src, v_rank_applied
      from resolve_unit_price(v_cust.id, v_prod.id) r;
    if v_price is null then
      raise exception '「%」の価格が設定されていません。センターへお問い合わせください', v_prod.display_name;
    end if;

    -- 希望量のみ記録（未割当）。金額は概算 = 希望kg × 単価。在庫確保はセンターが後で手動で行う。
    insert into order_items (order_id, part_name, species, product_id_v2, product_name,
                             grade_snapshot, price_rank_applied, price_source,
                             unit_price, requested_kg, allocated_kg, weight_kg, weight, amount, subtotal)
    values (v_order_id, v_prod.display_name, v_prod.species, v_prod.id, v_prod.display_name,
            v_prod.grade_label, nullif(v_rank_applied,''), v_src, v_price, v_kg,
            null, null, null, round(v_kg * v_price)::int, round(v_kg * v_price)::int)
    returning id into v_item_id;

    v_amount := round(v_kg * v_price)::int;
    v_total := v_total + v_amount;

    v_lines := v_lines || jsonb_build_object(
      'name', v_prod.display_name, 'requested_kg', v_kg, 'allocated_kg', null,
      'unit_price', v_price, 'price_source', v_src, 'amount', v_amount, 'estimated', true);
  end loop;

  update orders set total_amount = v_total where id = v_order_id;

  return jsonb_build_object('order_id', v_order_id, 'order_code', v_code,
                            'total_amount', v_total, 'items', v_lines,
                            'estimated', true, 'needs_review', false);
end;
$function$;

commit;
