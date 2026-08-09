-- フェーズ1（その2）: 在庫の引当（未開封パック単位）
--
-- 方針（docs/order-site-plan.md §0-6・§5-4）:
--   * 1在庫点（パック）は1注文にのみ引き当てる。パックは分割しない
--   * 重量はグラム相当の整数（10g単位）に正規化してから組み合わせを探す
--     - パックは切り捨て、希望量は切り上げ → 実重量は必ず希望量以上（小数誤差なし）
--   * 優先順位: ①希望量以上 ②超過最小 ③同程度なら古い在庫 ④使用パック数が少ない
--   * FOR UPDATE SKIP LOCKED で先にロックした集合だけを対象に組み合わせを確定する
--     （探索後に未ロック在庫を更新する構造にはしない）
--   * 更新件数が想定と違えば例外 → トランザクション全体がロールバック
--   * inventory_allocations(inventory_id) の一意制約が二重引当の最終防壁
--
-- ロールバック: migrations/rollback/20260809_portal_allocations_rollback.sql

-- ── 1. 引当の記録 ─────────────────────────────────────────────────
create table if not exists inventory_allocations (
  id            uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references order_items(id) on delete cascade,
  inventory_id  uuid not null references inventory(id),
  weight_kg     numeric not null,     -- 原則、元在庫（パック）の重量そのまま
  created_at    timestamptz not null default now()
);
-- 1パック=1注文の最終防壁（SKIP LOCKEDをすり抜けても、ここで必ず止まる）
create unique index if not exists inventory_allocations_pack_once
  on inventory_allocations (inventory_id);
alter table inventory_allocations enable row level security;
-- anon にはポリシーを作らない（読み書きともRPC経由のみ）

-- ── 2. order_items へ注文時点のスナップショット列を追加（すべて nullable・既存行に影響なし） ──
alter table order_items
  add column if not exists product_id_v2      uuid references portal_products(id),
  add column if not exists product_name       text,
  add column if not exists grade_snapshot     text,
  add column if not exists price_rank_applied text,
  add column if not exists price_source       text,   -- customer_override / price_rank / standard
  add column if not exists requested_kg       numeric,
  add column if not exists allocated_kg       numeric;

-- ── 3. 引当の本体 ─────────────────────────────────────────────────
-- 内部関数。anon へは grant しない（フェーズ2の portal_place_order() からだけ呼ぶ）。
-- 戻り値: 実際に引き当てた合計kg。引当できなければ例外（呼び出し側のトランザクションごと戻る）。
create or replace function allocate_for_order_item(
  p_order_item_id uuid, p_product_id uuid, p_requested_kg numeric)
returns numeric
language plpgsql security definer set search_path = public as $$
declare
  c_cap       constant int := 60;     -- DPに渡す候補パック数の上限（古い順に60点＝概ね60kg超をカバー）
  c_max_kg    constant numeric := 30; -- 一度に注文できる上限
  r           record;
  n           int := 0;
  ids         uuid[] := '{}';
  wts_u       int[]  := '{}';         -- 10g単位・切り捨て
  wts_kg      numeric[] := '{}';      -- 実重量（記録用）
  target_u    int;
  bound       int;                    -- DPの上限 = target + 最大パック
  max_wu      int := 0;
  total_u     bigint := 0;
  reach       boolean[];
  agescore    int[];
  packs       int[];
  mask        bigint[];               -- 選んだパックのビット集合（復元の曖昧さを無くす）
  k int; s int; w int; prev int;
  cand_age int; cand_packs int; better boolean;
  best_s      int := -1;
  chosen      uuid[] := '{}';
  chosen_kg   numeric := 0;
  v_cnt       int;
