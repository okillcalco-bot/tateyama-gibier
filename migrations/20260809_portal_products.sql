-- フェーズ1（その1）: ポータル商品マスタ・顧客別価格・価格解決の一元化
--
-- 方針（docs/order-site-plan.md §0・§5）:
--   * 追加のみ。既存テーブルの列削除・改名・行の書き換えはしない
--   * 表示用の「商品」と在庫の「部位×等級」を portal_product_parts で結ぶ
--     （在庫の名称は変更しない。カタ ↔ カタ（ウデ） のような揺れは対応表で吸収）
--   * 価格の決定はDB側の resolve_unit_price() に一元化する
--     （画面表示と注文確定が別ロジックを持たない）
--   * 新テーブルへの書き込みは anon に開けない。スタッフキーを照合するRPCだけが書ける
--
-- ロールバック: migrations/rollback/20260809_portal_products_rollback.sql

-- ── 1. 商品マスタ ────────────────────────────────────────────────
create table if not exists portal_products (
  id             uuid primary key default gen_random_uuid(),
  species        text not null,                 -- イノシシ / シカ / キョン …
  display_name   text not null,                 -- お客様に見せる名前
  grade_label    text,                          -- 表示用の等級（並・上など）
  description    text,                          -- タップで展開する説明
  sort_order     int  not null default 100,
  min_order_kg   numeric not null default 0.5 check (min_order_kg > 0),
  step_kg        numeric not null default 0.5 check (step_kg > 0),
  low_kg         numeric not null default 3.0,  -- これ未満は △
  portal_visible boolean not null default false,-- ポータルに出すか
  is_orderable   boolean not null default true, -- 注文を受けるか（公開でも停止できる）
  is_active      boolean not null default true, -- マスタとして有効か（販売終了）
  is_reorderable boolean not null default true, -- 「いつもの」候補にしてよいか
  visible_ranks  text[],                        -- null = 全価格ランクに公開
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (species, display_name)
);

-- 1商品 = 在庫の部位×等級の組み合わせ（複数可・在庫側の名称は変えない）
create table if not exists portal_product_parts (
  product_id uuid not null references portal_products(id) on delete cascade,
  part_name  text not null,
  grade      text                                -- null = 等級を問わない
);
create unique index if not exists portal_product_parts_uq
  on portal_product_parts (product_id, part_name, coalesce(grade, ''));

-- ランク別の価格
create table if not exists portal_product_prices (
  product_id uuid not null references portal_products(id) on delete cascade,
  price_rank text not null,                      -- standard / local / startmember
  unit_price int  not null check (unit_price >= 0),
  primary key (product_id, price_rank)
);

-- 顧客×商品の個別価格（最優先。期間つき）
create table if not exists customer_product_prices (
  customer_id uuid not null references customers(id) on delete cascade,
  product_id  uuid not null references portal_products(id) on delete cascade,
  unit_price  int  not null check (unit_price >= 0),
  valid_from  date,
  valid_until date,
  note        text,
  updated_by  text,
  updated_at  timestamptz not null default now(),
  primary key (customer_id, product_id)
);

-- ポータル案内の有効化フラグ（既定 false。
-- 現時点でこの列を読む処理は無いため、追加しても挙動は変わらない。
-- 価格の照合が済んだ顧客だけ手動で true にする。ロールバックは列 drop）
alter table customers add column if not exists portal_enabled boolean not null default false;

-- ── 2. RLS: 読みはカタログのみ・書きはRPC経由のみ ─────────────────
alter table portal_products        enable row level security;
alter table portal_product_parts   enable row level security;
alter table portal_product_prices  enable row level security;
alter table customer_product_prices enable row level security;

-- カタログは読める（商品名・価格は公開情報）。書き込みポリシーは作らない
drop policy if exists portal_products_read on portal_products;
create policy portal_products_read on portal_products for select to anon using (true);
drop policy if exists portal_product_parts_read on portal_product_parts;
create policy portal_product_parts_read on portal_product_parts for select to anon using (true);
drop policy if exists portal_product_prices_read on portal_product_prices;
create policy portal_product_prices_read on portal_product_prices for select to anon using (true);
-- customer_product_prices は個社の価格なので anon には一切開けない（ポリシー無し）

