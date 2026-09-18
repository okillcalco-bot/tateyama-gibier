-- 物語ページ（s.html）の「精肉した日」: 内臓（レバー・ハツ・タン等）は獲れた日にさばく（2026-09-18 沖）
--
-- これまで processed_date は個体の精肉完了日（processing_done_at）だけを見ていたため、
-- 出店で内臓だけを出す個体（例: やわたんまち 9/19 のレバー T332〜T336）は精肉前で「精肉した日」が空になり、
-- 精肉後は枝肉の日付（数日後）が出て「内臓なのにねかせた」ように見えた。
--
-- 直し（関数の差し替えのみ・テーブル変更なし）
--   tgc_is_organ_part(部位名): 内臓かどうか
--   story_get(p_code):         読んだパックが内臓なら processed_date＝獲れた日、aging_days＝null、processed_kind='organ'
--   story_get_individual(p_label, p_event_id): その出店でこの個体の部位が内臓だけなら同上
--   story_get_event(p_event_id): 個体ごとに同上
--   s.html は processed_kind='organ' のとき見出しを「さばいた日（獲れた日に処理）」にする

create or replace function public.tgc_is_organ_part(p_part text)
returns boolean language sql immutable as $$
  select p_part is not null and p_part ~ '(レバー|ハツ|タン|フワ|マメ|内臓|心臓|肝臓|腎臓|肺|舌|ホルモン)';
$$;

create or replace function public.story_get(p_code text)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_inv record; v_ind record; v_out jsonb; v_parts jsonb; v_voices jsonb;
        v_label text; v_labels text[]; v_many jsonb;
        v_cap jsonb; v_center jsonb; v_leg1 numeric; v_mileage jsonb; v_organ boolean;
begin
  if p_code is null or btrim(p_code) = '' then return null; end if;
  select i.ident_code, i.part_name, i.process_type, i.weight, i.weight_kg,
         i.individual_id, i.individual_code, i.tier, i.processed_at into v_inv
  from inventory i where i.scan_code = btrim(p_code) and i.deleted_at is null limit 1;
  if not found then return null; end if;
  v_organ := tgc_is_organ_part(coalesce(v_inv.process_type, v_inv.part_name));
  if v_inv.individual_id is not null then v_labels := array[v_inv.individual_id];
  elsif v_inv.individual_code is not null then
    select coalesce(array_agg(distinct l.individual_id), '{}') into v_labels
    from processing_log l
    where l.child_ident_code = v_inv.individual_code and l.individual_id is not null;
  else v_labels := '{}'; end if;
  v_label := case when array_length(v_labels, 1) = 1 then v_labels[1] else null end;
  select ind.label_id, ind.species, ind.sex, ind.weight_total, ind.capture_date,
         ind.capture_city, ind.capture_area, ind.capture_method, ind.is_juvenile,
         ind.radiation_test_date, ind.radiation_result, ind.processing_done_at into v_ind
  from individuals ind where ind.label_id = v_label and ind.deleted_at is null limit 1;
  select coalesce(jsonb_agg(jsonb_build_object(
           'label', ind.label_id, 'species', ind.species, 'sex', ind.sex,
           'capture_date', to_char(ind.capture_date, 'YYYY/MM/DD'),
           'place', trim(both ' ' from coalesce(ind.capture_city,'') || ' ' || coalesce(ind.capture_area,'')),
           'method', ind.capture_method, 'radiation_result', ind.radiation_result)
           order by ind.capture_date), '[]'::jsonb) into v_many
  from individuals ind where ind.label_id = any(v_labels) and ind.deleted_at is null;
  if v_label is not null then
    select coalesce(jsonb_agg(jsonb_build_object('part', p.part_name, 'kg', coalesce(p.weight, p.weight_kg))
                              order by p.created_at), '[]'::jsonb) into v_parts
    from inventory p where p.individual_id = v_label and p.deleted_at is null and p.tier = 2;
  else v_parts := '[]'::jsonb; end if;
  if v_label is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
             'nickname', v.nickname, 'rating', v.rating, 'dish', v.dish, 'comment', v.comment,
             'at', to_char(v.created_at at time zone 'Asia/Tokyo','YYYY/MM/DD'))
             order by v.created_at desc), '[]'::jsonb) into v_voices
    from meal_voices v
    where v.individual_label = v_label and v.deleted_at is null and v.published_at is not null;
  else
    select coalesce(jsonb_agg(jsonb_build_object(
             'nickname', v.nickname, 'rating', v.rating, 'dish', v.dish, 'comment', v.comment,
             'at', to_char(v.created_at at time zone 'Asia/Tokyo','YYYY/MM/DD'))
             order by v.created_at desc), '[]'::jsonb) into v_voices
    from meal_voices v
    where v.deleted_at is null and v.published_at is not null
      and v_inv.individual_code is not null
      and v.scan_code in (select i2.scan_code from inventory i2
                          where i2.individual_code = v_inv.individual_code
                            and i2.scan_code is not null and i2.deleted_at is null);
  end if;
  if v_ind.label_id is not null then
    v_cap := tgc_capture_point(v_label);
    select value into v_center from app_settings where key = 'center_location';
    v_leg1 := tgc_km((v_cap->>'lat')::numeric, (v_cap->>'lng')::numeric, (v_center->>'lat')::numeric, (v_center->>'lng')::numeric);
    v_mileage := jsonb_build_object('capture', v_cap, 'center', v_center, 'venue', null,
                                    'leg1_km', v_leg1, 'leg2_km', null, 'total_km', v_leg1);
  end if;
  v_out := jsonb_build_object(
    'scan_code', btrim(p_code),
    'product', jsonb_build_object('name', coalesce(v_inv.process_type, v_inv.part_name),
      'kg', coalesce(v_inv.weight, v_inv.weight_kg), 'ident', v_inv.ident_code),
    'individual', case when v_ind.label_id is null then null else jsonb_build_object(
      'label', v_ind.label_id, 'species', v_ind.species, 'sex', v_ind.sex, 'weight_total', v_ind.weight_total,
      'capture_date', to_char(v_ind.capture_date, 'YYYY/MM/DD'),
      'place', trim(both ' ' from coalesce(v_ind.capture_city,'') || ' ' || coalesce(v_ind.capture_area,'')),
      'method', v_ind.capture_method, 'is_juvenile', v_ind.is_juvenile,
      'radiation_date', to_char(v_ind.radiation_test_date, 'YYYY/MM/DD'),
      'radiation_result', v_ind.radiation_result,
      -- 内臓は獲れた日にさばく。枝肉は精肉完了日（ねかせ日数つき）
      'processed_date', case when v_organ then to_char(v_ind.capture_date, 'YYYY/MM/DD')
                             else to_char(v_ind.processing_done_at at time zone 'Asia/Tokyo', 'YYYY/MM/DD') end,
      'processed_kind', case when v_organ then 'organ' else 'meat' end,
      'aging_days', case when v_organ or v_ind.processing_done_at is null or v_ind.capture_date is null then null
                         else ((v_ind.processing_done_at at time zone 'Asia/Tokyo')::date - v_ind.capture_date) end) end,
    'blend', case when coalesce(array_length(v_labels, 1), 0) > 1 then v_many else null end,
    'parts', v_parts, 'voices', v_voices,
    'mileage', v_mileage);
  return v_out;
