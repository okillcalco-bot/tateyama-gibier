-- フェーズ3準備: レビュー指摘の反映（セキュリティ強化）
--
-- 1. 新規登録を「公開フォーム→customers直INSERT」から専用RPCへ移す
--    （列のホワイトリスト・書式検査・連続登録の抑止・portal_enabled等はサーバ側で固定）
-- 2. セッショントークンをDBへ平文保存しない（sha256で保存。クライアントへは生値を1度だけ返す）
--    セッション照合時に is_active / portal_enabled を毎回確認（後から無効化した顧客を即遮断）
-- 3. 注文確定の冪等化（同じリクエストIDの再送は既存注文を返す＝通信再試行で二重注文しない）
-- 4. 入力の上限（備考500字・納品日は60日先まで・user_agent 200字）
-- 5. 発送済・納品完了の注文はキャンセル不可（返品はセンターの手作業）
-- 6. 「いつもの商品」テーブルと取得RPC（中身の自動集計はフェーズ5。器を先に用意）
--
-- ロールバック: migrations/rollback/20260810_phase3_hardening_rollback.sql

-- ── 1. 新規登録RPC ────────────────────────────────────────────────
create or replace function public_signup_request(
  p_name text, p_contact text, p_phone text, p_address text,
  p_kana text default null, p_company text default null, p_email text default null,
  p_building text default null, p_time_zone text default '0000',
  p_order_method text default null, p_notify_method text default null, p_notes text default null)
returns text
language plpgsql security definer set search_path = public as $$
declare v_phone text; v_code text; v_recent int;
begin
  -- 書式検査（列のホワイトリスト＝この引数だけ。price_rank や portal_enabled は受け取らない）
  if p_name is null or btrim(p_name) = '' or length(p_name) > 80 then
    raise exception '店名・お名前を確認してください'; end if;
  if p_contact is null or btrim(p_contact) = '' or length(p_contact) > 60 then
    raise exception 'ご担当者名を確認してください'; end if;
  v_phone := regexp_replace(coalesce(p_phone,''), '\D', '', 'g');
  if length(v_phone) not between 10 and 11 then
    raise exception '電話番号を確認してください'; end if;
  if p_email is not null and p_email <> '' and p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'メールアドレスを確認してください'; end if;
  if p_address is null or btrim(p_address) = '' or length(p_address) > 200 then
    raise exception 'ご住所を確認してください'; end if;
  if length(coalesce(p_kana,'')) > 80 or length(coalesce(p_company,'')) > 100
     or length(coalesce(p_building,'')) > 100 or length(coalesce(p_notes,'')) > 500 then
    raise exception '入力が長すぎる項目があります'; end if;

  -- 連続登録の抑止: 同じ電話番号は24時間に1件・全体で1時間に20件まで
  select count(*) into v_recent from customers
   where signup_source = 'signup-form'
     and regexp_replace(coalesce(phone,''), '\D', '', 'g') = v_phone
     and created_at > now() - interval '24 hours';
  if v_recent >= 1 then
    raise exception 'この電話番号のお申し込みは既にお預かりしています。センターからの連絡をお待ちください';
  end if;
  select count(*) into v_recent from customers
   where signup_source = 'signup-form' and created_at > now() - interval '1 hour';
  if v_recent >= 20 then
    raise exception 'ただいま混み合っています。時間をおいてお試しください';
  end if;

  v_code := 'S' || upper(to_char(now(), 'YYMMDDHH24MISS'));
  insert into customers (code, name, kana, company1, contact_name, phone, email,
                         address, building, default_time_zone, order_method, notify_method,
                         notes, is_active, portal_enabled, signup_source, price_rank)
  values (v_code, btrim(p_name), nullif(btrim(coalesce(p_kana,'')),''),
          nullif(btrim(coalesce(p_company,'')),''), btrim(p_contact), p_phone,
          nullif(btrim(coalesce(p_email,'')),''), btrim(p_address),
          nullif(btrim(coalesce(p_building,'')),''),
          coalesce(nullif(p_time_zone,''),'0000'), p_order_method, p_notify_method,
          nullif(btrim(coalesce(p_notes,'')),''),
          false,   -- is_active: スタッフが確認してから有効化
          false,   -- portal_enabled: 価格確認まで注文ページは使えない
          'signup-form', 'standard');
  return v_code;   -- 受付番号
