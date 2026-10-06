-- ============================================================================
-- 飲食店のジビエ料理ギャラリー（2026-10-05）
-- ============================================================================
-- 目的: 「1個体の一生が1本の線で繋がっていること」の最後の区間（料理になった姿）を残す。
--   飲食店が「こんな料理になりました」と写真・説明を投稿 → スタッフが確認して公開 →
--   誰でも見られる dishes.html に、お店の紹介と「使った個体（捕獲地・時期・方法）」付きで載る。
-- 掲載はお店の了承が前提:
--   * お店本人の投稿は、掲載同意のチェックが無いと受け付けない
--   * スタッフ代理の登録（LINEで写真をもらった等）は「了承を得た」チェックと誰が確認したかを残す
--   * お店はいつでも自分の投稿を取り下げられる（取り下げると即非公開）
-- 書込みはすべて SECURITY DEFINER 関数経由。表そのものは anon/authenticated から読めない。
-- 公開ページに出すのは「公開」状態の投稿と、お店が載せてよいと入力した紹介だけ
-- （住所の番地・電話・取引額・捕獲者名・捕獲位置の緯度経度は出さない）。
-- 追加のみ（既存の表・関数は変更しない）。

begin;
set local lock_timeout = '10s';

-- ── お店の紹介（公開用） ──
create table if not exists public.dish_shops (
  customer_id   uuid primary key references public.customers(id),
  display_name  text not null check (length(btrim(display_name)) between 1 and 60),
  description   text check (description is null or length(description) <= 600),
  area          text check (area is null or length(area) <= 40),        -- 例: 東京都江東区（番地は書かない）
  url           text check (url is null or (url ~ '^https?://' and length(url) <= 300)),
  instagram     text check (instagram is null or length(instagram) <= 60),
  consent_at    timestamptz,                                             -- 掲載の了承を得た日時
  consent_by    text,                                                    -- 'お店' または確認したスタッフ名
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ── 料理の投稿 ──
create table if not exists public.dish_posts (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.customers(id),
  dish_name     text not null check (length(btrim(dish_name)) between 1 and 80),
  description   text check (description is null or length(description) <= 600),
  photo_path    text not null check (photo_path ~ '^p/[0-9a-f-]{36}\.(jpg|webp|png)$'),
  label_ids     text[] not null default '{}',                           -- 使った個体（individuals.label_id）
  status        text not null default '確認待ち' check (status in ('確認待ち','公開','非公開')),
  source        text not null check (source in ('お店','スタッフ代理')),
  consent       boolean not null check (consent),                       -- 了承なしの行は作れない
  consent_by    text,
  created_at    timestamptz not null default now(),
  reviewed_at   timestamptz,
  reviewed_by   text,
  published_at  timestamptz,
  withdrawn_at  timestamptz                                              -- お店が取り下げた日時
);
create index if not exists dish_posts_status_idx on public.dish_posts(status, published_at desc);
create index if not exists dish_posts_customer_idx on public.dish_posts(customer_id, created_at desc);

alter table public.dish_shops enable row level security;
alter table public.dish_posts enable row level security;
-- 表には anon/authenticated 向けのポリシーを作らない（RLS有効・ポリシー無し＝直接は読めない／書けない）。

-- ── 写真の置き場（公開バケット。追加のみ可・上書き/削除は不可） ──
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dish-photos', 'dish-photos', true, 3145728, array['image/jpeg','image/webp','image/png'])
on conflict (id) do nothing;
create policy dish_photos_insert on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'dish-photos' and name ~ '^p/[0-9a-f-]{36}\.(jpg|webp|png)$');
create policy dish_photos_read on storage.objects for select to anon, authenticated
  using (bucket_id = 'dish-photos');

-- ── 共通: 個体の公開してよい要約 ──
-- SECURITY INVOKER: 単独で呼ばれても呼び出し側の権限でしか individuals を読まない（新たな露出を作らない）
create or replace function public.dish_label_summary(p_labels text[])
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'label_id', i.label_id,
           'species', i.species,
           'sex', i.sex,
           'capture_month', to_char(i.capture_date, 'YYYY"年"FMMM"月"'),
           'capture_city', i.capture_city,
           'capture_method', i.capture_method
         ) order by i.capture_date), '[]'::jsonb)
    from individuals i where i.label_id = any(coalesce(p_labels, '{}'));