end $function$;

create or replace function public.story_get_individual(p_label text, p_event_id uuid default null::uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare v_ind record; v_parts jsonb; v_voices jsonb; v_label text; v_cnt int;
        v_cap jsonb; v_center jsonb; v_ev record; v_sheet record; v_photo text;
        v_leg1 numeric; v_leg2 numeric; v_mileage jsonb; v_has_ev boolean := false; v_organ boolean := false;
begin
  if p_label is null or btrim(p_label) = '' then return null; end if;
  v_label := btrim(p_label);

  select ind.label_id, ind.species, ind.sex, ind.weight_total, ind.capture_date,
         ind.capture_city, ind.capture_area, ind.capture_method, ind.is_juvenile,
         ind.radiation_test_date, ind.radiation_result, ind.processing_done_at, ind.image_url
    into v_ind
  from individuals ind
  where ind.label_id = v_label and ind.deleted_at is null
  limit 1;
  if not found then return null; end if;

  select coalesce(jsonb_agg(jsonb_build_object('part', p.part_name, 'kg', coalesce(p.weight, p.weight_kg))
                            order by p.created_at), '[]'::jsonb)
    into v_parts
  from inventory p
  where p.individual_id = v_label and p.deleted_at is null and p.tier = 2;

  select coalesce(jsonb_agg(jsonb_build_object(
           'nickname', v.nickname, 'rating', v.rating, 'dish', v.dish, 'stamps', v.stamps,
           'comment', v.comment, 'at', to_char(v.created_at at time zone 'Asia/Tokyo','YYYY/MM/DD'))
           order by v.created_at desc), '[]'::jsonb), count(*)
    into v_voices, v_cnt
  from meal_voices v
  where v.individual_label = v_label and v.deleted_at is null and v.published_at is not null;

  -- フードマイレージ: 捕獲地 → センター → 会場（会場は p_event_id のときだけ）
  v_cap := tgc_capture_point(v_label);
  select value into v_center from app_settings where key = 'center_location';
  v_leg1 := tgc_km((v_cap->>'lat')::numeric, (v_cap->>'lng')::numeric, (v_center->>'lat')::numeric, (v_center->>'lng')::numeric);
  select e.id, e.venue_name, e.title, e.event_date, vn.lat as vlat, vn.lng as vlng into v_ev
    from sale_events e left join event_venues vn on vn.id = e.venue_id
   where p_event_id is not null and e.id = p_event_id and e.deleted_at is null;
  v_has_ev := found;
  select s.id, s.product_note, s.story_text, s.photo_path into v_sheet
    from sale_event_sheets s
   where p_event_id is not null and v_has_ev and s.event_id = p_event_id and s.label_id = v_label;
  if v_has_ev then
    v_leg2 := tgc_km((v_center->>'lat')::numeric, (v_center->>'lng')::numeric, v_ev.vlat, v_ev.vlng);
    -- この出店でこの個体から出すのが内臓だけなら「さばいた日」＝獲れた日
    select count(*) > 0 and bool_and(tgc_is_organ_part(i.part_name)) into v_organ
      from sale_event_items i where i.event_id = p_event_id and i.individual_label = v_label and i.kind = 'inventory';
    v_organ := coalesce(v_organ, false);
  end if;
  v_mileage := jsonb_build_object(
    'capture', v_cap, 'center', v_center,
    'venue', case when v_has_ev then jsonb_build_object('name', v_ev.venue_name, 'lat', v_ev.vlat, 'lng', v_ev.vlng) else null end,
    'leg1_km', v_leg1, 'leg2_km', v_leg2,
    'total_km', case when v_leg1 is null then null else v_leg1 + coalesce(v_leg2, 0) end);

  v_photo := case when v_sheet.photo_path is not null
                  then 'https://clpdyrehdgzgiidbfucj.supabase.co/storage/v1/object/public/field-photos/' || v_sheet.photo_path
                  else v_ind.image_url end;

  return jsonb_build_object(
    'individual_label', v_ind.label_id,
    'product', null,
    'individual', jsonb_build_object(
      'label', v_ind.label_id, 'species', v_ind.species, 'sex', v_ind.sex,
      'weight_total', v_ind.weight_total,
      'capture_date', to_char(v_ind.capture_date, 'YYYY/MM/DD'),
      'place', trim(both ' ' from coalesce(v_ind.capture_city,'') || ' ' || coalesce(v_ind.capture_area,'')),
      'method', v_ind.capture_method, 'is_juvenile', v_ind.is_juvenile,
      'radiation_date', to_char(v_ind.radiation_test_date, 'YYYY/MM/DD'),
      'radiation_result', v_ind.radiation_result,
      'processed_date', case when v_organ then to_char(v_ind.capture_date, 'YYYY/MM/DD')
                             else to_char(v_ind.processing_done_at at time zone 'Asia/Tokyo', 'YYYY/MM/DD') end,
      'processed_kind', case when v_organ then 'organ' else 'meat' end,
      'aging_days', case when v_organ or v_ind.processing_done_at is null or v_ind.capture_date is null then null
                         else ((v_ind.processing_done_at at time zone 'Asia/Tokyo')::date - v_ind.capture_date) end),
    'parts', v_parts,
    'voices', v_voices,
    'voice_count', v_cnt,
    'photo', v_photo,
    'sheet', case when v_sheet.id is not null then jsonb_build_object('product_note', v_sheet.product_note, 'story_text', v_sheet.story_text) else null end,
    'event', case when v_has_ev then jsonb_build_object('id', v_ev.id, 'venue', v_ev.venue_name, 'title', v_ev.title,
                    'date', to_char(v_ev.event_date, 'YYYY/MM/DD')) else null end,
    'mileage', v_mileage);
end $function$;

create or replace function public.story_get_event(p_event_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public'
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
      'processed_date', case when o.organ_only then to_char(ind.capture_date, 'YYYY/MM/DD')
                             else to_char(ind.processing_done_at at time zone 'Asia/Tokyo', 'YYYY/MM/DD') end,
      'processed_kind', case when o.organ_only then 'organ' else 'meat' end,
      'aging_days', case when o.organ_only or ind.processing_done_at is null or ind.capture_date is null then null
                         else ((ind.processing_done_at at time zone 'Asia/Tokyo')::date - ind.capture_date) end,
      'parts', (select coalesce(jsonb_agg(distinct i2.part_name), '[]'::jsonb) from sale_event_items i2
                where i2.event_id = p_event_id and i2.individual_label = ind.label_id)) x, ind.label_id
    from sale_event_items i
    join individuals ind on ind.label_id = i.individual_label and ind.deleted_at is null
    join lateral (select bool_and(tgc_is_organ_part(i3.part_name)) as organ_only
                    from sale_event_items i3 where i3.event_id = p_event_id and i3.individual_label = ind.label_id and i3.kind = 'inventory') o on true
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