-- ── 3. 価格解決の一元化 ──────────────────────────────────────────
-- 優先順位: ①顧客×商品の個別価格（期間内） ②顧客の価格ランク ③standard ④無ければ0行=注文不可
-- 画面表示も注文確定も必ずこの関数を通す。
create or replace function resolve_unit_price(p_customer_id uuid, p_product_id uuid, p_on date default current_date)
returns table (unit_price int, price_source text, price_rank_applied text)
language plpgsql stable security definer set search_path = public as $$
declare v_rank text;
begin
  -- ① 個別価格
  return query
    select cpp.unit_price, 'customer_override'::text, null::text
      from customer_product_prices cpp
     where cpp.customer_id = p_customer_id and cpp.product_id = p_product_id
       and (cpp.valid_from  is null or cpp.valid_from  <= p_on)
       and (cpp.valid_until is null or cpp.valid_until >= p_on)
     limit 1;
  if found then return; end if;

  -- ② 顧客の価格ランク
  select c.price_rank into v_rank from customers c where c.id = p_customer_id;
  if v_rank is not null and v_rank <> 'standard' then
    return query
      select ppp.unit_price, 'price_rank'::text, v_rank
        from portal_product_prices ppp
       where ppp.product_id = p_product_id and ppp.price_rank = v_rank
       limit 1;
    if found then return; end if;
  end if;

  -- ③ standard
  return query
    select ppp.unit_price, 'standard'::text, 'standard'::text
      from portal_product_prices ppp
     where ppp.product_id = p_product_id and ppp.price_rank = 'standard'
     limit 1;
  -- ④ 見つからなければ0行（呼び出し側で注文不可にする）
end;
$$;
grant execute on function resolve_unit_price(uuid, uuid, date) to anon, authenticated;

-- ── 4. 在庫記号（実重量は返さない） ──────────────────────────────
create or replace function portal_stock_marks()
returns table (product_id uuid, mark text)
language sql stable security definer set search_path = public as $$
  select p.id,
         case when coalesce(s.kg, 0) >= p.low_kg       then '◎'
              when coalesce(s.kg, 0) >= p.min_order_kg then '△'
              else '×' end
    from portal_products p
    left join lateral (
      select sum(coalesce(i.weight_kg, i.weight)) as kg
        from portal_product_parts pp
        join inventory i
          on i.deleted_at is null and i.status = '在庫'
         and i.species = p.species and i.part_name = pp.part_name
         and (pp.grade is null or i.grade = pp.grade)
       where pp.product_id = p.id
    ) s on true
   where p.is_active;
$$;
grant execute on function portal_stock_marks() to anon, authenticated;

