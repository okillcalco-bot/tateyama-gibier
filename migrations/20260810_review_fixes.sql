-- PR #115 レビュー対応（Codex 2026-08-10 指摘 1〜7）
--
-- 1. resolve_unit_price() を内部専用に（anonから他社の個別価格を引けた穴を閉じる）
-- 2. portal_products / parts / prices の anon 直接SELECTを廃止（非公開商品・全ランク価格の漏れ）
--    管理画面は admin_list_portal_products()（スタッフキー必須）経由に変更
-- 3. STABLE関数と last_seen 更新の分離（検証=STABLE / 更新=portal_session_touch VOLATILE）
-- 4. スタッフキーのグローバルロックアウト廃止（第三者が失敗を積んで全スタッフを
--    締め出せるDoSだった）。試行記録は監査用に残す。本格的な試行制限は
--    Supabase Auth / Edge のIP単位制限へ（計画書）
-- 5. 新規登録の受付コードに乱数を追加し、重複時は再生成（同一秒の連続登録で衝突しない）
--    あわせて戻り値を jsonb（ok/error）にし、上限到達の監査ログが例外で消えない構造に
-- 6. 監査ログがロールバックで消える箇所の整理（本ファイル末尾のコメントに一覧）
-- 7. 軽微修正: 超過20%は「以上」に統一 / 冪等キーは（顧客,リクエストID）で一意 /
--    部位マッピングの「等級問わず」と特定等級の混在を禁止 / ログインはID・顧客コードのみ
--
-- ロールバック: migrations/rollback/20260810_review_fixes_rollback.sql

-- ── 1. resolve_unit_price を内部専用に ────────────────────────────
revoke all on function resolve_unit_price(uuid, uuid, date) from public, anon, authenticated;

-- 管理画面用: 顧客×商品の適用価格の確認（スタッフキー必須）
create or replace function admin_resolve_price(p_staff_key text, p_customer_id uuid, p_product_id uuid)
returns table (unit_price int, price_source text, price_rank_applied text)
language plpgsql security definer set search_path = public as $$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  return query select * from resolve_unit_price(p_customer_id, p_product_id);
end;
$$;
grant execute on function admin_resolve_price(text, uuid, uuid) to anon, authenticated;

-- ── 2. カタログ表の直接公開を廃止 ─────────────────────────────────
drop policy if exists portal_products_read on portal_products;
drop policy if exists portal_product_parts_read on portal_product_parts;
drop policy if exists portal_product_prices_read on portal_product_prices;
revoke all on portal_products from anon, authenticated;
revoke all on portal_product_parts from anon, authenticated;
revoke all on portal_product_prices from anon, authenticated;
revoke all on customer_product_prices from anon, authenticated;

-- 管理画面の一覧（商品＋部位＋価格＋在庫記号をまとめて返す）
create or replace function admin_list_portal_products(p_staff_key text)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', p.id, 'species', p.species, 'display_name', p.display_name,
      'grade_label', p.grade_label, 'description', p.description, 'sort_order', p.sort_order,
      'min_order_kg', p.min_order_kg, 'step_kg', p.step_kg, 'low_kg', p.low_kg,
      'portal_visible', p.portal_visible, 'is_orderable', p.is_orderable,
      'is_active', p.is_active, 'is_reorderable', p.is_reorderable,
      'visible_ranks', to_jsonb(p.visible_ranks),
      'mark', case when coalesce(s.kg,0) >= p.low_kg then '◎'
                   when coalesce(s.kg,0) >= p.min_order_kg then '△' else '×' end,
      'parts', coalesce((select jsonb_agg(jsonb_build_object('part_name', pp.part_name, 'grade', pp.grade))
                          from portal_product_parts pp where pp.product_id = p.id), '[]'::jsonb),
      'prices', coalesce((select jsonb_agg(jsonb_build_object('price_rank', pr.price_rank, 'unit_price', pr.unit_price))
                           from portal_product_prices pr where pr.product_id = p.id), '[]'::jsonb)
    ) order by p.sort_order, p.display_name)
    from portal_products p
    left join lateral (
      select sum(coalesce(i.weight_kg, i.weight)) as kg
        from portal_product_parts pp
        join inventory i on i.deleted_at is null and i.status = '在庫'
         and i.species = p.species and i.part_name = pp.part_name
         and (pp.grade is null or i.grade = pp.grade)
       where pp.product_id = p.id) s on true), '[]'::jsonb);