begin
  if p_requested_kg is null or p_requested_kg <= 0 then
    raise exception '数量が正しくありません';
  end if;
  if p_requested_kg > c_max_kg then
    raise exception '一度のご注文は%kgまでです', c_max_kg;
  end if;
  target_u := ceil(p_requested_kg * 100)::int;   -- 10g単位・切り上げ

  -- 候補をロックしてから集める（古い順）。ロックできた集合だけが探索対象。
  -- SKIP LOCKED で除外されたパックは「他の注文が処理中」なので、残りで足りなければ在庫不足として扱う
  -- （相手の注文が確定すればどのみち無い。戻った場合はお客様の再操作で通る）。
  for r in
    select i.id, coalesce(i.weight_kg, i.weight) as kg
      from inventory i
     where i.deleted_at is null and i.status = '在庫'
       and exists (
         select 1 from portal_product_parts pp
           join portal_products p on p.id = pp.product_id
          where pp.product_id = p_product_id
            and i.species = p.species and i.part_name = pp.part_name
            and (pp.grade is null or i.grade = pp.grade))
     order by i.processed_at asc nulls last, i.created_at asc
     limit c_cap
     for update of i skip locked
  loop
    w := floor(r.kg * 100)::int;
    if w <= 0 then continue; end if;         -- 10g未満のパックは対象外
    n := n + 1;
    ids[n] := r.id; wts_u[n] := w; wts_kg[n] := r.kg;
    if w > max_wu then max_wu := w; end if;
    total_u := total_u + w;
  end loop;

  if n = 0 or total_u < target_u then
    raise exception '在庫が不足しています';
  end if;

  -- 部分和DP（0/1）。dp[s] = 合計がちょうど s(10g単位) になる組み合わせのうち
  -- (古さスコア, パック数) が辞書順最小のもの。s は target..target+最大パック の範囲で必ず解が見つかる
  -- （古い順に積めば sum < target+最大パック で target に届くため）。
  bound := target_u + max_wu;
  reach    := array_fill(false, array[bound + 1]);   -- 添字は s+1
  agescore := array_fill(0,     array[bound + 1]);
  packs    := array_fill(0,     array[bound + 1]);
  mask     := array_fill(0::bigint, array[bound + 1]);
  reach[1] := true;   -- s=0

  for k in 1..n loop
    w := wts_u[k];
    s := bound;
    while s >= w loop
      if reach[s - w + 1] and (mask[s - w + 1] & (1::bigint << (k - 1))) = 0 then
        cand_age   := agescore[s - w + 1] + k;   -- ループ順=古い順なので k がそのまま古さの順位
        cand_packs := packs[s - w + 1] + 1;
        if not reach[s + 1] then better := true;
        elsif cand_age <> agescore[s + 1] then better := cand_age < agescore[s + 1];
        else better := cand_packs < packs[s + 1];
        end if;
        if better then
          reach[s + 1]    := true;
          agescore[s + 1] := cand_age;
          packs[s + 1]    := cand_packs;
          mask[s + 1]     := mask[s - w + 1] | (1::bigint << (k - 1));
        end if;
      end if;
      s := s - 1;
    end loop;
  end loop;

  -- 希望量以上で最小の合計（=超過最小）を選ぶ
  s := target_u;
  while s <= bound loop
    if reach[s + 1] then best_s := s; exit; end if;
    s := s + 1;
  end loop;
  if best_s < 0 then
    raise exception '在庫が不足しています';
  end if;

  -- 選んだパックを確定
  for k in 1..n loop
    if (mask[best_s + 1] & (1::bigint << (k - 1))) <> 0 then
      chosen := chosen || ids[k];
      chosen_kg := chosen_kg + wts_kg[k];
      insert into inventory_allocations (order_item_id, inventory_id, weight_kg)
      values (p_order_item_id, ids[k], wts_kg[k]);
    end if;
  end loop;

  -- ロック済み集合に対する更新。件数が想定と違えば全体ロールバック
  update inventory set status = '引当済', updated_at = now()
   where id = any(chosen) and status = '在庫';
  get diagnostics v_cnt = row_count;
  if v_cnt <> coalesce(array_length(chosen, 1), 0) then
    raise exception '引当の更新件数が一致しません（%/%）。処理を取り消します',
      v_cnt, coalesce(array_length(chosen, 1), 0);
  end if;

  update order_items
     set requested_kg = p_requested_kg, allocated_kg = chosen_kg
   where id = p_order_item_id;

  return chosen_kg;
end;
$$;
-- 意図的に grant しない（内部専用。フェーズ2で portal_place_order() から呼ぶ）
revoke all on function allocate_for_order_item(uuid, uuid, numeric) from public, anon, authenticated;

-- ── 4. 引当の戻し（キャンセル時） ─────────────────────────────────
-- 注文がキャンセルされたら、引当済のパックを在庫へ戻す。二重に戻らない
-- （allocations の行を消しながら戻すので、2回呼んでも2回目は0件）。
create or replace function release_allocations_for_order(p_order_id uuid)
returns int
language plpgsql security definer set search_path = public as $$
declare v_cnt int := 0;
begin
  with del as (
    delete from inventory_allocations a
     using order_items oi
     where oi.id = a.order_item_id and oi.order_id = p_order_id
     returning a.inventory_id
  )
  update inventory i set status = '在庫', updated_at = now()
    from del where i.id = del.inventory_id and i.status = '引当済';
  get diagnostics v_cnt = row_count;
  return v_cnt;
end;
$$;
revoke all on function release_allocations_for_order(uuid) from public, anon, authenticated;
