-- 注文ページの履歴に、センターの社内メモを送らない（2026-11-20 注文システムの見直し）
--
-- これまで portal_my_orders は shipments.notes（出荷の備考）と orders.memo をそのまま返していた。
-- 出荷の備考は「手書きメモより起票」「本人の明細から追記起票」などの社内メモで、お客様に見せるものではない。
-- 画面（order.html）は 2026-11-20 から伝票番号だけを出すようにしたが、通信の中身には残っていた。
--
-- 変更: notes と memo を返さない。代わりに notes から伝票番号（12桁の数字。4桁ごとのハイフン区切りも可）だけを取り出した tracking_no を返す。
--   12桁ちょうどに限る（11桁の携帯番号などを伝票番号と取り違えて出さないため）。
--   本番の出荷 336件で試した結果（ロールバック）: notes・memo を含む行 0、伝票番号が取れた行 62（すべて12桁）。
-- それ以外の項目・並び・件数は変えない。表・データは変更しない。
-- 先に order.html（tracking_no を読む版）を本番に反映してから適用する。
create or replace function public.portal_my_orders(p_token text, p_limit integer default 50)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
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
        'can_doc', (o.status in ('発送済','納品完了')),
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
      where o.customer_id = v_id and coalesce(o.status,'') <> 'キャンセル'
      order by o.created_at desc
      limit least(coalesce(p_limit,50), 100)
    ) t), '[]'::jsonb);
end; $function$;