end;
$$;
grant execute on function admin_list_portal_products(text) to anon, authenticated;

-- ── 3. セッション: 検証(STABLE)と更新(VOLATILE)の分離 ─────────────
create or replace function portal_session_customer(p_token text)
returns uuid
language sql stable security definer set search_path = public, extensions as $$
  select ps.customer_id
    from portal_sessions ps
    join customers c on c.id = ps.customer_id
   where ps.token = encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex')
     and ps.expires_at > now()
     and c.is_active is not false
     and c.portal_enabled is true
   limit 1
$$;
revoke all on function portal_session_customer(text) from public, anon, authenticated;

create or replace function portal_session_touch(p_token text)
returns void
language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  -- clock_timestamp: トランザクション内でも実時刻（now()はトランザクション開始時刻で固定される）
  update portal_sessions
     set last_seen_at = clock_timestamp()
   where token = encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex')
     and expires_at > now();
end;
$$;
revoke all on function portal_session_touch(text) from public, anon, authenticated;

-- 更新系RPCだけがアクセス時刻を進める
create or replace function portal_toggle_favorite(p_token text, p_product_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_id uuid := portal_session_customer(p_token); v_prod portal_products%rowtype;
begin
  if v_id is null then raise exception 'ログインし直してください'; end if;
  perform portal_session_touch(p_token);
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

-- ── 4. グローバルロックアウトの廃止（試行記録は残す） ─────────────
create or replace function staff_key_ok(p_staff_key text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_ok boolean;
begin
  select hash into v_hash from app_secrets where key = 'staff_key';
  v_ok := v_hash is not null and v_hash = extensions.crypt(coalesce(p_staff_key,''), v_hash);
  insert into auth_attempts (kind, ok) values ('staff_key', v_ok);
  return v_ok;
end;
$$;

create or replace function admin_rotate_staff_key(p_recovery_code text, p_new_key text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text;
begin
  select hash into v_hash from app_secrets where key = 'recovery_code';
  if v_hash is null or v_hash <> extensions.crypt(coalesce(p_recovery_code,''), v_hash) then
    insert into auth_attempts (kind, ok) values ('recovery', false);
    insert into security_events (event) values ('recovery_failed');
    return false;   -- falseで正常終了＝失敗ログがコミットされる
  end if;
  insert into auth_attempts (kind, ok) values ('recovery', true);

  if length(coalesce(p_new_key,'')) < 16 then
    raise exception '新しいスタッフキーは16文字以上にしてください';
  end if;

  update app_secrets
     set hash = extensions.crypt(p_new_key, extensions.gen_salt('bf')), updated_at = now()
   where key = 'staff_key';
  insert into app_secrets (key, hash)
  values ('staff_key_sha256', encode(extensions.digest(p_new_key, 'sha256'), 'hex'))
  on conflict (key) do update set hash = excluded.hash, updated_at = now();

  insert into security_events (event, detail)
  values ('staff_key_rotated', '回復コードによる変更。全端末で再入力が必要');
  return true;
end;
$$;

-- ── 5. 新規登録: コード衝突の解消と構造化レスポンス ────────────────
-- 戻り値を jsonb（{ok:true, code:...} / {ok:false, error:...}）に変更。
-- 例外を投げないため、上限到達などの監査ログがロールバックで消えない。
drop function if exists public_signup_request(text,text,text,text,text,text,text,text,text,text,text,text);
create or replace function public_signup_request(
  p_name text, p_contact text, p_phone text, p_address text,
  p_kana text default null, p_company text default null, p_email text default null,
  p_building text default null, p_time_zone text default '0000',
  p_order_method text default null, p_notify_method text default null, p_notes text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_phone text; v_code text; v_recent int; v_try int;
begin
  if p_name is null or btrim(p_name) = '' or length(p_name) > 80 then
    return jsonb_build_object('ok', false, 'error', '店名・お名前を確認してください'); end if;
  if p_contact is null or btrim(p_contact) = '' or length(p_contact) > 60 then
    return jsonb_build_object('ok', false, 'error', 'ご担当者名を確認してください'); end if;
  v_phone := regexp_replace(coalesce(p_phone,''), '\D', '', 'g');
  if length(v_phone) not between 10 and 11 then
    return jsonb_build_object('ok', false, 'error', '電話番号を確認してください'); end if;
  if p_email is not null and p_email <> '' and p_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    return jsonb_build_object('ok', false, 'error', 'メールアドレスを確認してください'); end if;
  if p_address is null or btrim(p_address) = '' or length(p_address) > 200 then
    return jsonb_build_object('ok', false, 'error', 'ご住所を確認してください'); end if;
  if length(coalesce(p_kana,'')) > 80 or length(coalesce(p_company,'')) > 100
     or length(coalesce(p_building,'')) > 100 or length(coalesce(p_notes,'')) > 500 then
    return jsonb_build_object('ok', false, 'error', '入力が長すぎる項目があります'); end if;

  perform pg_advisory_xact_lock(hashtext('signup:phone:' || v_phone));
  perform pg_advisory_xact_lock(hashtext('signup:global'));

  select count(*) into v_recent from customers
   where signup_source = 'signup-form'
     and regexp_replace(coalesce(phone,''), '\D', '', 'g') = v_phone
     and created_at > now() - interval '24 hours';
  if v_recent >= 1 then
    return jsonb_build_object('ok', false, 'error',
      'この電話番号のお申し込みは既にお預かりしています。センターからの連絡をお待ちください');
  end if;
  select count(*) into v_recent from customers
   where signup_source = 'signup-form' and created_at > now() - interval '1 hour';
  if v_recent >= 20 then
    insert into security_events (event, detail) values ('signup_rate_limited', '1時間20件の上限に到達');
    return jsonb_build_object('ok', false, 'error',
      'ただいま混み合っています。時間をおいてお試しいただくか、お電話ください');
  end if;

  -- 受付コード: 時刻＋乱数。万一の重複は再生成（最大3回）
  for v_try in 1..3 loop
    v_code := 'S' || to_char(clock_timestamp(), 'YYMMDDHH24MISS')
              || upper(substr(encode(extensions.gen_random_bytes(2), 'hex'), 1, 4));
    begin
      insert into customers (code, name, kana, company1, contact_name, phone, email,
                             address, building, default_time_zone, order_method, notify_method,
                             notes, is_active, portal_enabled, signup_source, price_rank)
      values (v_code, btrim(p_name), nullif(btrim(coalesce(p_kana,'')),''),
              nullif(btrim(coalesce(p_company,'')),''), btrim(p_contact), p_phone,
              nullif(btrim(coalesce(p_email,'')),''), btrim(p_address),
              nullif(btrim(coalesce(p_building,'')),''),
              coalesce(nullif(p_time_zone,''),'0000'), p_order_method, p_notify_method,
              nullif(btrim(coalesce(p_notes,'')),''),
              false, false, 'signup-form', 'standard');
      return jsonb_build_object('ok', true, 'code', v_code);
    exception when unique_violation then
      if v_try = 3 then
        return jsonb_build_object('ok', false, 'error', '受付できませんでした。もう一度お試しください');
      end if;
    end;
  end loop;
  return jsonb_build_object('ok', false, 'error', '受付できませんでした');
end;
$$;
grant execute on function public_signup_request(text,text,text,text,text,text,text,text,text,text,text,text) to anon, authenticated;

-- ── 7.1 超過基準の境界（画面文言「2割以上」に一致させる）は place_order 内で修正
-- ── 7.2 冪等キーは（顧客, リクエストID）で一意 ─────────────────────
drop index if exists orders_client_request_id_uq;
create unique index if not exists orders_client_request_uq
  on orders (customer_id, client_request_id) where client_request_id is not null;

-- ── 7.4 ログインは ログインID / 顧客コード のみ（同名顧客の曖昧さを排除） ──
create unique index if not exists customers_portal_login_id_lower_uq
  on customers (lower(portal_login_id)) where portal_login_id is not null;

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
          or lower(c.code) = lower(btrim(coalesce(p_login,''))))
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

-- 旧ポータル用の portal_login / portal_change_password も同じ基準に揃える
-- （お名前での照合を廃止。ログインID・顧客コードのみ）
create or replace function portal_login(p_login text, p_password text)
returns table (
  id uuid, code text, name text, kana text, honorific text,
  contact_name text, email text, phone text, address text, building text,
  price_rank text, default_item text, default_time_zone text,
  default_carriers text[], notify_method text, portal_login_id text
)
language plpgsql security definer set search_path = public, extensions as $$
declare v_login text := btrim(coalesce(p_login, ''));
begin
  if v_login = '' or coalesce(p_password, '') = '' then return; end if;
  return query
  select c.id, c.code, c.name, c.kana, c.honorific,
         c.contact_name, c.email, c.phone, c.address, c.building,
         c.price_rank, c.default_item, c.default_time_zone,
         c.default_carriers, c.notify_method, c.portal_login_id
    from customers c
    join customer_secrets s on s.customer_id = c.id
   where c.is_active is not false
     and (lower(c.portal_login_id) = lower(v_login)
          or lower(c.code) = lower(v_login))
     and s.password_hash = extensions.crypt(p_password, s.password_hash)
   limit 1;
end;
$$;

create or replace function portal_change_password(p_login text, p_old text, p_new text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_id uuid;
begin
  if length(coalesce(p_new, '')) < 6 then
    raise exception 'パスワードは6文字以上にしてください';
  end if;
  select c.id into v_id
    from customers c
    join customer_secrets s on s.customer_id = c.id
   where c.is_active is not false
     and (lower(c.portal_login_id) = lower(btrim(coalesce(p_login,'')))
          or lower(c.code) = lower(btrim(coalesce(p_login,''))))
     and s.password_hash = extensions.crypt(p_old, s.password_hash)
   limit 1;
  if v_id is null then return false; end if;
  update customer_secrets
     set password_hash = extensions.crypt(p_new, extensions.gen_salt('bf')),
         updated_at = now()
   where customer_id = v_id;
  return true;
end;
$$;

-- ── 7.1 + セッションtouch を含む place_order の更新 ────────────────
-- （c_review_over は「20%以上」= >= に変更。50%は「超」のまま＝画面文言と一致）
create or replace function portal_place_order(
  p_token text, p_items jsonb, p_delivery_date date,
  p_time_zone text default null, p_memo text default null, p_request_id text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  c_review_over constant numeric := 0.20;   -- 以上で「要確認」
  c_max_over    constant numeric := 0.50;   -- 超でお断り
  v_cid uuid := portal_session_customer(p_token);
  v_cust customers%rowtype;
  v_order_id uuid; v_code text;
  it jsonb; v_prod portal_products%rowtype;
  v_kg numeric; v_rkg numeric; v_price int; v_src text; v_rank_applied text;
  v_item_id uuid; v_alloc numeric; v_amount int; v_total int := 0;
  v_lines jsonb := '[]'::jsonb; v_n int := 0;
  v_dup record; v_review text[] := '{}';
begin
  if v_cid is null then raise exception 'ログインし直してください'; end if;
  perform portal_session_touch(p_token);
  select * into v_cust from customers where id = v_cid;

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
    raise exception '商品を選んでください'; end if;
  if jsonb_array_length(p_items) > 20 then
    raise exception '一度に注文できるのは20品目までです'; end if;
  if p_delivery_date is null or p_delivery_date < current_date then
    raise exception '納品希望日を確認してください'; end if;
  if p_delivery_date > current_date + 60 then
    raise exception '納品希望日は60日先までで指定してください'; end if;
  if length(coalesce(p_memo,'')) > 500 then
    raise exception '備考は500文字までにしてください'; end if;

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

    if v_alloc > v_kg * (1 + c_max_over) then
      raise exception '「%」はご希望量に近いパックのご用意が難しいため、このままお受けできません。数量を増やすか、お電話でご相談ください',
        v_prod.display_name;
    end if;
    if v_alloc >= v_kg * (1 + c_review_over) then
      v_review := v_review || (v_prod.display_name || ' 希望' || v_kg || 'kg→確保' || v_alloc || 'kg');
    end if;

    v_amount := round(v_alloc * v_price)::int;
    update order_items
       set weight_kg = v_alloc, weight = v_alloc, amount = v_amount, subtotal = v_amount,
           allocated_kg = v_alloc
     where id = v_item_id;
    v_total := v_total + v_amount;

    v_lines := v_lines || jsonb_build_object(
      'name', v_prod.display_name, 'requested_kg', v_kg, 'allocated_kg', v_alloc,
      'unit_price', v_price, 'price_source', v_src, 'amount', v_amount,
      'needs_review', v_alloc >= v_kg * (1 + c_review_over));
  end loop;

  update orders set total_amount = v_total,
         memo = case when array_length(v_review,1) is not null
                     then coalesce(memo || E'\n', '') || '【超過確認】' || array_to_string(v_review, '、')
                     else memo end
   where id = v_order_id;

  return jsonb_build_object('order_id', v_order_id, 'order_code', v_code,
                            'total_amount', v_total, 'items', v_lines,
                            'needs_review', array_length(v_review,1) is not null);
end;
$$;
grant execute on function portal_place_order(text, jsonb, date, text, text, text) to anon, authenticated;

-- ── 7.3 部位マッピングの混在禁止を admin_upsert_product に追加 ─────
create or replace function admin_upsert_product(p_staff_key text, p jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_part jsonb; v_price jsonb; v_pn text;
begin
  if not staff_key_ok(p_staff_key) then
    raise exception 'スタッフキーが違います';
  end if;

  if p ? 'parts' then
    -- 同じ部位に「等級問わず(null)」と「特定等級」が混在すると在庫集計が二重になるため禁止
    for v_pn in
      select x->>'part_name' from jsonb_array_elements(p->'parts') x
      group by x->>'part_name'
      having count(*) filter (where coalesce(x->>'grade','') = '') > 0
         and count(*) filter (where coalesce(x->>'grade','') <> '') > 0
    loop
      raise exception '部位「%」に「等級問わず」と特定等級を同時に登録できません', v_pn;
    end loop;
  end if;

  if p->>'id' is not null then
    v_id := (p->>'id')::uuid;
    update portal_products set
      species        = coalesce(p->>'species', species),
      display_name   = coalesce(p->>'display_name', display_name),
      grade_label    = case when p ? 'grade_label' then nullif(p->>'grade_label','') else grade_label end,
      description    = case when p ? 'description' then nullif(p->>'description','') else description end,
      sort_order     = coalesce((p->>'sort_order')::int, sort_order),
      min_order_kg   = coalesce((p->>'min_order_kg')::numeric, min_order_kg),
      step_kg        = coalesce((p->>'step_kg')::numeric, step_kg),
      low_kg         = coalesce((p->>'low_kg')::numeric, low_kg),
      portal_visible = coalesce((p->>'portal_visible')::boolean, portal_visible),
      is_orderable   = coalesce((p->>'is_orderable')::boolean, is_orderable),
      is_active      = coalesce((p->>'is_active')::boolean, is_active),
      is_reorderable = coalesce((p->>'is_reorderable')::boolean, is_reorderable),
      visible_ranks  = case when p ? 'visible_ranks'
                            then (select array_agg(x) from jsonb_array_elements_text(p->'visible_ranks') x)
                            else visible_ranks end,
      updated_at     = now()
    where id = v_id;
    if not found then raise exception '商品が見つかりません'; end if;
  else
    insert into portal_products (species, display_name, grade_label, description, sort_order,
                                 min_order_kg, step_kg, low_kg, portal_visible, is_orderable,
                                 is_active, is_reorderable)
    values (p->>'species', p->>'display_name', nullif(p->>'grade_label',''), nullif(p->>'description',''),
            coalesce((p->>'sort_order')::int, 100),
            coalesce((p->>'min_order_kg')::numeric, 0.5), coalesce((p->>'step_kg')::numeric, 0.5),
            coalesce((p->>'low_kg')::numeric, 3.0),
            coalesce((p->>'portal_visible')::boolean, false), coalesce((p->>'is_orderable')::boolean, true),
            true, coalesce((p->>'is_reorderable')::boolean, true))
    returning id into v_id;
  end if;

  if p ? 'parts' then
    delete from portal_product_parts where product_id = v_id;
    for v_part in select * from jsonb_array_elements(p->'parts') loop
      insert into portal_product_parts (product_id, part_name, grade)
      values (v_id, v_part->>'part_name', nullif(v_part->>'grade',''));
    end loop;
  end if;

  if p ? 'prices' then
    delete from portal_product_prices where product_id = v_id;
    for v_price in select * from jsonb_array_elements(p->'prices') loop
      if (v_price->>'unit_price') is not null then
        insert into portal_product_prices (product_id, price_rank, unit_price)
        values (v_id, v_price->>'price_rank', (v_price->>'unit_price')::int);
      end if;
    end loop;
  end if;

  return v_id;
end;
$$;

-- ── 6. 監査ログとロールバックの整理（現状の一覧） ──────────────────
-- 残る（正常終了パスでコミットされる）:
--   signup_rate_limited（jsonb返却に変更済み） / recovery_failed（false返却） /
--   staff_key の試行記録（staff_key_ok 直接呼び出し） / staff_key_rotated（成功時）
-- 残らない（例外でトランザクションごと巻き戻る・仕様として明記）:
--   admin_* RPC に誤ったスタッフキーを渡した場合の試行記録
--   （攻撃の現実的入口は staff_key_ok 直接呼び出しでありそちらは記録される。
--     この経路の本格的な記録・制限は Supabase Auth / Edge 移行時に実施）