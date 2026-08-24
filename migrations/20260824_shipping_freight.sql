-- 配送運賃の自動計算（追加のみ・非破壊）。
-- ヤマト運輸の契約運賃表（合同会社アルコ・関東エリア発・税抜）をマスタ化し、
-- 届け先住所の都道府県 → 発送エリア → サイズ から運賃を自動算出する。基本はクール便。
-- 佐川急便は運賃表の提供待ち（carrier='佐川' の行は未投入＝計算結果 null）。

-- 1) 運賃マスタ（業者 × 発送エリア × サイズ → 基本運賃・クール加算、いずれも税抜円）
create table if not exists public.shipping_rates (
  carrier        text not null,
  area           text not null,          -- 発送先エリア（北海道/北東北/…/沖縄）
  size_code      int  not null,          -- 宅急便サイズ（60/80/100/120/140/160/180/200）
  base_fee       int  not null,          -- 基本運賃（税抜）
  cool_surcharge int,                    -- クール加算（税抜）。null=そのサイズはクール不可
  primary key (carrier, area, size_code)
);
revoke all on public.shipping_rates from anon, authenticated;
grant select on public.shipping_rates to anon, authenticated;

-- ヤマト運輸 契約運賃（関東発・税抜）投入
delete from public.shipping_rates where carrier = 'ヤマト';
with fees(size_code, cool, arr) as (values
  (60,  250, array[850,620,550,550,550,550,550,620,700,700,850,1320]),
  (80,  300, array[1020,790,720,720,720,720,720,790,880,880,1020,1880]),
  (100, 400, array[1210,970,900,900,900,900,900,970,1010,1010,1210,2460]),
  (120, 650, array[1400,1160,1090,1090,1090,1090,1090,1160,1240,1240,1400,3050]),
  (140, null,array[1600,1370,1290,1290,1290,1290,1290,1370,1440,1440,1600,3660]),
  (160, null,array[1790,1560,1480,1480,1480,1480,1480,1560,1630,1630,1790,4250]),
  (180, null,array[3750,3390,2780,2780,2780,2780,2780,3390,3510,3510,3750,5450]),
  (200, null,array[4350,3990,3380,3380,3380,3380,3380,3990,4110,4110,4350,6150])
),
areas(idx, area) as (values
  (1,'北海道'),(2,'北東北'),(3,'南東北'),(4,'関東'),(5,'信越'),(6,'北陸'),
  (7,'中部'),(8,'関西'),(9,'中国'),(10,'四国'),(11,'九州'),(12,'沖縄')
)
insert into public.shipping_rates(carrier, area, size_code, base_fee, cool_surcharge)
select 'ヤマト', a.area, f.size_code, f.arr[a.idx], f.cool
from fees f cross join areas a;

-- 2) 住所文字列から都道府県を取り出す
create or replace function public.tgc_addr_pref(p_address text)
returns text language sql immutable set search_path to 'public' as $$
  select substring(coalesce(p_address,'') from '(東京都|北海道|京都府|大阪府|[一-龠]{2,3}県)');
$$;

-- 3) 都道府県 → ヤマト発送エリア
create or replace function public.tgc_pref_area(p_pref text)
returns text language sql immutable set search_path to 'public' as $$
  select case
    when p_pref = '北海道' then '北海道'
    when p_pref in ('青森県','岩手県','秋田県') then '北東北'
    when p_pref in ('宮城県','山形県','福島県') then '南東北'
    when p_pref in ('茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県','山梨県') then '関東'
    when p_pref in ('新潟県','長野県') then '信越'
    when p_pref in ('富山県','石川県','福井県') then '北陸'
    when p_pref in ('岐阜県','静岡県','愛知県','三重県') then '中部'
    when p_pref in ('滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県') then '関西'
    when p_pref in ('鳥取県','島根県','岡山県','広島県','山口県') then '中国'
    when p_pref in ('徳島県','香川県','愛媛県','高知県') then '四国'
    when p_pref in ('福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県') then '九州'
    when p_pref = '沖縄県' then '沖縄'
    else null
  end;
$$;

-- 4) 運賃計算（税抜）。住所・業者・サイズ・クール有無から。該当なしは null。
create or replace function public.tgc_compute_freight(p_carrier text, p_address text, p_size int, p_is_cool boolean)
returns int language sql stable set search_path to 'public' as $$
  select r.base_fee + case when coalesce(p_is_cool,false) then coalesce(r.cool_surcharge,0) else 0 end
  from public.shipping_rates r
  where r.carrier = p_carrier
    and r.size_code = p_size
    and r.area = public.tgc_pref_area(public.tgc_addr_pref(p_address))
  limit 1;
$$;
grant execute on function public.tgc_compute_freight(text, text, int, boolean) to anon, authenticated;
grant execute on function public.tgc_addr_pref(text) to anon, authenticated;
grant execute on function public.tgc_pref_area(text) to anon, authenticated;

-- 5) shipments に配送情報を追加（業者・サイズ・クール・運賃税抜）
alter table public.shipments add column if not exists carrier   text;
alter table public.shipments add column if not exists size_code int;
alter table public.shipments add column if not exists is_cool   boolean;
alter table public.shipments add column if not exists freight   int;   -- 税抜円。null=未計算/未登録

-- 6) ポータルRPCへ送料を反映：注文履歴の納品情報に配送情報、帳票に送料を載せる。
--    （portal_my_orders / portal_issue_document を 20260824_portal_customer_documents から拡張）
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
            'status', s.status, 'notes', s.notes,
            'carrier', s.carrier, 'size_code', s.size_code, 'is_cool', s.is_cool, 'freight', s.freight)
            order by s.shipment_date)
          from shipments s where s.order_id = o.id), '[]'::jsonb)
      ) as o2
      from orders o
      where o.customer_id = v_id and coalesce(o.status,'') <> 'キャンセル'
      order by o.created_at desc
      limit least(coalesce(p_limit,50), 100)
    ) t), '[]'::jsonb);
end; $$;

create or replace function portal_issue_document(p_token text, p_order_id uuid, p_doc_type text)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  v_cid uuid := portal_session_customer(p_token);
  o record; c record; v_settings jsonb; v_items jsonb;
  v_prior int; v_copy int; v_num text; v_reissue boolean;
  v_freight int; v_carrier text;
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

  -- 送料（税抜）と業者：この注文の発送分を合算
  select sum(s.freight), min(s.carrier) into v_freight, v_carrier
    from shipments s where s.order_id = o.id and s.freight is not null;

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
    'freight', v_freight,           -- 税抜。null=送料未計算
    'freight_carrier', v_carrier,
    'issuer', coalesce(v_settings, '{}'::jsonb)
  );
end; $$;
