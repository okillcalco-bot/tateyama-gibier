-- 混ざっている商品への感想を、勝手に1頭のものにしない（追加のみ）
--
-- story_get と同じ欠陥が投稿側にもあった。複数頭を混ぜたロットのパックに感想を書くと、
-- processing_log の先頭1頭に紐づいてしまい、その個体のページに
-- 「この一頭を召し上がった方の声」として出てしまう。
--
--   1頭だけのパック … 今までどおり個体に紐づける
--   混ざったロット   … 個体には紐づけず、そのロットへの感想として残す
--                      （表示は同じロットのパック全体でまとめる）

begin;

create or replace function public.story_add_voice(
  p_code text, p_nickname text, p_rating integer, p_dish text, p_comment text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare v_inv record; v_labels text[]; v_label text; v_recent int;
begin
  if p_code is null or btrim(p_code) = '' then
    return jsonb_build_object('ok', false, 'error', 'コードがありません');
  end if;
  if coalesce(btrim(p_comment),'') = '' and p_rating is null then
    return jsonb_build_object('ok', false, 'error', '評価か感想のどちらかを入れてください');
  end if;
  if length(coalesce(p_comment,'')) > 1000 or length(coalesce(p_nickname,'')) > 60
     or length(coalesce(p_dish,'')) > 120 then
    return jsonb_build_object('ok', false, 'error', '文字数が多すぎます');
  end if;

  select i.individual_id, i.individual_code into v_inv
  from inventory i where i.scan_code = btrim(p_code) and i.deleted_at is null limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'この番号のお肉が見つかりません');
  end if;

  if v_inv.individual_id is not null then
    v_labels := array[v_inv.individual_id];
  elsif v_inv.individual_code is not null then
    select coalesce(array_agg(distinct l.individual_id), '{}') into v_labels
    from processing_log l
    where l.child_ident_code = v_inv.individual_code and l.individual_id is not null;
  else
    v_labels := '{}';
  end if;
  -- 混ざっているときは「どの頭か」を決められないので、個体には紐づけない
  v_label := case when array_length(v_labels, 1) = 1 then v_labels[1] else null end;

  select count(*) into v_recent from meal_voices
  where scan_code = btrim(p_code) and created_at > now() - interval '1 minute';
  if v_recent >= 3 then
    return jsonb_build_object('ok', false, 'error', '少し時間をおいてからお願いします');
  end if;

  insert into meal_voices (scan_code, individual_label, nickname, rating, dish, comment)
  values (btrim(p_code), v_label, nullif(btrim(coalesce(p_nickname,'')),''),
          p_rating, nullif(btrim(coalesce(p_dish,'')),''), nullif(btrim(coalesce(p_comment,'')),''));
  return jsonb_build_object('ok', true);
end $function$;

-- 表示側: 混ざったロットの感想は、同じロットのパック全体でまとめて出す
create or replace function public.story_get(p_code text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_inv record; v_ind record; v_out jsonb; v_parts jsonb; v_voices jsonb;
        v_label text; v_labels text[]; v_many jsonb;
begin
  if p_code is null or btrim(p_code) = '' then return null; end if;

  select i.ident_code, i.part_name, i.process_type, i.weight, i.weight_kg,
         i.individual_id, i.individual_code, i.tier, i.processed_at into v_inv
  from inventory i where i.scan_code = btrim(p_code) and i.deleted_at is null limit 1;
  if not found then return null; end if;

  if v_inv.individual_id is not null then
    v_labels := array[v_inv.individual_id];
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
      'processed_date', to_char(v_ind.processing_done_at at time zone 'Asia/Tokyo', 'YYYY/MM/DD'),
      'aging_days', case when v_ind.processing_done_at is null or v_ind.capture_date is null then null
                         else ((v_ind.processing_done_at at time zone 'Asia/Tokyo')::date - v_ind.capture_date) end) end,
    'blend', case when coalesce(array_length(v_labels, 1), 0) > 1 then v_many else null end,
    'parts', v_parts, 'voices', v_voices);
  return v_out;
end $function$;

commit;
