-- ロールバック: 20260818_portal_full_catalog

-- 4. 相談メモ
drop function if exists admin_set_inquiry_status(text,uuid,text);
drop function if exists admin_list_inquiries(text,text);
drop function if exists portal_submit_inquiry(text,text,text);
drop table if exists portal_inquiries;

-- 3. 追加したポータル商品を削除（price/parts はFK cascade）
delete from portal_products
 where (species='イノシシ' and display_name in
        ('猪タン（舌）','猪ハツ（心臓）','猪レバ（肝臓）','猪フワ（肺）','猪マメ（腎臓）','猪チレ（脾臓）',
         '猪赤つなぎセット','猪枝肉（一頭分・ご希望）'))
    or (species='シカ' and display_name in
        ('鹿枝肉（一頭分・ご希望）','鹿ロース','鹿モモ','鹿肩ロース','鹿カタ（ウデ）','鹿ネック',
         '鹿バラ','鹿スネ','鹿ヒレ','鹿ミンチ'))
    or (species='中型獣' and display_name='中型獣 枝肉（一頭分・ご希望）');

-- 作り直し前に消した既存シカ2件（価格未設定・非表示）を復元
insert into portal_products (id, species, display_name, grade_label, sort_order, portal_visible, is_orderable, is_active)
values ('c767055a-0cdd-4371-829c-5e7134bc7328','シカ','鹿ロース','並',210,false,false,true),
       ('48162070-b9c1-495d-acc3-7e867b72ee49','シカ','鹿モモ（ウチ）','並',220,false,false,true)
on conflict (id) do nothing;
insert into portal_product_parts (product_id, part_name, grade) values
 ('c767055a-0cdd-4371-829c-5e7134bc7328','ロース','並'),
 ('48162070-b9c1-495d-acc3-7e867b72ee49','モモ（ウチ）','並')
on conflict do nothing;

-- 2. price_master を戻す
delete from price_master where part_name='枝肉（全体）' and species in ('イノシシ','シカ','中型獣');
update price_master set grade='上' where species in ('シカ','中型獣');
-- ①内臓: grade 上へ、6品は 1000/1000/1000 に、赤つなぎは元から1000/500/300
update price_master set grade='上' where species='イノシシ' and barcode_num in ('112','113','114','115','116','117','118');
update price_master set price_local=1000, price_startmember=1000
 where species='イノシシ' and barcode_num in ('113','114','115','116','117','118');

-- 1. portal_catalog を always_available 無しの元定義へ
create or replace function public.portal_catalog(p_token text)
 returns table(product_id uuid, species text, display_name text, grade_label text, description text,
   sort_order integer, min_order_kg numeric, step_kg numeric, mark text, unit_price integer,
   price_source text, is_orderable boolean, is_favorite boolean)
 language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_id uuid := portal_session_customer(p_token); v_rank text;
begin
  if v_id is null then return; end if;
  select c.price_rank into v_rank from customers c where c.id = v_id;
  return query
  select p.id, p.species, p.display_name, p.grade_label, p.description, p.sort_order,
         p.min_order_kg, p.step_kg,
         case when coalesce(s.kg,0) >= p.low_kg then '◎'
              when coalesce(s.kg,0) >= p.min_order_kg then '△' else '×' end,
         pr.unit_price, pr.price_source,
         (p.is_orderable and pr.unit_price is not null),
         exists (select 1 from customer_saved_items f
                  where f.customer_id = v_id and f.kind = 'favorite' and f.product_id = p.id)
    from portal_products p
    left join lateral (
      select sum(coalesce(i.weight_kg, i.weight)) as kg
        from portal_product_parts pp
        join inventory i on i.deleted_at is null and i.status = '在庫'
         and i.species = p.species and i.part_name = pp.part_name
         and (pp.grade is null or i.grade = pp.grade)
       where pp.product_id = p.id) s on true
    left join lateral (select * from resolve_unit_price(v_id, p.id)) pr on true
   where p.is_active and p.portal_visible
     and (p.visible_ranks is null or coalesce(v_rank,'standard') = any(p.visible_ranks))
   order by p.sort_order, p.display_name;
end;
$function$;

alter table portal_products drop column if exists always_available;
