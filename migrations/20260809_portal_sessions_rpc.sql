-- フェーズ2（その1）: セッショントークンとお客様向けRPC
--
-- 方針（docs/order-site-plan.md §5-6・§6）:
--   * お客様側の読み書きはすべてRPC経由にする（customers / orders / order_items の直読みをやめる）
--   * portal_login_v2() がトークンを発行し、以後のRPCはトークンで本人を特定する
--   * 新ポータルのログインは customers.portal_enabled = true の顧客だけ
--     （旧 portal_login() は変更しない＝既存の旧ポータルのログインは今までどおり）
--   * 注文RPCはクライアントから単価を受け取らない。resolve_unit_price() だけで決める
--   * センター側画面用に「スタッフキーをHTTPヘッダで照合する」仕組みを用意する
--     （RLS引き締め＝ 20260809_rls_tighten.sql は、画面側の対応が本番に出てから適用する）
--
-- ロールバック: migrations/rollback/20260809_portal_sessions_rpc_rollback.sql

-- ── 1. セッション ─────────────────────────────────────────────────
create table if not exists portal_sessions (
  token        text primary key,
  customer_id  uuid not null references customers(id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null default now() + interval '30 days',
  user_agent   text
);
create index if not exists portal_sessions_customer on portal_sessions (customer_id);
alter table portal_sessions enable row level security;
revoke all on portal_sessions from anon, authenticated;  -- RPC経由のみ

-- トークン → 顧客。無効・期限切れは null（内部専用）
create or replace function portal_session_customer(p_token text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if coalesce(p_token, '') = '' then return null; end if;
  update portal_sessions
     set last_seen_at = now()
   where token = p_token and expires_at > now()
  returning customer_id into v_id;
  return v_id;
end;
$$;
revoke all on function portal_session_customer(text) from public, anon, authenticated;

-- ── 2. ログイン（トークン発行）・ログアウト・自分の情報 ─────────────
create or replace function portal_login_v2(p_login text, p_password text, p_user_agent text default null)
returns table (token text, expires_at timestamptz, code text, name text, honorific text,
               price_rank text, portal_login_id text, phone text, address text, building text,
               default_time_zone text)
language plpgsql security definer set search_path = public, extensions as $$
declare v_cust customers%rowtype; v_token text;
begin
  select c.* into v_cust
    from customers c
    join customer_secrets s on s.customer_id = c.id
   where c.is_active is not false
     and (lower(c.portal_login_id) = lower(btrim(coalesce(p_login,'')))
          or lower(c.code) = lower(btrim(coalesce(p_login,'')))
          or lower(c.name) = lower(btrim(coalesce(p_login,''))))
     and s.password_hash = extensions.crypt(coalesce(p_password,''), s.password_hash)
   limit 1;
  if v_cust.id is null then return; end if;

  -- 新ポータルは、価格の確認が済んで有効化された顧客だけ
  if v_cust.portal_enabled is not true then
    raise exception 'このお客様はまだ注文ページの利用開始前です。センターへお問い合わせください';
  end if;

  delete from portal_sessions ps where ps.customer_id = v_cust.id and ps.expires_at <= now();
  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into portal_sessions (token, customer_id, user_agent) values (v_token, v_cust.id, p_user_agent);

  return query select v_token, now() + interval '30 days', v_cust.code, v_cust.name,
    v_cust.honorific, v_cust.price_rank, v_cust.portal_login_id, v_cust.phone,
    v_cust.address, v_cust.building, v_cust.default_time_zone;
end;
$$;
grant execute on function portal_login_v2(text, text, text) to anon, authenticated;

create or replace function portal_logout(p_token text)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  delete from portal_sessions where token = p_token;
  return found;
end;
$$;
grant execute on function portal_logout(text) to anon, authenticated;

create or replace function portal_me(p_token text)
returns table (code text, name text, honorific text, price_rank text, portal_login_id text,
               phone text, address text, building text, default_time_zone text)
language plpgsql stable security definer set search_path = public as $$
declare v_id uuid := portal_session_customer(p_token);
begin
  if v_id is null then return; end if;
  return query select c.code, c.name, c.honorific, c.price_rank, c.portal_login_id,
                      c.phone, c.address, c.building, c.default_time_zone
    from customers c where c.id = v_id;
end;
$$;
grant execute on function portal_me(text) to anon, authenticated;

-- ── 3. カタログ（記号と適用単価のみ。実重量は返さない） ────────────
create or replace function portal_catalog(p_token text)
returns table (product_id uuid, species text, display_name text, grade_label text,
               description text, sort_order int, min_order_kg numeric, step_kg numeric,
               mark text, unit_price int, price_source text, is_orderable boolean,
               is_favorite boolean)
language plpgsql stable security definer set search_path = public as $$
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
$$;
grant execute on function portal_catalog(text) to anon, authenticated;

-- ── 4. お気に入り（★は本人だけが付け外しできる） ───────────────────
create or replace function portal_toggle_favorite(p_token text, p_product_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_id uuid := portal_session_customer(p_token); v_prod portal_products%rowtype;
begin
  if v_id is null then raise exception 'ログインし直してください'; end if;
  select * into v_prod from portal_products where id = p_product_id;
  if v_prod.id is null then raise exception '商品が見つかりません'; end if;
  if exists (select 1 from customer_saved_items
              where customer_id = v_id and kind = 'favorite' and product_id = p_product_id) then
    delete from customer_saved_items
     where customer_id = v_id and kind = 'favorite' and product_id = p_product_id;
    return false;
  else
    insert into customer_saved_items (customer_id, kind, product_id, species, part_name)
    values (v_id, 'favorite', p_product_id, v_prod.species, v_prod.display_name);
    return true;
  end if;
end;
$$;
grant execute on function portal_toggle_favorite(text, uuid) to anon, authenticated;

-- ── 5. 注文履歴・前回の注文 ────────────────────────────────────────
create or replace function portal_my_orders(p_token text, p_limit int default 50)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_id uuid := portal_session_customer(p_token);
begin
  if v_id is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(o2 order by o2->>'created_at' desc) from (
      select jsonb_build_object(
        'id', o.id, 'order_code', o.order_code, 'status', o.status,
        'order_date', o.order_date, 'delivery_date', o.delivery_date,
        'total_amount', o.total_amount, 'created_at', o.created_at,
        'items', coalesce((select jsonb_agg(jsonb_build_object(
            'name', coalesce(oi.product_name, oi.part_name),
            'species', oi.species,
            'requested_kg', oi.requested_kg,
            'kg', coalesce(oi.allocated_kg, oi.weight_kg, oi.weight),
            'unit_price', oi.unit_price, 'amount', coalesce(oi.amount, oi.subtotal::int))
            order by oi.created_at)
          from order_items oi where oi.order_id = o.id), '[]'::jsonb)
      ) as o2
      from orders o
      where o.customer_id = v_id
      order by o.created_at desc
      limit least(coalesce(p_limit,50), 100)
    ) t), '[]'::jsonb);
end;
$$;
grant execute on function portal_my_orders(text, int) to anon, authenticated;

create or replace function portal_last_order(p_token text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_id uuid := portal_session_customer(p_token); v_oid uuid;
begin
  if v_id is null then return null; end if;
  select o.id into v_oid from orders o
   where o.customer_id = v_id and coalesce(o.status,'') <> 'キャンセル'
   order by o.created_at desc limit 1;
  if v_oid is null then return null; end if;
  return (select jsonb_agg(x) -> 0 from (
    select jsonb_build_object(
      'id', o.id, 'order_code', o.order_code, 'order_date', o.order_date,
      'created_at', o.created_at, 'total_amount', o.total_amount,
      'items', coalesce((select jsonb_agg(jsonb_build_object(
          'name', coalesce(oi.product_name, oi.part_name), 'species', oi.species,
          'requested_kg', coalesce(oi.requested_kg, oi.weight_kg, oi.weight),
          'unit_price', oi.unit_price) order by oi.created_at)
        from order_items oi where oi.order_id = o.id), '[]'::jsonb)) as x
    from orders o where o.id = v_oid) t);
end;
$$;
grant execute on function portal_last_order(text) to anon, authenticated;

-- ── 6. 前回の注文を「現在の条件」で組み直す（注文はしない） ─────────
-- 過去の明細を現在の 商品マスタ・公開状態・価格・最小注文量・在庫 で評価し、
-- 注文できない明細は理由をつけて返す（勝手に別商品へ置き換えない）。
create or replace function portal_rebuild_cart(p_token text, p_order_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_id uuid := portal_session_customer(p_token);
  v_rank text;
  oi record; v_prod portal_products%rowtype;
  v_old_kg numeric; v_avail numeric; v_price int; v_src text;
  v_lines jsonb := '[]'::jsonb;
begin
  if v_id is null then return '[]'::jsonb; end if;
  if not exists (select 1 from orders o where o.id = p_order_id and o.customer_id = v_id) then
    return '[]'::jsonb;
  end if;
  select c.price_rank into v_rank from customers c where c.id = v_id;

  for oi in select * from order_items where order_id = p_order_id order by created_at loop
    v_old_kg := coalesce(oi.requested_kg, oi.weight_kg, oi.weight);
    v_prod := null;
    -- 現在の商品へ対応づける（product_id_v2 優先、無ければ 種＋部位名 の対応表で）
    if oi.product_id_v2 is not null then
      select * into v_prod from portal_products where id = oi.product_id_v2;
    end if;
    if v_prod.id is null then
      select p.* into v_prod
        from portal_products p
        join portal_product_parts pp on pp.product_id = p.id
       where p.species = oi.species and pp.part_name = oi.part_name
       order by p.portal_visible desc, p.sort_order limit 1;
    end if;

    if v_prod.id is null then
      v_lines := v_lines || jsonb_build_object(
        'name', coalesce(oi.product_name, oi.part_name), 'old_kg', v_old_kg,
        'status', 'unavailable', 'reason', '現在はお取り扱いがありません');
      continue;
    end if;
    if not (v_prod.is_active and v_prod.portal_visible and v_prod.is_orderable
            and (v_prod.visible_ranks is null or coalesce(v_rank,'standard') = any(v_prod.visible_ranks))) then
      v_lines := v_lines || jsonb_build_object(
        'name', v_prod.display_name, 'old_kg', v_old_kg,
        'status', 'unavailable', 'reason', '現在は注文できません');
      continue;
    end if;
    select r.unit_price, r.price_source into v_price, v_src
      from resolve_unit_price(v_id, v_prod.id) r;
    if v_price is null then
      v_lines := v_lines || jsonb_build_object(
        'name', v_prod.display_name, 'old_kg', v_old_kg,
        'status', 'unavailable', 'reason', '価格が未設定です。センターへお問い合わせください');
      continue;
    end if;
    select coalesce(sum(coalesce(i.weight_kg, i.weight)),0) into v_avail
      from portal_product_parts pp
      join inventory i on i.deleted_at is null and i.status = '在庫'
       and i.species = v_prod.species and i.part_name = pp.part_name
       and (pp.grade is null or i.grade = pp.grade)
     where pp.product_id = v_prod.id;
    if v_avail < v_prod.min_order_kg then
      v_lines := v_lines || jsonb_build_object(
        'product_id', v_prod.id, 'name', v_prod.display_name, 'old_kg', v_old_kg,
        'status', 'out_of_stock', 'reason', '在庫切れです');
      continue;
    end if;

    v_lines := v_lines || jsonb_build_object(
      'product_id', v_prod.id, 'name', v_prod.display_name, 'old_kg', v_old_kg,
      'suggest_kg', greatest(v_prod.min_order_kg,
        round(coalesce(v_old_kg, v_prod.min_order_kg) / v_prod.step_kg) * v_prod.step_kg),
      'old_unit_price', oi.unit_price,
      'unit_price', v_price, 'price_source', v_src,
      'price_changed', oi.unit_price is distinct from v_price,
      'status', 'ok');
  end loop;
  return v_lines;
end;
$$;
grant execute on function portal_rebuild_cart(text, uuid) to anon, authenticated;

-- ── 7. 注文の確定 ─────────────────────────────────────────────────
-- 単価はサーバ側でだけ決める。引当もここで行い、どこかで失敗したら全体が戻る。
create or replace function portal_place_order(
  p_token text, p_items jsonb, p_delivery_date date,
  p_time_zone text default null, p_memo text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_cid uuid := portal_session_customer(p_token);
  v_cust customers%rowtype;
  v_order_id uuid; v_code text;
  it jsonb; v_prod portal_products%rowtype;
  v_kg numeric; v_rkg numeric; v_price int; v_src text; v_rank_applied text;
  v_item_id uuid; v_alloc numeric; v_amount int; v_total int := 0;
  v_lines jsonb := '[]'::jsonb; v_n int := 0;
begin
  if v_cid is null then raise exception 'ログインし直してください'; end if;
  select * into v_cust from customers where id = v_cid;
  if v_cust.is_active is false or v_cust.portal_enabled is not true then
    raise exception 'ご注文を受け付けられません。センターへお問い合わせください';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception '商品を選んでください';
  end if;
  if jsonb_array_length(p_items) > 20 then
    raise exception '一度に注文できるのは20品目までです';
  end if;
  if p_delivery_date is null or p_delivery_date < current_date then
    raise exception '納品希望日を確認してください';
  end if;

  v_code := 'ORD-' || to_char(now() at time zone 'Asia/Tokyo', 'YYYYMMDD-HH24MISS')
            || '-' || upper(substr(encode(extensions.gen_random_bytes(2),'hex'),1,4));
  insert into orders (order_code, customer_id, customer_name, status, order_date,
                      delivery_date, delivery_time_zone, delivery_address, delivery_building,
                      delivery_name, delivery_phone, price_rank, channel, memo, total_amount)
  values (v_code, v_cust.id, v_cust.name, '受注', (now() at time zone 'Asia/Tokyo')::date,
          p_delivery_date, coalesce(nullif(p_time_zone,''), v_cust.default_time_zone, '0000'),
          coalesce(v_cust.address,''), coalesce(v_cust.building,''),
          v_cust.name, coalesce(v_cust.phone,''), coalesce(v_cust.price_rank,'standard'),
          'ポータル', nullif(p_memo,''), 0)
  returning id into v_order_id;

  for it in select * from jsonb_array_elements(p_items) loop
    v_n := v_n + 1;
    select * into v_prod from portal_products where id = (it->>'product_id')::uuid;
    if v_prod.id is null then raise exception '%品目め: 商品が見つかりません', v_n; end if;
    if not (v_prod.is_active and v_prod.portal_visible and v_prod.is_orderable
            and (v_prod.visible_ranks is null
                 or coalesce(v_cust.price_rank,'standard') = any(v_prod.visible_ranks))) then
      raise exception '「%」は現在ご注文いただけません', v_prod.display_name;
    end if;

    v_kg := (it->>'kg')::numeric;
    if v_kg is null or v_kg <= 0 then
      raise exception '「%」の数量を確認してください', v_prod.display_name; end if;
    if v_kg < v_prod.min_order_kg then
      raise exception '「%」は%kgからご注文いただけます', v_prod.display_name, v_prod.min_order_kg; end if;
    v_rkg := round(v_kg / v_prod.step_kg) * v_prod.step_kg;
    if abs(v_rkg - v_kg) > 0.0005 then
      raise exception '「%」は%kg単位でご注文ください', v_prod.display_name, v_prod.step_kg; end if;

    -- 単価はここでだけ決める（クライアントの値は使わない）
    select r.unit_price, r.price_source, coalesce(r.price_rank_applied, '')
      into v_price, v_src, v_rank_applied
      from resolve_unit_price(v_cust.id, v_prod.id) r;
    if v_price is null then
      raise exception '「%」の価格が設定されていません。センターへお問い合わせください', v_prod.display_name;
    end if;

    insert into order_items (order_id, part_name, species, product_id_v2, product_name,
                             grade_snapshot, price_rank_applied, price_source,
                             unit_price, requested_kg)
    values (v_order_id, v_prod.display_name, v_prod.species, v_prod.id, v_prod.display_name,
            v_prod.grade_label, nullif(v_rank_applied,''), v_src, v_price, v_kg)
    returning id into v_item_id;

    v_alloc := allocate_for_order_item(v_item_id, v_prod.id, v_kg);
    v_amount := round(v_alloc * v_price)::int;
    update order_items
       set weight_kg = v_alloc, weight = v_alloc, amount = v_amount, subtotal = v_amount
     where id = v_item_id;
    v_total := v_total + v_amount;

    v_lines := v_lines || jsonb_build_object(
      'name', v_prod.display_name, 'requested_kg', v_kg, 'allocated_kg', v_alloc,
      'unit_price', v_price, 'price_source', v_src, 'amount', v_amount);
  end loop;

  update orders set total_amount = v_total where id = v_order_id;
  return jsonb_build_object('order_id', v_order_id, 'order_code', v_code,
                            'total_amount', v_total, 'items', v_lines);
end;
$$;
grant execute on function portal_place_order(text, jsonb, date, text, text) to anon, authenticated;

-- ── 8. センター側: ステータス変更と引当の連動・引当内訳 ────────────
create or replace function admin_set_order_status(p_staff_key text, p_order_id uuid, p_status text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_released int := 0; v_shipped int := 0;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if p_status not in ('受注','確認済','発送済','納品完了','キャンセル') then
    raise exception 'ステータスが正しくありません: %', p_status;
  end if;
  update orders set status = p_status, updated_at = now() where id = p_order_id;
  if not found then raise exception '注文が見つかりません'; end if;

  if p_status = 'キャンセル' then
    v_released := release_allocations_for_order(p_order_id);
  elsif p_status = '発送済' then
    update inventory i set status = '出荷済', updated_at = now()
     where i.status = '引当済'
       and i.id in (select a.inventory_id from inventory_allocations a
                     join order_items oi on oi.id = a.order_item_id
                    where oi.order_id = p_order_id);
    get diagnostics v_shipped = row_count;
  end if;
  return jsonb_build_object('released', v_released, 'shipped', v_shipped);
end;
$$;
grant execute on function admin_set_order_status(text, uuid, text) to anon, authenticated;

create or replace function admin_order_allocations(p_staff_key text, p_order_id uuid)
returns table (order_item_id uuid, product_name text, inventory_id uuid,
               individual_id text, ident_code text, part_name text, grade text, weight_kg numeric)
language plpgsql stable security definer set search_path = public as $$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  return query
    select a.order_item_id, coalesce(oi.product_name, oi.part_name), a.inventory_id,
           i.individual_id, i.ident_code, i.part_name, i.grade, a.weight_kg
      from inventory_allocations a
      join order_items oi on oi.id = a.order_item_id
      join inventory i on i.id = a.inventory_id
     where oi.order_id = p_order_id
     order by oi.created_at, i.part_name;
end;
$$;
grant execute on function admin_order_allocations(text, uuid) to anon, authenticated;

-- ── 9. スタッフキーのヘッダ照合（RLS引き締めで使う） ────────────────
-- bcrypt照合は1回100ms前後かかるため、ヘッダ照合には sha256 を使う。
-- 平文はどこにも保存しない。登録は staff_key_register_header()（bcryptで本人確認してから）。
create or replace function staff_key_header_ok()
returns boolean
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_hdr text; v_hash text;
begin
  begin
    v_hdr := (current_setting('request.headers', true))::jsonb ->> 'x-staff-key';
  exception when others then v_hdr := null; end;
  if v_hdr is null or v_hdr = '' then return false; end if;
  select hash into v_hash from app_secrets where key = 'staff_key_sha256';
  if v_hash is null then return false; end if;
  return encode(extensions.digest(v_hdr, 'sha256'), 'hex') = v_hash;
end;
$$;
grant execute on function staff_key_header_ok() to anon, authenticated;

create or replace function staff_key_register_header(p_staff_key text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not staff_key_ok(p_staff_key) then return false; end if;
  insert into app_secrets (key, hash)
  values ('staff_key_sha256', encode(extensions.digest(p_staff_key, 'sha256'), 'hex'))
  on conflict (key) do update set hash = excluded.hash, updated_at = now();
  return true;
end;
$$;
grant execute on function staff_key_register_header(text) to anon, authenticated;

-- スタッフキーを変えたら sha256 も一緒に更新する
create or replace function staff_key_set(p_current_key text, p_new_key text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  if length(coalesce(p_new_key, '')) < 12 then
    raise exception 'スタッフキーは12文字以上にしてください';
  end if;
  if not staff_key_ok(p_current_key) then return false; end if;
  update app_secrets
     set hash = extensions.crypt(p_new_key, extensions.gen_salt('bf')), updated_at = now()
   where key = 'staff_key';
  insert into app_secrets (key, hash)
  values ('staff_key_sha256', encode(extensions.digest(p_new_key, 'sha256'), 'hex'))
  on conflict (key) do update set hash = excluded.hash, updated_at = now();
  return true;
end;
$$;