end;
$$;
grant execute on function public_signup_request(text,text,text,text,text,text,text,text,text,text,text,text) to anon, authenticated;

-- ── 2. トークンのハッシュ保存 ─────────────────────────────────────
-- portal_sessions.token には今後 sha256(生トークン) を入れる。
-- 既存の生トークン行は無効になる（現時点で本番の行は0件）。
create or replace function portal_session_customer(p_token text)
returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  if coalesce(p_token, '') = '' then return null; end if;
  update portal_sessions ps
     set last_seen_at = now()
    from customers c
   where ps.token = encode(extensions.digest(p_token, 'sha256'), 'hex')
     and ps.expires_at > now()
     and c.id = ps.customer_id
     and c.is_active is not false          -- 後から無効化した顧客は既存トークンでも遮断
     and c.portal_enabled is true
  returning ps.customer_id into v_id;
  return v_id;
end;
$$;
revoke all on function portal_session_customer(text) from public, anon, authenticated;

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

  if v_cust.portal_enabled is not true then
    raise exception 'このお客様はまだ注文ページの利用開始前です。センターへお問い合わせください';
  end if;

  delete from portal_sessions ps where ps.customer_id = v_cust.id and ps.expires_at <= now();
  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  insert into portal_sessions (token, customer_id, user_agent)
  values (encode(extensions.digest(v_token, 'sha256'), 'hex'), v_cust.id,
          left(coalesce(p_user_agent,''), 200));

  return query select v_token, now() + interval '30 days', v_cust.code, v_cust.name,
    v_cust.honorific, v_cust.price_rank, v_cust.portal_login_id, v_cust.phone,
    v_cust.address, v_cust.building, v_cust.default_time_zone;
end;
$$;
grant execute on function portal_login_v2(text, text, text) to anon, authenticated;

