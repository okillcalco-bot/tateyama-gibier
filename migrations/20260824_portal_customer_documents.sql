-- 顧客ポータル: 注文履歴・納品情報の閲覧と、請求書・領収書の顧客側出力（追加のみ・非破壊）。
-- 既存のトークン認証 portal_session_customer(p_token) を流用し、本人の注文だけを読める/発行できる。
-- 領収書は発行回数を記録し、2回目以降を「再発行」として扱う。
-- 発行元・振込先・社判・登録番号(インボイス)は app_settings.key='invoice' を流用。
-- 対象は「発送済・納品完了」の注文のみ。金額は税込（ジビエ食肉＝軽減税率8%対象）。

-- 1) 顧客が発行した帳票の記録（主に領収書の再発行判定・監査用）
create table if not exists public.portal_document_issues (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  order_id    uuid not null references public.orders(id)    on delete cascade,
  doc_type    text not null check (doc_type in ('請求書','領収書')),
  doc_number  text,
  copy_no     int  not null default 1,
  issued_at   timestamptz not null default now()
);
create index if not exists idx_portal_doc_issues_lookup
  on public.portal_document_issues(customer_id, order_id, doc_type);

-- 直接アクセス禁止（RPC:SECURITY DEFINER 経由のみ）。RLS有効＋ポリシー無し＝全拒否。
alter table public.portal_document_issues enable row level security;
revoke all on public.portal_document_issues from anon, authenticated;

-- 2) 注文履歴＋納品情報（本人のみ）。既存の portal_my_orders(text,int)（migrations/20260809）を
--    拡張し、納品情報(shipments)・帳票発行可否(can_doc)・領収書発行済み回数(receipt_issued)・
--    delivery_time_zone・memo を追加。キャンセル注文は履歴から除外。既存の項目名は互換維持。
create or replace function portal_my_orders(p_token text, p_limit int default 50)
returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
declare v_id uuid := portal_session_customer(p_token);
begin
  if v_id is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(o2 order by o2->>'created_at' desc) from (
      select jsonb_build_object(
        'id', o.id, 'order_code', o.order_code, 'status', o.status,
        'order_date', o.order_date, 'delivery_date', o.delivery_date,
        'delivery_time_zone', o.delivery_time_zone,
        'total_amount', o.total_amount, 'memo', o.memo, 'created_at', o.created_at,
        'can_doc', (o.status in ('発送済','納品完了')),
        'receipt_issued', (select count(*) from portal_document_issues d
                             where d.order_id = o.id and d.doc_type='領収書'),
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
            'status', s.status, 'notes', s.notes) order by s.shipment_date)
          from shipments s where s.order_id = o.id), '[]'::jsonb)
      ) as o2
      from orders o
      where o.customer_id = v_id and coalesce(o.status,'') <> 'キャンセル'
      order by o.created_at desc
      limit least(coalesce(p_limit,50), 100)
    ) t), '[]'::jsonb);
end; $$;

-- 3) 請求書・領収書の発行（本人・発送済/納品完了のみ）。領収書は再発行を記録・判定。
create or replace function portal_issue_document(p_token text, p_order_id uuid, p_doc_type text)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  v_cid uuid := portal_session_customer(p_token);
  o record; c record; v_settings jsonb; v_items jsonb;
  v_prior int; v_copy int; v_num text; v_reissue boolean;
begin
  if v_cid is null then raise exception 'ログインし直してください'; end if;
  if p_doc_type not in ('請求書','領収書') then raise exception 'invalid doc_type'; end if;
  perform portal_session_touch(p_token);

  select * into o from orders where id = p_order_id and customer_id = v_cid;
  if not found then raise exception '注文が見つかりません'; end if;
  if coalesce(o.status,'') not in ('発送済','納品完了') then
    raise exception 'この注文はまだ発送前のため発行できません';
  end if;

  select * into c from customers where id = v_cid;
  select value into v_settings from app_settings where key = 'invoice';

  select coalesce(jsonb_agg(jsonb_build_object(
      'name', coalesce(nullif(i.product_name,''), nullif(trim(coalesce(i.species,'')||' '||coalesce(i.part_name,'')),'')),
      'qty', coalesce(i.weight_kg, i.allocated_kg, i.weight),
      'unit_price', i.unit_price,
      'subtotal', coalesce(i.subtotal, i.amount)
    )), '[]'::jsonb) into v_items
  from order_items i where i.order_id = o.id;

  -- 発行回数（この注文・この帳票種別）。領収書は2回目以降を再発行扱い。
  select count(*) into v_prior from portal_document_issues d
    where d.order_id = o.id and d.doc_type = p_doc_type;
  v_copy := v_prior + 1;
  v_reissue := (p_doc_type = '領収書' and v_prior >= 1);
  v_num := (case p_doc_type when '請求書' then 'INV' else 'RCP' end)
           || '-' || coalesce(o.order_code, left(o.id::text, 8))
           || case when v_copy > 1 then '-' || v_copy::text else '' end;

  insert into portal_document_issues(customer_id, order_id, doc_type, doc_number, copy_no)
    values (v_cid, o.id, p_doc_type, v_num, v_copy);

  return jsonb_build_object(
    'doc_type', p_doc_type,
    'doc_number', v_num,
    'reissue', v_reissue,
    'copy_no', v_copy,
    'issue_date', to_char(now() at time zone 'Asia/Tokyo', 'YYYY-MM-DD'),
    'order_code', o.order_code,
    'delivery_date', o.delivery_date,
    'customer', jsonb_build_object(
       'name', coalesce(nullif(c.company1,''), c.name),
       'honorific', coalesce(nullif(c.honorific,''), '様'),
       'address', nullif(trim(coalesce(c.address,'')||' '||coalesce(c.building,'')), '')
    ),
    'items', v_items,
    'total', coalesce(o.total_amount, 0),
    'issuer', coalesce(v_settings, '{}'::jsonb)
  );
end; $$;

grant execute on function portal_my_orders(text, int) to anon, authenticated;
grant execute on function portal_issue_document(text, uuid, text) to anon;
