-- 料理タブ（レシピの蓄積・栄養成分の自動計算・商品との紐づけ）: 追加のみ
--
-- 2026-09-21 「加工調理とは別タブで料理タブを作って、レシピを蓄積できるようにしたい。
--   その際に添付の栄養成分も自動で計算して、商品と紐づけできるようにして。将来的にはそこからラベルも出せるようにしたい。」
--
-- 栄養成分の計算は大阪市「栄養算（えいようさん）ver2.7」と同じ考え方:
--   材料ごとに 可食部100gあたりの成分値 × 重量(g) ÷ 100 を合計 → 人数で割って1人分。
--   成分表は日本食品標準成分表2020年版（八訂）増補2023年（data/food-composition-8th.json に静的に持つ）。
--   成分表に無い自社原料（味付けだれ・仕入れ調味料など）は recipe_foods に「追加食品」として登録する（栄養算の「追加食品（個人設定）」に相当）。
--
--   recipes       : 料理1件。nutrition には計算結果のキャッシュ（100gあたり・1人分・合計・原材料名の並び）
--   recipe_items  : 材料。food_no は成分表の食品番号（追加食品は 19001〜）
--   recipe_foods  : 追加食品（個人設定）。nutrients は {成分名: 100gあたりの値}

create table if not exists public.recipe_foods (
  id          uuid primary key default gen_random_uuid(),
  food_no     integer not null unique,
  name        text not null,
  kana        text,
  nutrients   jsonb not null default '{}'::jsonb,
  memo        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table if not exists public.recipes (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  category    text,
  servings    numeric,
  yield_g     numeric,
  product_id  uuid references public.products(id),
  pack_g      numeric,
  steps       text,
  memo        text,
  nutrition   jsonb,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create table if not exists public.recipe_items (
  id          uuid primary key default gen_random_uuid(),
  recipe_id   uuid not null references public.recipes(id) on delete cascade,
  food_no     integer not null,
  food_name   text not null,
  grams       numeric not null default 0,
  note        text,
  sort        integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists recipe_items_recipe_idx on public.recipe_items(recipe_id);
create index if not exists recipes_product_idx on public.recipes(product_id);

alter table public.recipe_foods enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_items enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'recipe_foods' and policyname = 'allow_all') then
    create policy allow_all on public.recipe_foods for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'recipes' and policyname = 'allow_all') then
    create policy allow_all on public.recipes for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'recipe_items' and policyname = 'allow_all') then
    create policy allow_all on public.recipe_items for all using (true) with check (true);
  end if;
end $$;
grant select, insert, update, delete on public.recipe_foods, public.recipes, public.recipe_items to anon, authenticated;
