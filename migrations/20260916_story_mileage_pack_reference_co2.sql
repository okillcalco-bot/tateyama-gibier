-- 消費者向けフードマイレージ表示の改善（追加のみ）2026-09-16
--
--   1) story_get(p_code) … パックのQR（?c=）から開いたときにも 'mileage' を返す
--      （捕獲地点→センターのみ。販売・提供地点は将来）。既存のキーは一切変えない。
--   2) app_settings 'mileage_reference' … 消費者向け「どれくらい近い？ 参考比較」の比較対象
--      （name / km / source / sourceUrl / calculationNote / kind）。管理画面（フードマイレージ解析）から編集できる
--   3) app_settings 'co2_factors' … 推定輸送CO2の係数（key / name / value / unit / source / sourceUrl / updated_at / note）
--      ハードコードせず、ここから読む。
--
-- 距離（km）とフードマイレージ（重量×距離 = t·km / kg·km）は別の指標として扱う。
-- 参考比較の値はいずれも「産地の代表点〜館山ジビエセンターの大円距離（直線）の概算」で、出典が確認できない
-- 確定値ではないことを kind='estimate' で示す。

create or replace function public.story_get(p_code text)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $function$
declare v_inv record; v_ind record; v_out jsonb; v_parts jsonb; v_voices jsonb;
        v_label text; v_labels text[]; v_many jsonb;
        v_cap jsonb; v_center jsonb; v_leg1 numeric; v_mileage jsonb;
begin
  if p_code is null or btrim(p_code) = '' then return null; end if;
  select i.ident_code, i.part_name, i.process_type, i.weight, i.weight_kg,
         i.individual_id, i.individual_code, i.tier, i.processed_at into v_inv
  from inventory i where i.scan_code = btrim(p_code) and i.deleted_at is null limit 1;
  if not found then return null; end if;
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
  -- フードマイレージ（捕獲地点→センターのみ。販売・提供地点はパックからは分からないので null）
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
      'processed_date', to_char(v_ind.processing_done_at at time zone 'Asia/Tokyo', 'YYYY/MM/DD'),
      'aging_days', case when v_ind.processing_done_at is null or v_ind.capture_date is null then null
                         else ((v_ind.processing_done_at at time zone 'Asia/Tokyo')::date - v_ind.capture_date) end) end,
    'blend', case when coalesce(array_length(v_labels, 1), 0) > 1 then v_many else null end,
    'parts', v_parts, 'voices', v_voices,
    'mileage', v_mileage);
  return v_out;
end $function$;

-- 参考比較（消費者向け）。値は概算（kind=estimate）。管理画面から変更できる
insert into app_settings (key, value) values ('mileage_reference', '{
  "title": "どれくらい近い？ 参考比較",
  "note": "一般的な輸送距離の参考値・概算です。産地の代表点から館山ジビエセンターまでの直線距離で、実際の船・トラックの経路はこれより長くなります。",
  "items": [
    {"name": "豪州産の牛肉", "km": 6600, "kind": "estimate", "source": "館山ジビエセンター試算（主産地: クイーンズランド州。主な輸入相手国は財務省 貿易統計 2024年による）", "sourceUrl": null, "calculationNote": "産地の代表点〜館山ジビエセンターの大円距離（直線）の概算"},
    {"name": "米国産の豚肉", "km": 9800, "kind": "estimate", "source": "館山ジビエセンター試算（主産地: 中西部）", "sourceUrl": null, "calculationNote": "産地の代表点〜館山ジビエセンターの大円距離（直線）の概算"},
    {"name": "チリ産の豚肉", "km": 17200, "kind": "estimate", "source": "館山ジビエセンター試算（産地の代表点: サンティアゴ周辺）", "sourceUrl": null, "calculationNote": "産地の代表点〜館山ジビエセンターの大円距離（直線）の概算"},
    {"name": "鹿児島県産の豚肉", "km": 940, "kind": "estimate", "source": "館山ジビエセンター試算（畜産統計 令和6年 豚飼養頭数 全国1位の県）", "sourceUrl": null, "calculationNote": "県の代表点〜館山ジビエセンターの大円距離（直線）の概算"},
    {"name": "千葉県産（北総）の豚肉", "km": 110, "kind": "estimate", "source": "館山ジビエセンター試算（県内の主産地: 旭市・香取市周辺）", "sourceUrl": null, "calculationNote": "主産地の代表点〜館山ジビエセンターの大円距離（直線）の概算"}
  ]
}'::jsonb) on conflict (key) do nothing;

-- 推定輸送CO2の係数（管理画面用）。ハードコードせずここから読む
insert into app_settings (key, value) values ('co2_factors', '{
  "method": "トンキロ法（輸送重量 t × 輸送距離 km × 排出原単位）",
  "items": [
    {"key": "leg1", "name": "山→センター（自家用の軽トラック）", "value": 1166, "unit": "g-CO2e/t·km", "source": "国土交通省「輸送量当たりの二酸化炭素排出量」自家用貨物車（概数）", "sourceUrl": null, "updated_at": "2026-09-16", "note": "概数。実測ではない"},
    {"key": "leg2", "name": "センター→お客さん（宅配便＝営業用貨物車）", "value": 216, "unit": "g-CO2e/t·km", "source": "国土交通省「輸送量当たりの二酸化炭素排出量」営業用貨物車（概数）", "sourceUrl": null, "updated_at": "2026-09-16", "note": "概数。宅配便は集荷・仕分けを経由するため実距離は直線より長い"}
  ]
}'::jsonb) on conflict (key) do nothing;
