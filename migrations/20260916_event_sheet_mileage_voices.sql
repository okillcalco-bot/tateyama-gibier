-- 出店の個体シート・フードマイレージ・感想の即掲載（追加のみ）2026-09-16
--
-- やわたんまち（9/19・20）で「いま食べているのがどんな一頭か」を A4横 1個体1枚で見せ、
-- QR から詳細と感想欄へ。感想は特典ではなく「あなたの一言がこの一頭の記録の最後の行になる」
-- という意味づけで書いてもらう。フードマイレージ（捕獲地→センター→会場の距離）も出す。
--
--   area_master.lat/lng     … 地区の代表点（捕獲地の位置。個体に緯度経度があればそちらを優先）
--   event_venues.lat/lng    … 会場の位置
--   app_settings.center_location … センター（館山市西長田1163-5）の位置
--   sale_event_sheets       … 出店×個体ごとの「今日の商品」「ひとこと」「写真」（後から設定できる）
--   meal_voices.stamps      … スタンプ（うまい！ など。文章を書かなくても残せる）
--   story_get_individual    … mileage / voice_count / photo / sheet を追加（p_event_id で会場までの距離）
--   story_add_voice*        … 即掲載（published_at=now()。あとから非表示にできる）＋ stamps ＋ 何人目か

alter table area_master  add column if not exists lat numeric, add column if not exists lng numeric;
alter table event_venues add column if not exists lat numeric, add column if not exists lng numeric;
alter table meal_voices  add column if not exists stamps text[];

create table if not exists sale_event_sheets (
  id           uuid primary key default gen_random_uuid(),
  event_id     uuid not null references sale_events(id),
  label_id     text not null,
  product_note text,        -- 今日の商品（例: 串焼き＝モモ）
  story_text   text,        -- ひとこと（例: 神余の栗林で獲れた、脂ののった一頭）
  photo_path   text,        -- field-photos バケットのパス（看板写真など）
  updated_at   timestamptz not null default now(),
  unique (event_id, label_id)
);
alter table sale_event_sheets enable row level security;
do $$
begin
  if not exists (select 1 from pg_policy where polname = 'allow_all' and polrelid = 'sale_event_sheets'::regclass) then
    create policy allow_all on sale_event_sheets for all using (true) with check (true);
  end if;
end $$;
grant select, insert, update, delete on sale_event_sheets to anon, authenticated;

-- センターの位置（仮。画面の「距離の設定」で Google マップの座標を貼って直せる）
insert into app_settings (key, value)
values ('center_location', '{"name":"館山ジビエセンター","lat":34.9680,"lng":139.8535,"note":"仮の値。要確認"}'::jsonb)
on conflict (key) do nothing;

-- 2点間の距離（km, 大円距離）
create or replace function tgc_km(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
returns numeric language sql immutable as $$
  select case when lat1 is null or lng1 is null or lat2 is null or lng2 is null then null
    else round((6371.0 * 2 * asin(sqrt(
      power(sin(radians((lat2 - lat1) / 2)), 2)
      + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians((lng2 - lng1) / 2)), 2))))::numeric, 1) end
$$;

-- 個体の位置（個体の緯度経度 → 地区マスタの代表点）
create or replace function tgc_capture_point(p_label text)
returns jsonb language sql stable as $$
  select case
    when ind.capture_lat is not null and ind.capture_lng is not null
      then jsonb_build_object('lat', ind.capture_lat, 'lng', ind.capture_lng, 'src', 'individual')
    else (select jsonb_build_object('lat', am.lat, 'lng', am.lng, 'src', 'area')
            from area_master am
           where am.lat is not null and am.lng is not null
             and (am.city = ind.capture_city or ind.capture_city is null)
             and (am.oaza = ind.capture_area or am.district = ind.capture_area
                  or ind.capture_area like am.oaza || '%' or ind.capture_area like '%' || am.oaza)
           order by (am.oaza = ind.capture_area) desc, am.sort_order limit 1)
  end
  from individuals ind where ind.label_id = p_label and ind.deleted_at is null limit 1
$$;

drop function if exists story_get_individual(text);
create or replace function story_get_individual(p_label text, p_event_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_ind record; v_parts jsonb; v_voices jsonb; v_label text; v_cnt int;
        v_cap jsonb; v_center jsonb; v_ev record; v_sheet record; v_photo text;
        v_leg1 numeric; v_leg2 numeric; v_mileage jsonb; v_has_ev boolean := false;
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
  -- p_event_id が無いときも select を通して record の形を確定させる（未代入の record は参照できないため）
  select e.id, e.venue_name, e.title, e.event_date, vn.lat as vlat, vn.lng as vlng into v_ev
    from sale_events e left join event_venues vn on vn.id = e.venue_id
   where p_event_id is not null and e.id = p_event_id and e.deleted_at is null;
  v_has_ev := found;
  select s.id, s.product_note, s.story_text, s.photo_path into v_sheet
    from sale_event_sheets s
   where p_event_id is not null and v_has_ev and s.event_id = p_event_id and s.label_id = v_label;
  if v_has_ev then
    v_leg2 := tgc_km((v_center->>'lat')::numeric, (v_center->>'lng')::numeric, v_ev.vlat, v_ev.vlng);
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
      'processed_date', to_char(v_ind.processing_done_at at time zone 'Asia/Tokyo', 'YYYY/MM/DD'),
      'aging_days', case when v_ind.processing_done_at is null or v_ind.capture_date is null then null
                         else ((v_ind.processing_done_at at time zone 'Asia/Tokyo')::date - v_ind.capture_date) end),
    'parts', v_parts,
    'voices', v_voices,
    'voice_count', v_cnt,
    'photo', v_photo,
    'sheet', case when v_sheet.id is not null then jsonb_build_object('product_note', v_sheet.product_note, 'story_text', v_sheet.story_text) else null end,
    'event', case when v_has_ev then jsonb_build_object('id', v_ev.id, 'venue', v_ev.venue_name, 'title', v_ev.title,
                    'date', to_char(v_ev.event_date, 'YYYY/MM/DD')) else null end,
    'mileage', v_mileage);