$$;

-- ── 公開: ギャラリー（誰でも） ──
create or replace function public.public_dish_gallery()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by (x->>'published_at') desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', p.id, 'dish_name', p.dish_name, 'description', p.description,
      'photo_path', p.photo_path, 'published_at', p.published_at,
      'shop', jsonb_build_object('name', s.display_name, 'description', s.description,
                                 'area', s.area, 'url', s.url, 'instagram', s.instagram),
      'individuals', dish_label_summary(p.label_ids)
    ) x
    from dish_posts p join dish_shops s on s.customer_id = p.customer_id
    where p.status = '公開' and s.consent_at is not null
    limit 500
  ) t;
$$;
grant execute on function public.public_dish_gallery() to anon, authenticated;

-- ── お店（注文ページにログイン中）: 自分の紹介・投稿・受け取った個体 ──
create or replace function public.portal_dish_mine(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_id uuid := portal_session_customer(p_token);
begin
  if v_id is null then raise exception 'ログインの有効期限が切れました。もう一度ログインしてください' using errcode = '28000'; end if;
  return jsonb_build_object(
    'shop', (select to_jsonb(s) - 'customer_id' from dish_shops s where s.customer_id = v_id),
    'customer_name', (select name from customers where id = v_id),
    'posts', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'dish_name', p.dish_name,
               'description', p.description, 'photo_path', p.photo_path, 'status', p.status,
               'created_at', p.created_at, 'individuals', dish_label_summary(p.label_ids))
               order by p.created_at desc) from dish_posts p where p.customer_id = v_id), '[]'::jsonb),
    'labels', coalesce((select jsonb_agg(r order by r->>'last_date' desc) from (
               select jsonb_build_object('label_id', inv.individual_id,
                        'species', max(i.species),
                        'parts', string_agg(distinct oi.part_name, '・'),
                        'last_date', max(coalesce(o.delivery_date, o.order_date))) r
                 from orders o join order_items oi on oi.order_id = o.id
                 join inventory inv on inv.id = oi.inventory_id
                 join individuals i on i.label_id = inv.individual_id
                where o.customer_id = v_id and o.status in ('発送済','納品完了')
                  and coalesce(o.delivery_date, o.order_date) >= current_date - 365
                group by inv.individual_id) q), '[]'::jsonb)
  );
end $$;

