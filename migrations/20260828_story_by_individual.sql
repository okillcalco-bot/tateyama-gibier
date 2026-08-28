-- 出店シート用: 「この肉の物語」を個体番号で開けるようにする（追加のみ）
--
-- これまでは s.html?c=<8桁のscan_code> だけ、つまり「そのパック」からしか物語を開けなかった。
-- 出店の会場では、お客様は特定のパックではなく「今日どの個体を食べられるか」を見る。
-- そこで label_id で開ける経路を足す。既存の scan_code 経路はそのまま残す。
--
-- 変更点
--   1) meal_voices.scan_code の NOT NULL を外す（個体から届いた声はパックに紐づかない）
--      代わりに「scan_code か individual_label のどちらかは必ずある」を制約で担保する
--   2) story_get_individual(label)      … 個体の物語を返す
--   3) story_add_voice_individual(...)  … 個体に感想を残す
--   4) story_get に精肉日・ねかせた日数を追加（パック経路の表示も揃える）

begin;

-- 1) 個体から届いた声は scan_code を持たない
alter table meal_voices alter column scan_code drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'meal_voices_source_ck') then
    alter table meal_voices add constraint meal_voices_source_ck
      check (scan_code is not null or individual_label is not null);
  end if;
end $$;

create index if not exists meal_voices_individual_label_idx
  on meal_voices (individual_label) where deleted_at is null;

-- 4) パック経路にも精肉日・ねかせた日数を出す
create or replace function public.story_get(p_code text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_inv record; v_ind record; v_out jsonb; v_parts jsonb; v_voices jsonb; v_label text;
begin
  if p_code is null or btrim(p_code) = '' then return null; end if;

  select i.ident_code, i.part_name, i.process_type, i.weight, i.weight_kg,
         i.individual_id, i.individual_code, i.tier, i.processed_at
    into v_inv
  from inventory i
  where i.scan_code = btrim(p_code) and i.deleted_at is null
  limit 1;
  if not found then return null; end if;

  v_label := v_inv.individual_id;
  if v_label is null and v_inv.individual_code is not null then
    select l.individual_id into v_label
    from processing_log l
    where l.child_ident_code = v_inv.individual_code and l.individual_id is not null
    limit 1;
  end if;

  select ind.label_id, ind.species, ind.sex, ind.weight_total, ind.capture_date,
         ind.capture_city, ind.capture_area, ind.capture_method, ind.is_juvenile,
         ind.radiation_test_date, ind.radiation_result, ind.processing_done_at
    into v_ind
  from individuals ind
  where ind.label_id = v_label and ind.deleted_at is null
  limit 1;

  select coalesce(jsonb_agg(jsonb_build_object('part', p.part_name, 'kg', coalesce(p.weight, p.weight_kg))
                            order by p.created_at), '[]'::jsonb)
    into v_parts
  from inventory p
  where p.individual_id = v_label and p.deleted_at is null and p.tier = 2;

  select coalesce(jsonb_agg(jsonb_build_object(
           'nickname', v.nickname, 'rating', v.rating, 'dish', v.dish,
           'comment', v.comment, 'at', to_char(v.created_at at time zone 'Asia/Tokyo','YYYY/MM/DD'))
           order by v.created_at desc), '[]'::jsonb)
    into v_voices
  from meal_voices v
  where v.individual_label = v_label
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
    'parts', v_parts,
    'voices', v_voices);
  return v_out;
end $function$;

-- 2) 個体番号で物語を開く（出店シートのQRの行き先）
create or replace function public.story_get_individual(p_label text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_ind record; v_parts jsonb; v_voices jsonb; v_label text;
begin
  if p_label is null or btrim(p_label) = '' then return null; end if;
  v_label := btrim(p_label);

  select ind.label_id, ind.species, ind.sex, ind.weight_total, ind.capture_date,
         ind.capture_city, ind.capture_area, ind.capture_method, ind.is_juvenile,
         ind.radiation_test_date, ind.radiation_result, ind.processing_done_at
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
           'nickname', v.nickname, 'rating', v.rating, 'dish', v.dish,
           'comment', v.comment, 'at', to_char(v.created_at at time zone 'Asia/Tokyo','YYYY/MM/DD'))
           order by v.created_at desc), '[]'::jsonb)
    into v_voices
  from meal_voices v
  where v.individual_label = v_label
    and v.deleted_at is null
    and v.published_at is not null;

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
      'processed_date', to_char(v_ind.processing_done_at at time zone 'Asia/Tokyo', 'YYYY/MM/DD'),
      'aging_days', case when v_ind.processing_done_at is null or v_ind.capture_date is null then null
                         else ((v_ind.processing_done_at at time zone 'Asia/Tokyo')::date - v_ind.capture_date) end),
    'parts', v_parts,
    'voices', v_voices);
end $function$;

-- 3) 個体に感想を残す（承認するまで公開されないのは既存と同じ）
create or replace function public.story_add_voice_individual(
  p_label text, p_nickname text, p_rating integer, p_dish text, p_comment text)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $function$
declare v_label text; v_recent int;
begin
  if p_label is null or btrim(p_label) = '' then
    return jsonb_build_object('ok', false, 'error', '個体番号がありません');
  end if;
  if coalesce(btrim(p_comment),'') = '' and p_rating is null then
    return jsonb_build_object('ok', false, 'error', '評価か感想のどちらかを入れてください');
  end if;
  if length(coalesce(p_comment,'')) > 1000 or length(coalesce(p_nickname,'')) > 60
     or length(coalesce(p_dish,'')) > 120 then
    return jsonb_build_object('ok', false, 'error', '文字数が多すぎます');
  end if;

  select ind.label_id into v_label from individuals ind
  where ind.label_id = btrim(p_label) and ind.deleted_at is null limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'この個体が見つかりません');
  end if;

  select count(*) into v_recent from meal_voices
  where individual_label = v_label and created_at > now() - interval '1 minute';
  if v_recent >= 3 then
    return jsonb_build_object('ok', false, 'error', '少し時間をおいてからお願いします');
  end if;

  insert into meal_voices (scan_code, individual_label, nickname, rating, dish, comment)
  values (null, v_label, nullif(btrim(coalesce(p_nickname,'')),''),
          p_rating, nullif(btrim(coalesce(p_dish,'')),''), nullif(btrim(coalesce(p_comment,'')),''));
  return jsonb_build_object('ok', true);
end $function$;

grant execute on function public.story_get_individual(text) to anon, authenticated;
grant execute on function public.story_add_voice_individual(text, text, integer, text, text) to anon, authenticated;

commit;
