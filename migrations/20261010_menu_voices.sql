-- お弁当・イベントのメニューから感想を集める（追加のみ）2026-10-10
--
-- きっかけ: 10/11 のイベントのお弁当（からあげ・シュウマイがジビエ）で、食べた人の感想を集めたい。
--   これまでの感想はパックのラベル（8桁）か個体番号に結び付いていたので、
--   「どのパックか分からない料理」からは送れなかった。
--
-- 方針
--   ・voice_menus … 1つのお弁当（イベント）＝1行。料理の一覧（dishes）を持ち、QRは s.html?m=<code>
--     dishes: [{name, note, labels:[個体番号], scan_codes:[8桁]}]
--     使ったお肉の個体・パックが分かれば labels / scan_codes に入れる → 感想がその一頭の記録にも付く（線を通す）
--   ・感想は既存の meal_voices に追記（menu_id を付ける）。送った時点で掲載（出店の感想と同じ）。
--     公開ページには件数・スタンプ・星の集計だけ出し、文章は出さない（職員は「食べた人の声」で読める）
--   ・表は RLS で直接は触らせない。読み書きは下の RPC だけ
--
--   story_get_menu(code)          … 公開ページの表示（料理・集計）
--   story_add_voice_menu(...)     … 感想の登録（1分に30件までの歯止め。行列で一斉に送っても止まらない数）
--   staff_menu_list()/staff_menu_save(key, p) … 職員がメニューを作る・QRを刷る（スタッフキー必須）
--   staff_voices_list             … 「食べた人の声」でお弁当の感想も「🍱 タイトル／料理」と分かるように

create table if not exists voice_menus (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[a-z0-9]{3,16}$'),
  title       text not null,
  event_date  date,
  venue       text,
  dishes      jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
alter table voice_menus enable row level security;

alter table meal_voices add column if not exists menu_id uuid references voice_menus(id);
create index if not exists meal_voices_menu_idx on meal_voices (menu_id) where menu_id is not null;

-- 公開ページ
create or replace function story_get_menu(p_code text)
returns jsonb language plpgsql stable security definer set search_path to 'public'
as $$
declare m voice_menus;
begin
  select * into m from voice_menus where code = lower(btrim(coalesce(p_code,''))) and deleted_at is null;
  if not found then return null; end if;
  return jsonb_build_object(
    'menu', jsonb_build_object('code', m.code, 'title', m.title, 'venue', m.venue,
              'date', to_char(m.event_date, 'YYYY年FMMM月FMDD日')),
    'dishes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', d->>'name', 'note', d->>'note',
        -- 使ったお肉の一頭（分かるときだけ）。捕獲者名・座標は出さない
        'members', coalesce((
          select jsonb_agg(jsonb_build_object('label', ind.label_id, 'species', ind.species,
                   'capture_date', to_char(ind.capture_date, 'YYYY/MM/DD'),
                   'place', nullif(concat_ws(' ', ind.capture_city, ind.capture_area), '')) order by ind.label_id)
            from individuals ind
           where ind.deleted_at is null
             and ind.label_id in (select jsonb_array_elements_text(coalesce(d->'labels','[]'::jsonb)))), '[]'::jsonb),
        'count', (select count(*) from meal_voices v where v.menu_id = m.id and v.dish = d->>'name'
                   and v.deleted_at is null and v.published_at is not null),
        'avg', (select round(avg(v.rating)::numeric, 1) from meal_voices v where v.menu_id = m.id and v.dish = d->>'name'
                   and v.deleted_at is null and v.published_at is not null and v.rating is not null),
        'stamps', coalesce((select jsonb_object_agg(s, n) from (
                    select s, count(*) n from meal_voices v, unnest(v.stamps) s
                     where v.menu_id = m.id and v.dish = d->>'name' and v.deleted_at is null and v.published_at is not null
                     group by s) t), '{}'::jsonb)
      ) order by ord)
      from jsonb_array_elements(m.dishes) with ordinality as x(d, ord)), '[]'::jsonb),
    'voice_count', (select count(*) from meal_voices v where v.menu_id = m.id and v.deleted_at is null and v.published_at is not null)
  );
end $$;
grant execute on function story_get_menu(text) to anon, authenticated;

-- 感想の登録
create or replace function story_add_voice_menu(p_code text, p_dish text, p_nickname text, p_rating integer,
                                                p_comment text, p_stamps text[] default null)
returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare m voice_menus; d jsonb; v_stamps text[]; v_recent int; v_label text; v_scan text; v_cnt int;
begin
  select * into m from voice_menus where code = lower(btrim(coalesce(p_code,''))) and deleted_at is null;
  if not found then return jsonb_build_object('ok', false, 'error', 'このメニューが見つかりません'); end if;
  select x into d from jsonb_array_elements(m.dishes) x where x->>'name' = btrim(coalesce(p_dish,'')) limit 1;
  if d is null then return jsonb_build_object('ok', false, 'error', '料理を選んでください'); end if;
  if p_rating is not null and (p_rating < 1 or p_rating > 5) then
    return jsonb_build_object('ok', false, 'error', '星は1〜5です'); end if;
  v_stamps := (select array_agg(left(btrim(s), 20)) from unnest(coalesce(p_stamps, '{}')) s where btrim(s) <> '');
  if coalesce(btrim(p_comment),'') = '' and p_rating is null and coalesce(array_length(v_stamps, 1), 0) = 0 then
    return jsonb_build_object('ok', false, 'error', '星・スタンプ・感想のどれかを入れてください'); end if;
  if length(coalesce(p_comment,'')) > 1000 or length(coalesce(p_nickname,'')) > 60
     or coalesce(array_length(v_stamps, 1), 0) > 8 then
    return jsonb_build_object('ok', false, 'error', '文字数が多すぎます'); end if;
  select count(*) into v_recent from meal_voices where menu_id = m.id and created_at > now() - interval '1 minute';
  if v_recent >= 30 then return jsonb_build_object('ok', false, 'error', '少し時間をおいてからお願いします'); end if;
  -- 使ったお肉が1頭・1パックと分かっていれば、その一頭の記録にも付ける
  if jsonb_array_length(coalesce(d->'labels','[]'::jsonb)) = 1 then v_label := d->'labels'->>0; end if;
  if jsonb_array_length(coalesce(d->'scan_codes','[]'::jsonb)) = 1 then v_scan := d->'scan_codes'->>0; end if;
  insert into meal_voices (scan_code, individual_label, nickname, rating, dish, comment, stamps, published_at, menu_id)
  values (v_scan, v_label, nullif(btrim(coalesce(p_nickname,'')),''), p_rating, d->>'name',
          nullif(btrim(coalesce(p_comment,'')),''), nullif(v_stamps, '{}'), now(), m.id);
  select count(*) into v_cnt from meal_voices where menu_id = m.id and deleted_at is null and published_at is not null;
  return jsonb_build_object('ok', true, 'voice_count', v_cnt);
end $$;
grant execute on function story_add_voice_menu(text, text, text, integer, text, text[]) to anon, authenticated;

-- 職員: 一覧
create or replace function staff_menu_list(p_staff_key text)
returns jsonb language plpgsql volatile security definer set search_path to 'public'
as $$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'code', m.code, 'title', m.title,
            'event_date', m.event_date, 'venue', m.venue, 'dishes', m.dishes,
            'voice_count', (select count(*) from meal_voices v where v.menu_id = m.id and v.deleted_at is null))
            order by m.event_date desc nulls last, m.created_at desc)
          from voice_menus m where m.deleted_at is null), '[]'::jsonb);
end $$;
grant execute on function staff_menu_list(text) to anon, authenticated;

-- 職員: 作る・直す（コードは自動。料理名を変えると、前の名前で届いた感想とは別集計になる）
create or replace function staff_menu_save(p_staff_key text, p jsonb)
returns jsonb language plpgsql security definer set search_path to 'public'
as $$
declare v_id uuid; v_code text; v_dishes jsonb;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if coalesce(btrim(p->>'title'),'') = '' then raise exception 'タイトルがありません'; end if;
  v_dishes := coalesce((select jsonb_agg(jsonb_build_object(
                 'name', left(btrim(x->>'name'), 40),
                 'note', nullif(left(btrim(coalesce(x->>'note','')), 80), ''),
                 'labels', coalesce(x->'labels', '[]'::jsonb),
                 'scan_codes', coalesce(x->'scan_codes', '[]'::jsonb)))
               from jsonb_array_elements(coalesce(p->'dishes','[]'::jsonb)) x
              where coalesce(btrim(x->>'name'),'') <> ''), '[]'::jsonb);
  if jsonb_array_length(v_dishes) = 0 then raise exception '料理を1つ以上入れてください'; end if;
  if nullif(p->>'id','') is not null then
    update voice_menus set title = btrim(p->>'title'), event_date = nullif(p->>'event_date','')::date,
           venue = nullif(btrim(coalesce(p->>'venue','')),''), dishes = v_dishes, updated_at = now()
     where id = (p->>'id')::uuid and deleted_at is null
     returning id, code into v_id, v_code;
    if v_id is null then raise exception 'メニューが見つかりません'; end if;
  else
    loop
      v_code := 'm' || substr(md5(gen_random_uuid()::text), 1, 6);
      exit when not exists (select 1 from voice_menus where code = v_code);
    end loop;
    insert into voice_menus (code, title, event_date, venue, dishes)
    values (v_code, btrim(p->>'title'), nullif(p->>'event_date','')::date, nullif(btrim(coalesce(p->>'venue','')),''), v_dishes)
    returning id into v_id;
  end if;
  return jsonb_build_object('id', v_id, 'code', v_code);
end $$;
grant execute on function staff_menu_save(text, jsonb) to anon, authenticated;

-- 「食べた人の声」で、お弁当の感想を「🍱 タイトル／料理」と出す（product に入れる。他は変えない）
create or replace function public.staff_voices_list(p_status text DEFAULT 'pending'::text, p_limit integer DEFAULT 200)
 returns jsonb language plpgsql stable security definer set search_path to 'public'
as $function$
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
        'product', coalesce((select coalesce(i.process_type, i.part_name) from inventory i
                     where i.scan_code = v.scan_code limit 1),
                   (select '🍱 ' || m.title from voice_menus m where m.id = v.menu_id))
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
end $function$;

-- 感想の出どころの制約に「お弁当（メニュー）」を足す（パックか個体番号が必須だったため、お弁当の感想が入らなかった）
alter table meal_voices
  drop constraint meal_voices_source_ck,
  add constraint meal_voices_source_ck check (scan_code is not null or individual_label is not null or menu_id is not null);

-- 2026-10-10 データ投入（記録のみ）: 10/11 のジビエ弁当（からあげ・シュウマイ） code=m1011bt → s.html?m=m1011bt