create or replace function portal_logout(p_token text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  delete from portal_sessions
   where token = encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex');
  return found;
end;
$$;

-- ── 3〜4. 注文確定の冪等化と入力上限 ──────────────────────────────
alter table orders add column if not exists client_request_id text;
create unique index if not exists orders_client_request_id_uq
  on orders (client_request_id) where client_request_id is not null;

drop function if exists portal_place_order(text, jsonb, date, text, text);
create or replace function portal_place_order(
  p_token text, p_items jsonb, p_delivery_date date,
  p_time_zone text default null, p_memo text default null, p_request_id text default null)
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
  v_dup record;
begin
  if v_cid is null then raise exception 'ログインし直してください'; end if;
  select * into v_cust from customers where id = v_cid;

  -- 冪等化: 同じリクエストIDの注文が既にあれば、それを返す（二重注文しない）
  if p_request_id is not null and length(p_request_id) between 8 and 64 then
    select o.id, o.order_code, o.total_amount into v_dup
      from orders o where o.client_request_id = p_request_id and o.customer_id = v_cid;
    if v_dup.id is not null then
      return jsonb_build_object('order_id', v_dup.id, 'order_code', v_dup.order_code,
        'total_amount', v_dup.total_amount, 'duplicate', true,
        'items', coalesce((select jsonb_agg(jsonb_build_object(
            'name', oi.product_name, 'requested_kg', oi.requested_kg,
            'allocated_kg', oi.allocated_kg, 'unit_price', oi.unit_price,
            'price_source', oi.price_source, 'amount', oi.amount) order by oi.created_at)
          from order_items oi where oi.order_id = v_dup.id), '[]'::jsonb));
    end if;
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
  if p_delivery_date > current_date + 60 then
    raise exception '納品希望日は60日先までで指定してください';
  end if;
  if length(coalesce(p_memo,'')) > 500 then
    raise exception '備考は500文字までにしてください';
  end if;

  v_code := 'ORD-' || to_char(now() at time zone 'Asia/Tokyo', 'YYYYMMDD-HH24MISS')
            || '-' || upper(substr(encode(extensions.gen_random_bytes(2),'hex'),1,4));
  insert into orders (order_code, customer_id, customer_name, status, order_date,
                      delivery_date, delivery_time_zone, delivery_address, delivery_building,
                      delivery_name, delivery_phone, price_rank, channel, memo, total_amount,
                      client_request_id)
  values (v_code, v_cust.id, v_cust.name, '受注', (now() at time zone 'Asia/Tokyo')::date,
          p_delivery_date, coalesce(nullif(p_time_zone,''), v_cust.default_time_zone, '0000'),
          coalesce(v_cust.address,''), coalesce(v_cust.building,''),
          v_cust.name, coalesce(v_cust.phone,''), coalesce(v_cust.price_rank,'standard'),
          'ポータル', nullif(p_memo,''), 0,
          case when p_request_id is not null and length(p_request_id) between 8 and 64
               then p_request_id end)
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
       set weight_kg = v_alloc, weight = v_alloc, amount = v_amount, subtotal = v_amount,
           allocated_kg = v_alloc
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
grant execute on function portal_place_order(text, jsonb, date, text, text, text) to anon, authenticated;

-- ── 5. 発送済・納品完了の注文はキャンセル不可 ──────────────────────
create or replace function admin_set_order_status(p_staff_key text, p_order_id uuid, p_status text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_released int := 0; v_shipped int := 0; v_cur text;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if p_status not in ('受注','確認済','発送済','納品完了','キャンセル') then
    raise exception 'ステータスが正しくありません: %', p_status;
  end if;
  select status into v_cur from orders where id = p_order_id;
  if v_cur is null then raise exception '注文が見つかりません'; end if;
  if p_status = 'キャンセル' and v_cur in ('発送済','納品完了') then
    raise exception '%の注文はキャンセルできません。返品はセンターで個別に処理してください', v_cur;
  end if;

  update orders set status = p_status, updated_at = now() where id = p_order_id;

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

-- ── 6. 「いつもの商品」（器のみ。自動集計はフェーズ5） ─────────────
create table if not exists customer_usual_items (
  customer_id     uuid not null references customers(id) on delete cascade,
  product_id      uuid not null references portal_products(id) on delete cascade,
  rank            int  not null,
  purchase_count  int  not null default 0,
  total_kg        numeric not null default 0,
  avg_order_kg    numeric not null default 0,
  usual_qty_kg    numeric not null default 0,
  last_purchased_on date,
  avg_interval_days numeric,
  reason          text not null default '',
  computed_at     timestamptz not null default now(),
  is_pinned       boolean not null default false,
  is_hidden       boolean not null default false,
  primary key (customer_id, product_id)
);
alter table customer_usual_items enable row level security;
-- anon へポリシーなし（読み書きはRPC経由のみ）

create or replace function portal_usual_items(p_token text)
returns table (product_id uuid, display_name text, species text, grade_label text,
               usual_qty_kg numeric, min_order_kg numeric, step_kg numeric,
               mark text, unit_price int, price_source text, is_orderable boolean,
               is_favorite boolean)
language plpgsql stable security definer set search_path = public as $$
declare v_id uuid := portal_session_customer(p_token); v_rank text;
begin
  if v_id is null then return; end if;
  select c.price_rank into v_rank from customers c where c.id = v_id;
  return query
  select p.id, p.display_name, p.species, p.grade_label,
         greatest(p.min_order_kg, round(u.usual_qty_kg / p.step_kg) * p.step_kg),
         p.min_order_kg, p.step_kg,
         case when coalesce(s.kg,0) >= p.low_kg then '◎'
              when coalesce(s.kg,0) >= p.min_order_kg then '△' else '×' end,
         pr.unit_price, pr.price_source,
         (p.is_orderable and pr.unit_price is not null),
         exists (select 1 from customer_saved_items f
                  where f.customer_id = v_id and f.kind = 'favorite' and f.product_id = p.id)
    from customer_usual_items u
    join portal_products p on p.id = u.product_id
    left join lateral (
      select sum(coalesce(i.weight_kg, i.weight)) as kg
        from portal_product_parts pp
        join inventory i on i.deleted_at is null and i.status = '在庫'
         and i.species = p.species and i.part_name = pp.part_name
         and (pp.grade is null or i.grade = pp.grade)
       where pp.product_id = p.id) s on true
    left join lateral (select * from resolve_unit_price(v_id, p.id)) pr on true
   where u.customer_id = v_id and not u.is_hidden
     and p.is_active and p.portal_visible
     and (p.visible_ranks is null or coalesce(v_rank,'standard') = any(p.visible_ranks))
   order by u.is_pinned desc, u.rank
   limit 5;
end;
$$;
grant execute on function portal_usual_items(text) to anon, authenticated;
