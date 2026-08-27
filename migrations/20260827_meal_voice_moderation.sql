-- 食べた人の声を「承認してから公開」にする（追加のみ）
--
-- 変更前: story_add_voice で入った感想が、その瞬間から全員に見えていた。
-- 変更後: 入った直後は未公開。業務アプリで中身を見て「公開する」を押したものだけが
--         物語ページに出る。
--
-- 状態の見分け方（列を足すだけ・既存行は触らない）
--   published_at is null かつ deleted_at is null … 未処理（保留中）
--   published_at is not null                     … 公開中
--   deleted_at   is not null                     … 却下（表に出さない。記録は残す）

alter table meal_voices add column if not exists published_at timestamptz;
alter table meal_voices add column if not exists published_by text;
alter table meal_voices add column if not exists moderated_at  timestamptz;
alter table meal_voices add column if not exists moderated_by  text;

create index if not exists meal_voices_pending_idx
  on meal_voices (created_at desc)
  where published_at is null and deleted_at is null;

-- ── 公開ページ: 公開済みの声だけを返す ──────────────────────────
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

  -- 加工品は個体が直接ぶら下がらないので、加工ログから元の個体をたどる
  v_label := v_inv.individual_id;
  if v_label is null and v_inv.individual_code is not null then
    select l.individual_id into v_label
    from processing_log l
    where l.child_ident_code = v_inv.individual_code and l.individual_id is not null
    limit 1;
  end if;

  select ind.label_id, ind.species, ind.sex, ind.weight_total, ind.capture_date,
         ind.capture_city, ind.capture_area, ind.capture_method, ind.is_juvenile,
         ind.radiation_test_date, ind.radiation_result
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
    and v.published_at is not null;      -- ★承認されたものだけ

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
      'radiation_result', v_ind.radiation_result) end,
    'parts', v_parts,
    'voices', v_voices);
  return v_out;
end $function$;

-- ── 業務アプリ: 承認待ちの一覧 ────────────────────────────────
create or replace function public.staff_voices_list(p_status text default 'pending', p_limit int default 200)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare v_st text := coalesce(nullif(btrim(p_status), ''), 'pending');
begin
  if v_st not in ('pending','published','rejected','all') then
    raise exception '状態の指定が不正です: %', v_st;
  end if;
  return coalesce((
    select jsonb_agg(x order by x->>'at' desc)
    from (
      select jsonb_build_object(
        'id', v.id,
        'scan_code', v.scan_code,
        'individual_label', v.individual_label,
        'nickname', v.nickname, 'rating', v.rating, 'dish', v.dish, 'comment', v.comment,
        'at', to_char(v.created_at at time zone 'Asia/Tokyo','YYYY/MM/DD HH24:MI'),
        'status', case when v.deleted_at is not null then 'rejected'
                       when v.published_at is not null then 'published'
                       else 'pending' end,
        'moderated_by', v.moderated_by,
        -- どの肉についての声か（承認する人が中身を判断できるように）
        'product', (select coalesce(i.process_type, i.part_name) from inventory i
                     where i.scan_code = v.scan_code limit 1)
      ) as x
      from meal_voices v
      where (v_st = 'all')
         or (v_st = 'pending'   and v.published_at is null     and v.deleted_at is null)
         or (v_st = 'published' and v.published_at is not null and v.deleted_at is null)
         or (v_st = 'rejected'  and v.deleted_at is not null)
      order by v.created_at desc
      limit greatest(1, least(coalesce(p_limit, 200), 1000))
    ) s
  ), '[]'::jsonb);
end $$;

-- ── 業務アプリ: 公開する／取り下げる／却下する ────────────────
create or replace function public.staff_voice_moderate(p_id uuid, p_action text, p_by text default null)
returns jsonb
language plpgsql security definer set search_path to 'public'
as $$
declare v_act text := btrim(coalesce(p_action,'')); v_n int;
begin
  if p_id is null then raise exception '対象が指定されていません'; end if;
  if v_act not in ('publish','unpublish','reject','restore') then
    raise exception '操作の指定が不正です: %', v_act;
  end if;

  if v_act = 'publish' then
    update meal_voices set published_at = now(), published_by = nullif(btrim(coalesce(p_by,'')),''),
           deleted_at = null, moderated_at = now(), moderated_by = nullif(btrim(coalesce(p_by,'')),'')
     where id = p_id;
  elsif v_act = 'unpublish' then
    update meal_voices set published_at = null, published_by = null,
           moderated_at = now(), moderated_by = nullif(btrim(coalesce(p_by,'')),'')
     where id = p_id;
  elsif v_act = 'reject' then
    update meal_voices set deleted_at = now(), published_at = null, published_by = null,
           moderated_at = now(), moderated_by = nullif(btrim(coalesce(p_by,'')),'')
     where id = p_id;
  else  -- restore: 却下を取り消して保留に戻す
    update meal_voices set deleted_at = null, published_at = null, published_by = null,
           moderated_at = now(), moderated_by = nullif(btrim(coalesce(p_by,'')),'')
     where id = p_id;
  end if;

  get diagnostics v_n = row_count;
  if v_n = 0 then raise exception 'その感想は見つかりませんでした'; end if;
  return jsonb_build_object('ok', true, 'action', v_act);
end $$;

grant execute on function public.staff_voices_list(text, int)         to anon, authenticated;
grant execute on function public.staff_voice_moderate(uuid, text, text) to anon, authenticated;
