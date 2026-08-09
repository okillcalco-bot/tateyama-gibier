-- レビュー指摘の反映（その2）: スタッフキー変更権限の分離・試行制限・監査ログ・
-- 実重量超過の基準統一・登録RPCの競合対策
--
-- 1. スタッフキーの変更は「管理者用回復コード」が必要になる
--    （通常のスタッフキーを知っているだけでは変更できない＝スタッフが全端末を締め出せない）
--    旧 staff_key_set(現在キー, 新キー) は廃止。
--    回復コード自体の再設定は Supabase の SQL Editor でのみ行う（手順は計画書）。
-- 2. 認証試行の回数制限（スタッフキー10回/5分・回復コード5回/15分）と監査ログ
-- 3. 注文の実重量超過の基準を統一:
--    ・希望量の20%超 → 注文は通すが「要確認」。発送前にセンターから連絡する
--    ・希望量の50%超 → お断りして数量調整を案内（画面・DB・運用で同じ数値）
-- 4. 登録RPCの回数制限を advisory lock で直列化（同時リクエストでも突破されない）
--
-- ロールバック: migrations/rollback/20260810_staffkey_governance_rollback.sql

-- ── 監査ログと試行記録 ────────────────────────────────────────────
create table if not exists security_events (
  id uuid primary key default gen_random_uuid(),
  event text not null,          -- staff_key_rotated / recovery_failed / signup_rate_limited …
  detail text,
  created_at timestamptz not null default now()
);
alter table security_events enable row level security;   -- anonポリシーなし＝RPC経由のみ

create table if not exists auth_attempts (
  id bigint generated always as identity primary key,
  kind text not null,           -- staff_key / recovery
  ok boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists auth_attempts_recent on auth_attempts (kind, created_at);
alter table auth_attempts enable row level security;

-- ── スタッフキー照合: 試行制限つき ────────────────────────────────
-- 比較は bcrypt(crypt) / sha256 のハッシュ同士で行うため、文字列比較の時間差から
-- キーそのものは推定できない。総当たりはこの回数制限と、キー自体の長さで抑える。
-- 注: 失敗時に例外を投げる経路（admin_* の「スタッフキーが違います」）では、
--     トランザクションごと巻き戻るため失敗ログは残らない。総当たりの現実的な入口は
--     この関数の直接呼び出し（falseで正常終了＝ログが残る）であり、そこで制限が効く。
--     残るリスクはキー長（16文字以上を強制）で抑える。詳細は計画書 §暫定認証。
create or replace function staff_key_ok(p_staff_key text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_fail int; v_ok boolean;
begin
  select count(*) into v_fail from auth_attempts
   where kind = 'staff_key' and not ok and created_at > now() - interval '5 minutes';
  if v_fail >= 10 then
    raise exception '試行回数が多すぎます。しばらくおいてからお試しください';
  end if;
  select hash into v_hash from app_secrets where key = 'staff_key';
  v_ok := v_hash is not null and v_hash = extensions.crypt(coalesce(p_staff_key,''), v_hash);
  insert into auth_attempts (kind, ok) values ('staff_key', v_ok);
  return v_ok;
end;
$$;

-- ── キーの変更（回復コード必須） ──────────────────────────────────
drop function if exists staff_key_set(text, text);   -- 通常キーだけでの変更は廃止

create or replace function admin_rotate_staff_key(p_recovery_code text, p_new_key text)
returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_fail int;
begin
  select count(*) into v_fail from auth_attempts
   where kind = 'recovery' and not ok and created_at > now() - interval '15 minutes';
  if v_fail >= 5 then
    insert into security_events (event, detail) values ('recovery_locked', '15分以内に5回失敗');
    raise exception '試行回数が多すぎます。しばらくおいてからお試しください';
  end if;

  select hash into v_hash from app_secrets where key = 'recovery_code';
  if v_hash is null or v_hash <> extensions.crypt(coalesce(p_recovery_code,''), v_hash) then
    insert into auth_attempts (kind, ok) values ('recovery', false);
    insert into security_events (event) values ('recovery_failed');
    -- 例外を投げると失敗ログごとロールバックされ試行制限が効かないため、falseで返す
    return false;
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
grant execute on function admin_rotate_staff_key(text, text) to anon, authenticated;

-- ── 高負荷対策: anon の1文の実行時間に上限 ────────────────────────
alter role anon set statement_timeout = '8s';

-- ── 注文の実重量超過の基準統一（20%=要確認 / 50%=お断り） ─────────
create or replace function portal_place_order(
  p_token text, p_items jsonb, p_delivery_date date,
  p_time_zone text default null, p_memo text default null, p_request_id text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  c_review_over constant numeric := 0.20;   -- これを超えたら「要確認」（発送前にセンターから連絡）
  c_max_over    constant numeric := 0.50;   -- これを超える引当はお断り（数量調整を案内）
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

    -- 超過の基準（画面・運用と同じ数値）
    if v_alloc > v_kg * (1 + c_max_over) then
      raise exception '「%」はご希望量に近いパックのご用意が難しいため、このままお受けできません。数量を増やすか、お電話でご相談ください',
        v_prod.display_name;
    end if;
    if v_alloc > v_kg * (1 + c_review_over) then
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
      'needs_review', v_alloc > v_kg * (1 + c_review_over));
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

-- ── 登録RPC: advisory lock で同時リクエストでも制限を突破させない ──
create or replace function public_signup_request(
  p_name text, p_contact text, p_phone text, p_address text,
  p_kana text default null, p_company text default null, p_email text default null,
  p_building text default null, p_time_zone text default '0000',
  p_order_method text default null, p_notify_method text default null, p_notes text default null)
returns text
language plpgsql security definer set search_path = public as $$
declare v_phone text; v_code text; v_recent int;
begin
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

  -- 制限の判定と登録を同一トランザクションで直列化する
  -- （同じ電話番号どうし・全体カウンタを advisory lock で守る）
  perform pg_advisory_xact_lock(hashtext('signup:phone:' || v_phone));
  perform pg_advisory_xact_lock(hashtext('signup:global'));

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
    insert into security_events (event, detail) values ('signup_rate_limited', '1時間20件の上限に到達');
    raise exception 'ただいま混み合っています。時間をおいてお試しいただくか、お電話ください';
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
          false, false, 'signup-form', 'standard');
  return v_code;
end;
$$;

-- 上限到達などの記録をスタッフが見られるように（スタッフキー必須）
create or replace function admin_security_events(p_staff_key text, p_limit int default 50)
returns table (event text, detail text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  return query select s.event, s.detail, s.created_at from security_events s
    order by s.created_at desc limit least(coalesce(p_limit,50), 200);
end;
$$;
grant execute on function admin_security_events(text, int) to anon, authenticated;