create or replace function public.portal_dish_shop_save(p_token text, p_display_name text, p_description text,
  p_area text, p_url text, p_instagram text, p_consent boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_id uuid := portal_session_customer(p_token);
begin
  if v_id is null then raise exception 'ログインの有効期限が切れました。もう一度ログインしてください' using errcode = '28000'; end if;
  if not coalesce(p_consent, false) then raise exception '掲載への同意にチェックを入れてください' using errcode = '22023'; end if;
  insert into dish_shops(customer_id, display_name, description, area, url, instagram, consent_at, consent_by)
  values (v_id, btrim(p_display_name), nullif(btrim(p_description), ''), nullif(btrim(p_area), ''),
          nullif(btrim(p_url), ''), nullif(btrim(p_instagram), ''), now(), 'お店')
  on conflict (customer_id) do update set display_name = excluded.display_name, description = excluded.description,
    area = excluded.area, url = excluded.url, instagram = excluded.instagram,
    consent_at = coalesce(dish_shops.consent_at, now()), consent_by = coalesce(dish_shops.consent_by, 'お店'), updated_at = now();
end $$;

create or replace function public.portal_dish_post(p_token text, p_dish_name text, p_description text,
  p_photo_path text, p_label_ids text[], p_consent boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid := portal_session_customer(p_token); v_new uuid; v_bad text;
begin
  if v_id is null then raise exception 'ログインの有効期限が切れました。もう一度ログインしてください' using errcode = '28000'; end if;
  if not coalesce(p_consent, false) then raise exception '掲載への同意にチェックを入れてください' using errcode = '22023'; end if;
  if not exists (select 1 from dish_shops where customer_id = v_id and consent_at is not null) then
    raise exception '先にお店の紹介を登録してください' using errcode = '22023'; end if;
  if (select count(*) from dish_posts where customer_id = v_id and status = '確認待ち') >= 10 then
    raise exception '確認待ちの投稿が10件あります。公開までお待ちください' using errcode = '22023'; end if;
  -- 使った個体は、このお店に実際に届いた個体だけ選べる
  select string_agg(l, '、') into v_bad from unnest(coalesce(p_label_ids, '{}')) l
   where not exists (select 1 from orders o join order_items oi on oi.order_id = o.id
                       join inventory inv on inv.id = oi.inventory_id
                      where o.customer_id = v_id and inv.individual_id = l);
  if v_bad is not null then raise exception 'お届け履歴にない個体番号です: %', v_bad using errcode = '22023'; end if;
  insert into dish_posts(customer_id, dish_name, description, photo_path, label_ids, source, consent, consent_by)
  values (v_id, btrim(p_dish_name), nullif(btrim(p_description), ''), p_photo_path,
          coalesce(p_label_ids, '{}'), 'お店', true, 'お店')
  returning id into v_new;
  return v_new;
end $$;

create or replace function public.portal_dish_withdraw(p_token text, p_post_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_id uuid := portal_session_customer(p_token);
begin
  if v_id is null then raise exception 'ログインの有効期限が切れました。もう一度ログインしてください' using errcode = '28000'; end if;
  update dish_posts set status = '非公開', withdrawn_at = now() where id = p_post_id and customer_id = v_id;
  if not found then raise exception '投稿が見つかりません' using errcode = 'P0002'; end if;
end $$;

grant execute on function public.portal_dish_mine(text), public.portal_dish_shop_save(text,text,text,text,text,text,boolean),
  public.portal_dish_post(text,text,text,text,text[],boolean), public.portal_dish_withdraw(text,uuid) to anon, authenticated;

-- ── スタッフ（x-staff-key 必須）: 一覧・公開/非公開・代理登録 ──
create or replace function public.staff_dish_list()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not staff_key_header_ok() then raise exception 'スタッフキーが必要です' using errcode = '42501'; end if;
  return jsonb_build_object(
    'posts', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'customer_id', p.customer_id,
        'customer_name', c.name, 'shop_name', s.display_name, 'shop_consent', s.consent_at is not null,
        'dish_name', p.dish_name, 'description', p.description, 'photo_path', p.photo_path,
        'status', p.status, 'source', p.source, 'consent_by', p.consent_by, 'created_at', p.created_at,
        'reviewed_by', p.reviewed_by, 'withdrawn_at', p.withdrawn_at, 'individuals', dish_label_summary(p.label_ids))
        order by (p.status <> '確認待ち'), p.created_at desc)
      from dish_posts p join customers c on c.id = p.customer_id left join dish_shops s on s.customer_id = p.customer_id), '[]'::jsonb),
    'shops', coalesce((select jsonb_agg(to_jsonb(s) || jsonb_build_object('customer_name', c.name) order by s.updated_at desc)
      from dish_shops s join customers c on c.id = s.customer_id), '[]'::jsonb));
end $$;