end $$;
grant execute on function story_get_individual(text, uuid) to anon, authenticated;

-- 感想: 即掲載＋スタンプ＋何人目か
drop function if exists story_add_voice_individual(text, text, integer, text, text);
create or replace function story_add_voice_individual(p_label text, p_nickname text, p_rating integer, p_dish text, p_comment text, p_stamps text[] default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare v_label text; v_recent int; v_cnt int; v_stamps text[];
begin
  if p_label is null or btrim(p_label) = '' then
    return jsonb_build_object('ok', false, 'error', '個体番号がありません'); end if;
  v_stamps := (select array_agg(left(btrim(s), 20)) from unnest(coalesce(p_stamps, '{}')) s where btrim(s) <> '');
  if coalesce(btrim(p_comment),'') = '' and p_rating is null and coalesce(array_length(v_stamps, 1), 0) = 0 then
    return jsonb_build_object('ok', false, 'error', '星・スタンプ・感想のどれかを入れてください'); end if;
  if length(coalesce(p_comment,'')) > 1000 or length(coalesce(p_nickname,'')) > 60
     or length(coalesce(p_dish,'')) > 120 or coalesce(array_length(v_stamps, 1), 0) > 8 then
    return jsonb_build_object('ok', false, 'error', '文字数が多すぎます'); end if;
  select ind.label_id into v_label from individuals ind
  where ind.label_id = btrim(p_label) and ind.deleted_at is null limit 1;
  if not found then return jsonb_build_object('ok', false, 'error', 'この個体が見つかりません'); end if;
  select count(*) into v_recent from meal_voices
  where individual_label = v_label and created_at > now() - interval '1 minute';
  if v_recent >= 3 then return jsonb_build_object('ok', false, 'error', '少し時間をおいてからお願いします'); end if;
  insert into meal_voices (scan_code, individual_label, nickname, rating, dish, comment, stamps, published_at)
  values (null, v_label, nullif(btrim(coalesce(p_nickname,'')),''),
          p_rating, nullif(btrim(coalesce(p_dish,'')),''), nullif(btrim(coalesce(p_comment,'')),''),
          nullif(v_stamps, '{}'), now());
  select count(*) into v_cnt from meal_voices where individual_label = v_label and deleted_at is null and published_at is not null;
  return jsonb_build_object('ok', true, 'voice_count', v_cnt);
end $$;
grant execute on function story_add_voice_individual(text, text, integer, text, text, text[]) to anon, authenticated;

drop function if exists story_add_voice(text, text, integer, text, text);
create or replace function story_add_voice(p_code text, p_nickname text, p_rating integer, p_dish text, p_comment text, p_stamps text[] default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare v_inv record; v_labels text[]; v_label text; v_recent int; v_stamps text[]; v_cnt int;
begin
  if p_code is null or btrim(p_code) = '' then
    return jsonb_build_object('ok', false, 'error', 'コードがありません'); end if;
  v_stamps := (select array_agg(left(btrim(s), 20)) from unnest(coalesce(p_stamps, '{}')) s where btrim(s) <> '');
  if coalesce(btrim(p_comment),'') = '' and p_rating is null and coalesce(array_length(v_stamps, 1), 0) = 0 then
    return jsonb_build_object('ok', false, 'error', '星・スタンプ・感想のどれかを入れてください'); end if;
  if length(coalesce(p_comment,'')) > 1000 or length(coalesce(p_nickname,'')) > 60
     or length(coalesce(p_dish,'')) > 120 or coalesce(array_length(v_stamps, 1), 0) > 8 then
    return jsonb_build_object('ok', false, 'error', '文字数が多すぎます'); end if;
  select i.individual_id, i.individual_code into v_inv
  from inventory i where i.scan_code = btrim(p_code) and i.deleted_at is null limit 1;
  if not found then return jsonb_build_object('ok', false, 'error', 'この番号のお肉が見つかりません'); end if;
  if v_inv.individual_id is not null then v_labels := array[v_inv.individual_id];
  elsif v_inv.individual_code is not null then
    select coalesce(array_agg(distinct l.individual_id), '{}') into v_labels
    from processing_log l where l.child_ident_code = v_inv.individual_code and l.individual_id is not null;
  else v_labels := '{}'; end if;
  v_label := case when array_length(v_labels, 1) = 1 then v_labels[1] else null end;
  select count(*) into v_recent from meal_voices
  where scan_code = btrim(p_code) and created_at > now() - interval '1 minute';
  if v_recent >= 3 then return jsonb_build_object('ok', false, 'error', '少し時間をおいてからお願いします'); end if;
  insert into meal_voices (scan_code, individual_label, nickname, rating, dish, comment, stamps, published_at)
  values (btrim(p_code), v_label, nullif(btrim(coalesce(p_nickname,'')),''),
          p_rating, nullif(btrim(coalesce(p_dish,'')),''), nullif(btrim(coalesce(p_comment,'')),''),
          nullif(v_stamps, '{}'), now());
  select count(*) into v_cnt from meal_voices
   where deleted_at is null and published_at is not null
     and (scan_code = btrim(p_code) or (v_label is not null and individual_label = v_label));
  return jsonb_build_object('ok', true, 'voice_count', v_cnt);
end $$;
grant execute on function story_add_voice(text, text, integer, text, text, text[]) to anon, authenticated;
