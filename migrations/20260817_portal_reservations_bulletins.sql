-- 注文ポータル: 在庫なし商品の「予約（入荷待ち）」と、おすすめ掲示板
--
-- 方針（既存流儀を踏襲）:
--   * 追加のみ。既存テーブル・RPCの破壊的変更はしない
--   * 新テーブルへの直接書き込みは anon に開けない。トークン照合RPC／スタッフキー照合RPCだけが書ける
--   * 予約は「在庫なし商品を注文＝予約」。同一顧客×商品の「待ち」は1件まで（時系列で待ちリストに並ぶ）
--   * 待ち人数は商品ごとに数える（現在○人待ち）。自分の順番（△番目）も出せる
--
-- ロールバック: migrations/rollback/20260817_portal_reservations_bulletins_rollback.sql

-- ══════════ 1. 予約（入荷待ち）テーブル ══════════
create table if not exists portal_reservations (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid not null references customers(id) on delete cascade,
  product_id        uuid not null references portal_products(id) on delete cascade,
  requested_kg      numeric not null check (requested_kg > 0),
  memo              text,
  status            text not null default '待ち',   -- 待ち / 連絡済 / 完了 / キャンセル
  client_request_id text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
-- 同一顧客×商品で「待ち」は1件まで（重複予約を防ぐ＝再送しても二重にならない）
create unique index if not exists portal_reservations_active_uq
  on portal_reservations (customer_id, product_id) where status = '待ち';
-- 商品ごとの待ちリストを時系列で引くため
create index if not exists portal_reservations_product_idx
  on portal_reservations (product_id, created_at) where status = '待ち';

alter table portal_reservations enable row level security;
-- ポリシーを作らない＝anonの直接アクセスは一切不可（RPC経由のみ）

-- ══════════ 2. 掲示板（おすすめ／売りたい商品） ══════════
create table if not exists portal_bulletins (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid references portal_products(id) on delete set null, -- null=商品リンク無しのお知らせ
  title        text,
  body         text,
  badge        text,                              -- 「売れ筋」「おすすめ」など
  sort_order   int not null default 100,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table portal_bulletins enable row level security;
-- 掲示板は公開情報。読みは anon に開ける（有効なものだけ）。書きはスタッフキー照合RPCのみ
drop policy if exists portal_bulletins_read on portal_bulletins;
create policy portal_bulletins_read on portal_bulletins for select to anon using (is_active);

-- ══════════ 3. 顧客向けRPC（トークン照合） ══════════

-- 商品ごとの待ち人数と、自分の予約状況（順番・希望kg）を返す。
-- 行が返るのは「待ちが1人以上いる」か「自分が予約している」商品のみ。
create or replace function portal_reservation_marks(p_token text)
returns table(product_id uuid, waiting_count int, my_reserved boolean, my_position int, my_kg numeric)
language plpgsql stable security definer set search_path to 'public' as $$
declare v_cid uuid := portal_session_customer(p_token);
begin
  if v_cid is null then return; end if;
  return query
    with w as (
      select r.product_id, r.customer_id, r.requested_kg, r.created_at
        from portal_reservations r
       where r.status = '待ち'
    ), agg as (
      select w.product_id,
             count(*)::int as waiting_count,
             bool_or(w.customer_id = v_cid) as my_reserved,
             (select count(*)::int from w w2
               where w2.product_id = w.product_id
                 and w2.created_at <= coalesce((select w3.created_at from w w3
                        where w3.product_id = w.product_id and w3.customer_id = v_cid), 'infinity')
                 and (select w3.created_at from w w3
                        where w3.product_id = w.product_id and w3.customer_id = v_cid) is not null) as my_position,
             max(case when w.customer_id = v_cid then w.requested_kg end) as my_kg
        from w group by w.product_id
    )
    select a.product_id, a.waiting_count, a.my_reserved,
           case when a.my_reserved then a.my_position else null end,
           a.my_kg
      from agg a
     where a.waiting_count > 0;
end;
$$;

-- 在庫なし商品の予約（＝注文）。品目ごとに「待ち」を1件つくる。
-- 同一顧客×商品で既に待ちがあれば希望kgを更新（再送・二度押しでも二重にならない）。
create or replace function portal_place_reservation(
  p_token text, p_items jsonb, p_memo text default null, p_request_id text default null)
returns jsonb
language plpgsql security definer set search_path to 'public' as $$
declare
  v_cid uuid := portal_session_customer(p_token);
  it jsonb; v_prod portal_products%rowtype; v_kg numeric; v_rkg numeric;
  v_lines jsonb := '[]'::jsonb; v_n int := 0; v_rid uuid; v_pos int; v_cnt int;
begin
  if v_cid is null then raise exception 'ログインし直してください'; end if;
  perform portal_session_touch(p_token);

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception '予約する商品を選んでください'; end if;
  if jsonb_array_length(p_items) > 20 then
    raise exception '一度に予約できるのは20品目までです'; end if;
  if length(coalesce(p_memo,'')) > 500 then
    raise exception '備考は500文字までにしてください'; end if;

  for it in select * from jsonb_array_elements(p_items) loop
    v_n := v_n + 1;
    select * into v_prod from portal_products where id = (it->>'product_id')::uuid;
    if v_prod.id is null then raise exception '%品目め: 商品が見つかりません', v_n; end if;
    if not (v_prod.is_active and v_prod.portal_visible and v_prod.is_orderable) then
      raise exception '「%」は現在ご予約いただけません', v_prod.display_name; end if;

    v_kg := (it->>'kg')::numeric;
    if v_kg is null or v_kg <= 0 then
      raise exception '「%」の数量を確認してください', v_prod.display_name; end if;
    if v_kg < v_prod.min_order_kg then
      raise exception '「%」は%kgからご予約いただけます', v_prod.display_name, v_prod.min_order_kg; end if;
    v_rkg := round(v_kg / v_prod.step_kg) * v_prod.step_kg;
    if abs(v_rkg - v_kg) > 0.0005 then
      raise exception '「%」は%kg単位でご予約ください', v_prod.display_name, v_prod.step_kg; end if;

    insert into portal_reservations (customer_id, product_id, requested_kg, memo, client_request_id)
    values (v_cid, v_prod.id, v_kg, nullif(p_memo,''),
            case when p_request_id is not null and length(p_request_id) between 8 and 64 then p_request_id end)
    on conflict (customer_id, product_id) where status = '待ち'
      do update set requested_kg = excluded.requested_kg,
                    memo = coalesce(excluded.memo, portal_reservations.memo),
                    updated_at = now()
    returning id into v_rid;

    -- 待ち人数と自分の順番
    select count(*)::int into v_cnt from portal_reservations
      where product_id = v_prod.id and status = '待ち';
    select count(*)::int into v_pos from portal_reservations r2
      where r2.product_id = v_prod.id and r2.status = '待ち'
        and r2.created_at <= (select created_at from portal_reservations where id = v_rid);

    v_lines := v_lines || jsonb_build_object(
      'reservation_id', v_rid, 'product_id', v_prod.id, 'name', v_prod.display_name,
      'requested_kg', v_kg, 'waiting_count', v_cnt, 'position', v_pos);
  end loop;

  return jsonb_build_object('reserved', v_lines);
end;
$$;

-- 自分の予約一覧（待ちのみ・時系列）
create or replace function portal_my_reservations(p_token text)
returns table(reservation_id uuid, product_id uuid, name text, species text,
              requested_kg numeric, waiting_count int, my_position int, created_at timestamptz)
language plpgsql stable security definer set search_path to 'public' as $$
declare v_cid uuid := portal_session_customer(p_token);
begin
  if v_cid is null then return; end if;
  return query
    select r.id, r.product_id, p.display_name, p.species, r.requested_kg,
           (select count(*)::int from portal_reservations x where x.product_id = r.product_id and x.status='待ち'),
           (select count(*)::int from portal_reservations x where x.product_id = r.product_id and x.status='待ち' and x.created_at <= r.created_at),
           r.created_at
      from portal_reservations r
      join portal_products p on p.id = r.product_id
     where r.customer_id = v_cid and r.status = '待ち'
     order by r.created_at;
end;
$$;

-- 予約の取消（本人・待ちのみ）
create or replace function portal_cancel_reservation(p_token text, p_reservation_id uuid)
returns boolean
language plpgsql security definer set search_path to 'public' as $$
declare v_cid uuid := portal_session_customer(p_token); v_upd int;
begin
  if v_cid is null then raise exception 'ログインし直してください'; end if;
  perform portal_session_touch(p_token);
  update portal_reservations set status = 'キャンセル', updated_at = now()
    where id = p_reservation_id and customer_id = v_cid and status = '待ち';
  get diagnostics v_upd = row_count;
  return v_upd > 0;
end;
$$;

-- 掲示板（公開・ログイン不要）。有効なものを表示順で返す
create or replace function portal_bulletins()
returns table(id uuid, product_id uuid, title text, body text, badge text, sort_order int)
language sql stable security definer set search_path to 'public' as $$
  select b.id, b.product_id, b.title, b.body, b.badge, b.sort_order
    from portal_bulletins b
   where b.is_active
   order by b.sort_order, b.created_at desc;
$$;

-- ══════════ 4. 管理向けRPC（スタッフキー照合） ══════════

-- 予約（入荷待ち）一覧。時系列。既定は「待ち」のみ
create or replace function admin_list_reservations(p_staff_key text, p_status text default '待ち')
returns table(id uuid, product_id uuid, product_name text, species text,
              customer_id uuid, customer_name text, customer_code text,
              requested_kg numeric, status text, queue_position int, waiting_count int,
              memo text, created_at timestamptz)
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  return query
    select r.id, r.product_id, p.display_name, p.species,
           r.customer_id, c.name, c.code, r.requested_kg, r.status,
           (select count(*)::int from portal_reservations x
             where x.product_id = r.product_id and x.status='待ち' and x.created_at <= r.created_at),
           (select count(*)::int from portal_reservations x
             where x.product_id = r.product_id and x.status='待ち'),
           r.memo, r.created_at
      from portal_reservations r
      join portal_products p on p.id = r.product_id
      left join customers c on c.id = r.customer_id
     where (p_status is null or r.status = p_status)
     order by p.display_name, r.created_at;
end;
$$;

create or replace function admin_set_reservation_status(p_staff_key text, p_id uuid, p_status text)
returns boolean
language plpgsql security definer set search_path to 'public' as $$
declare v_upd int;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if p_status not in ('待ち','連絡済','完了','キャンセル') then
    raise exception '不正なステータスです'; end if;
  update portal_reservations set status = p_status, updated_at = now() where id = p_id;
  get diagnostics v_upd = row_count;
  return v_upd > 0;
end;
$$;

create or replace function admin_list_bulletins(p_staff_key text)
returns table(id uuid, product_id uuid, product_name text, title text, body text,
              badge text, sort_order int, is_active boolean, created_at timestamptz)
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  return query
    select b.id, b.product_id, p.display_name, b.title, b.body, b.badge,
           b.sort_order, b.is_active, b.created_at
      from portal_bulletins b
      left join portal_products p on p.id = b.product_id
     order by b.is_active desc, b.sort_order, b.created_at desc;
end;
$$;

create or replace function admin_upsert_bulletin(p_staff_key text, p jsonb)
returns uuid
language plpgsql security definer set search_path to 'public' as $$
declare v_id uuid;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if p->>'id' is not null then
    v_id := (p->>'id')::uuid;
    update portal_bulletins set
      product_id = case when p ? 'product_id' then nullif(p->>'product_id','')::uuid else product_id end,
      title      = case when p ? 'title' then nullif(p->>'title','') else title end,
      body       = case when p ? 'body' then nullif(p->>'body','') else body end,
      badge      = case when p ? 'badge' then nullif(p->>'badge','') else badge end,
      sort_order = coalesce((p->>'sort_order')::int, sort_order),
      is_active  = coalesce((p->>'is_active')::boolean, is_active),
      updated_at = now()
    where id = v_id;
    if not found then raise exception '掲示が見つかりません'; end if;
  else
    insert into portal_bulletins (product_id, title, body, badge, sort_order, is_active)
    values (nullif(p->>'product_id','')::uuid, nullif(p->>'title',''), nullif(p->>'body',''),
            nullif(p->>'badge',''), coalesce((p->>'sort_order')::int, 100),
            coalesce((p->>'is_active')::boolean, true))
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

create or replace function admin_delete_bulletin(p_staff_key text, p_id uuid)
returns boolean
language plpgsql security definer set search_path to 'public' as $$
declare v_del int;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  delete from portal_bulletins where id = p_id;
  get diagnostics v_del = row_count;
  return v_del > 0;
end;
$$;

-- ══════════ 5. 実行権限 ══════════
grant execute on function portal_reservation_marks(text) to anon;
grant execute on function portal_place_reservation(text, jsonb, text, text) to anon;
grant execute on function portal_my_reservations(text) to anon;
grant execute on function portal_cancel_reservation(text, uuid) to anon;
grant execute on function portal_bulletins() to anon;
grant execute on function admin_list_reservations(text, text) to anon;
grant execute on function admin_set_reservation_status(text, uuid, text) to anon;
grant execute on function admin_list_bulletins(text) to anon;
grant execute on function admin_upsert_bulletin(text, jsonb) to anon;
grant execute on function admin_delete_bulletin(text, uuid) to anon;