create or replace function public.staff_dish_set_status(p_post_id uuid, p_status text, p_by text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not staff_key_header_ok() then raise exception 'スタッフキーが必要です' using errcode = '42501'; end if;
  if p_status not in ('公開','非公開') then raise exception '状態が不正です' using errcode = '22023'; end if;
  if p_status = '公開' and exists (select 1 from dish_posts where id = p_post_id and withdrawn_at is not null) then
    raise exception 'お店が取り下げた投稿は公開できません' using errcode = '22023'; end if;
  if p_status = '公開' and not exists (select 1 from dish_posts p join dish_shops s on s.customer_id = p.customer_id
      where p.id = p_post_id and s.consent_at is not null) then
    raise exception 'お店の紹介（掲載の了承）が未登録です' using errcode = '22023'; end if;
  update dish_posts set status = p_status, reviewed_at = now(), reviewed_by = nullif(btrim(p_by), ''),
         published_at = case when p_status = '公開' then coalesce(published_at, now()) else published_at end
   where id = p_post_id;
  if not found then raise exception '投稿が見つかりません' using errcode = 'P0002'; end if;
end $$;

create or replace function public.staff_dish_customer_labels(p_customer_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not staff_key_header_ok() then raise exception 'スタッフキーが必要です' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(r order by r->>'last_date' desc) from (
     select jsonb_build_object('label_id', inv.individual_id, 'species', max(i.species),
              'parts', string_agg(distinct oi.part_name, '・'),
              'last_date', max(coalesce(o.delivery_date, o.order_date))) r
       from orders o join order_items oi on oi.order_id = o.id
       join inventory inv on inv.id = oi.inventory_id
       join individuals i on i.label_id = inv.individual_id
      where o.customer_id = p_customer_id and o.status in ('発送済','納品完了')
        and coalesce(o.delivery_date, o.order_date) >= current_date - 365
      group by inv.individual_id) q), '[]'::jsonb);
end $$;

create or replace function public.staff_dish_shop_save(p_customer_id uuid, p_display_name text, p_description text,
  p_area text, p_url text, p_instagram text, p_consent_by text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not staff_key_header_ok() then raise exception 'スタッフキーが必要です' using errcode = '42501'; end if;
  if nullif(btrim(p_consent_by), '') is null then raise exception '掲載の了承を確認した人の名前を入れてください' using errcode = '22023'; end if;
  insert into dish_shops(customer_id, display_name, description, area, url, instagram, consent_at, consent_by)
  values (p_customer_id, btrim(p_display_name), nullif(btrim(p_description), ''), nullif(btrim(p_area), ''),
          nullif(btrim(p_url), ''), nullif(btrim(p_instagram), ''), now(), btrim(p_consent_by))
  on conflict (customer_id) do update set display_name = excluded.display_name, description = excluded.description,
    area = excluded.area, url = excluded.url, instagram = excluded.instagram,
    consent_at = coalesce(dish_shops.consent_at, now()), consent_by = coalesce(dish_shops.consent_by, excluded.consent_by), updated_at = now();
end $$;

create or replace function public.staff_dish_post(p_customer_id uuid, p_dish_name text, p_description text,
  p_photo_path text, p_label_ids text[], p_consent_by text, p_publish boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_new uuid;
begin
  if not staff_key_header_ok() then raise exception 'スタッフキーが必要です' using errcode = '42501'; end if;
  if nullif(btrim(p_consent_by), '') is null then raise exception '掲載の了承を確認した人の名前を入れてください' using errcode = '22023'; end if;
  if not exists (select 1 from dish_shops where customer_id = p_customer_id and consent_at is not null) then
    raise exception '先にお店の紹介を登録してください' using errcode = '22023'; end if;
  insert into dish_posts(customer_id, dish_name, description, photo_path, label_ids, source, consent, consent_by,
                         status, reviewed_at, reviewed_by, published_at)
  values (p_customer_id, btrim(p_dish_name), nullif(btrim(p_description), ''), p_photo_path,
          coalesce(p_label_ids, '{}'), 'スタッフ代理', true, btrim(p_consent_by),
          case when p_publish then '公開' else '確認待ち' end,
          case when p_publish then now() end, case when p_publish then btrim(p_consent_by) end,
          case when p_publish then now() end)
  returning id into v_new;
  return v_new;
end $$;

grant execute on function public.staff_dish_list(), public.staff_dish_set_status(uuid,text,text),
  public.staff_dish_customer_labels(uuid), public.staff_dish_shop_save(uuid,text,text,text,text,text,text),
  public.staff_dish_post(uuid,text,text,text,text[],text,boolean) to anon, authenticated;

commit;