-- ── 5. 商品マスタの編集（スタッフキーを知っている人だけ） ─────────
create or replace function admin_upsert_product(p_staff_key text, p jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_part jsonb; v_price jsonb;
begin
  if not staff_key_ok(p_staff_key) then
    raise exception 'スタッフキーが違います';
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

  -- 部位の対応（渡されたときだけ総入れ替え）
  if p ? 'parts' then
    delete from portal_product_parts where product_id = v_id;
    for v_part in select * from jsonb_array_elements(p->'parts') loop
      insert into portal_product_parts (product_id, part_name, grade)
      values (v_id, v_part->>'part_name', nullif(v_part->>'grade',''));
    end loop;
  end if;

  -- ランク別価格（渡されたときだけ総入れ替え）
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
grant execute on function admin_upsert_product(text, jsonb) to anon, authenticated;

-- 顧客×商品の個別価格の登録・削除（スタッフキー必須）
create or replace function admin_set_customer_price(
  p_staff_key text, p_customer_id uuid, p_product_id uuid,
  p_unit_price int, p_valid_from date default null, p_valid_until date default null,
  p_note text default null, p_by text default null)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if p_unit_price is null then
    delete from customer_product_prices where customer_id = p_customer_id and product_id = p_product_id;
  else
    insert into customer_product_prices (customer_id, product_id, unit_price, valid_from, valid_until, note, updated_by)
    values (p_customer_id, p_product_id, p_unit_price, p_valid_from, p_valid_until, p_note, p_by)
    on conflict (customer_id, product_id) do update
      set unit_price = excluded.unit_price, valid_from = excluded.valid_from,
          valid_until = excluded.valid_until, note = excluded.note,
          updated_by = excluded.updated_by, updated_at = now();
  end if;
end;
$$;
grant execute on function admin_set_customer_price(text, uuid, uuid, int, date, date, text, text) to anon, authenticated;

-- ── 6. 初期データ（施主決定 2026-08-09。冪等） ────────────────────
-- 在庫は並が主体のため、公開商品は price_master の「並」の価格でシードする（等級のねじれ解消）。
-- 非公開・価格未設定の商品は「価格なし=注文不可」の規則で安全側に倒れる。
do $$
declare
  v_id uuid;
  r record;
begin
  for r in select * from (values
    -- species, 商品名, 等級表示, 公開, 注文可, 並び, 部位(在庫側名称;複数は|区切り), 等級条件,
    -- standard, local, startmember（null=価格未設定）
    ('イノシシ','猪ロース',        '並', true,  true,  10, 'ロース',                 '並', 3800, 3300, 3000),
    ('イノシシ','猪肩ロース',      '並', true,  true,  20, '肩ロース',               '並', 3100, 2800, 2500),
    ('イノシシ','猪バラ',          '並', true,  true,  30, 'バラ',                   '並', 3100, 2800, 2500),
    ('イノシシ','猪カタ（ウデ）',  '並', true,  true,  40, 'カタ|カタ（ウデ）',      '並', 2200, 2100, 1800),
    ('イノシシ','猪ネック',        '並', true,  true,  50, 'ネック',                 '並', 1800, 1800, 1600),
    ('イノシシ','猪スネ',          '並', true,  true,  60, 'スネ',                   '並', 1600, 1500, 1500),
    ('イノシシ','猪ヒレ',          '並', true,  true,  70, 'ヒレ',                   '並', 3800, 3300, 3000),
    ('イノシシ','猪粗挽きミンチ',  '上', true,  true,  80, 'ミンチ肉（粗挽き）',     '上', 3125, 2750, 2750),
    -- 非公開（施主確認後に手動で公開）
    ('イノシシ','ミンチ原料用',            '並', false, false, 110, 'ミンチ用',               '並', 1600, 1500, 1500),
    ('イノシシ','猪ペットフード・骨あり',  '並', false, false, 120, 'ペットフード用（あり）', '並', null, null, null),
    ('イノシシ','猪ペットフード・骨なし',  '並', false, false, 130, 'ペットフード用（なし）', '並', null, null, null),
    ('イノシシ','内部用途（味肉用）',      '並', false, false, 140, '味肉用',                 '並', null, null, null),
    ('イノシシ','希少部位（チチカブ）',    '並', false, false, 150, 'チチカブ',               '並', null, null, null),
    ('シカ',    '鹿ロース',                '並', false, false, 210, 'ロース',                 '並', null, null, null),
    ('シカ',    '鹿モモ（ウチ）',          '並', false, false, 220, 'モモ（ウチ）',           '並', null, null, null),
    ('キョン',  'キョン商品（ロース）',    '並', false, false, 310, 'ロース',                 '並', null, null, null)
  ) as t(sp, nm, gl, vis, ord, so, parts, gr, ps, pl, pm)
  loop
    insert into portal_products (species, display_name, grade_label, sort_order,
                                 portal_visible, is_orderable, is_active)
    values (r.sp, r.nm, r.gl, r.so, r.vis, r.ord, true)
    on conflict (species, display_name) do nothing
    returning id into v_id;
    if v_id is null then
      select id into v_id from portal_products where species = r.sp and display_name = r.nm;
      continue;  -- 既にある場合は部位・価格も触らない（冪等・上書きしない）
    end if;

    insert into portal_product_parts (product_id, part_name, grade)
    select v_id, x, r.gr from unnest(string_to_array(r.parts, '|')) x
    on conflict do nothing;

    if r.ps is not null then
      insert into portal_product_prices (product_id, price_rank, unit_price) values
        (v_id, 'standard', r.ps), (v_id, 'local', r.pl), (v_id, 'startmember', r.pm)
      on conflict do nothing;
    end if;
    v_id := null;
  end loop;
end $$;

comment on table portal_products is
  'ポータルに出す商品。在庫の部位名とは portal_product_parts で対応づける（在庫側の名称は変えない）。';
comment on table customer_product_prices is
  '顧客×商品の個別価格（期間つき・最優先）。書き込みは admin_set_customer_price() のみ。';
comment on table customer_prices is
  '旧・顧客別価格（species/part_name基準）。未使用のまま残置。今後は customer_product_prices を使う。';
