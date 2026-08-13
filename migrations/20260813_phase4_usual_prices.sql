-- フェーズ4(3/3): 「いつもの商品」の自動生成・顧客別価格の比較表・ポータル利用確認 2026-08-13
--
-- 前提: 20260809_portal_products.sql（resolve_unit_price / portal_products / customer_product_prices /
--        customers.portal_enabled）、20260810_phase3_hardening.sql（customer_usual_items の器）、
--        20260811/20260812/20260813（請求書取込・確認・ハードニング＝customer_purchase_facts）
--
-- 方針:
--  * 「いつもの商品」(customer_usual_items) は customer_purchase_facts（canceled_at is null のみ）から
--    自動集計する。取消済み実績は必ず除外する。
--  * customer_saved_items（お客様の手動お気に入り／マイリスト）は集計で一切変更・削除しない。
--  * is_pinned / is_hidden（人手の上書き）は再集計で保持する。
--  * すべて admin_* RPC。先頭で staff_key_ok。SECURITY DEFINER + search_path 固定。
--    PUBLIC から EXECUTE を剥奪し、必要な RPC だけ anon/authenticated へ GRANT。
--  * 住所・電話・スタッフキーはログへ出さない。
--
-- ロールバック: migrations/rollback/20260813_phase4_usual_prices_rollback.sql

-- ── 「いつもの商品」の自動再集計（購入実績から生成） ──────────────────
-- p_customer_id を渡すとその顧客だけ、null で全顧客を再集計する。
-- 対象実績: customer_purchase_facts の canceled_at is null（取消済みは除外）。
-- 対象商品: portal_products の is_active かつ is_reorderable（「いつもの候補にしてよい」商品）。
create or replace function admin_recompute_usual_items(p_staff_key text, p_customer_id uuid default null, p_by text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_customers int; v_items int;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;

  with agg as (
    select f.customer_id, f.product_id,
           count(*)                         as purchase_count,
           sum(f.weight_kg)                 as total_kg,
           avg(f.weight_kg)                 as avg_order_kg,
           max(f.purchased_on)              as last_purchased_on,
           case when count(*) > 1
                then (max(f.purchased_on) - min(f.purchased_on))::numeric / (count(*) - 1)
                else null end               as avg_interval_days
      from customer_purchase_facts f
      join portal_products p on p.id = f.product_id
       and coalesce(p.is_active, true) and coalesce(p.is_reorderable, true)
     where f.canceled_at is null                      -- 取消済み実績は集計から除外
       and (p_customer_id is null or f.customer_id = p_customer_id)
     group by f.customer_id, f.product_id
  ),
  ranked as (
    select a.*,
           row_number() over (partition by a.customer_id
             order by a.purchase_count desc, a.total_kg desc, a.last_purchased_on desc) as rk
      from agg a
  ),
  upserted as (
    insert into customer_usual_items
      (customer_id, product_id, rank, purchase_count, total_kg, avg_order_kg, usual_qty_kg,
       last_purchased_on, avg_interval_days, reason, computed_at)
    select customer_id, product_id, rk, purchase_count, round(total_kg,2), round(avg_order_kg,2),
           round(avg_order_kg,2), last_purchased_on, round(avg_interval_days,1),
           '購入実績 '||purchase_count||'回・合計'||round(total_kg,1)||'kg', now()
      from ranked
    on conflict (customer_id, product_id) do update set
      rank = excluded.rank, purchase_count = excluded.purchase_count, total_kg = excluded.total_kg,
      avg_order_kg = excluded.avg_order_kg, usual_qty_kg = excluded.usual_qty_kg,
      last_purchased_on = excluded.last_purchased_on, avg_interval_days = excluded.avg_interval_days,
      reason = excluded.reason, computed_at = now()
      -- is_pinned / is_hidden は更新対象に含めない → 人手の上書きを保持する
    returning customer_id
  )
  select count(distinct customer_id), count(*) into v_customers, v_items from ranked;

  -- 実績が無くなった商品を除く（ただし is_pinned は人手で残しているので消さない）。
  -- customer_saved_items は参照も更新もしない。
  delete from customer_usual_items u
   where (p_customer_id is null or u.customer_id = p_customer_id)
     and not u.is_pinned
     and not exists (
       select 1 from customer_purchase_facts f
        join portal_products p on p.id = f.product_id
         and coalesce(p.is_active, true) and coalesce(p.is_reorderable, true)
       where f.canceled_at is null
         and f.customer_id = u.customer_id and f.product_id = u.product_id);

  return jsonb_build_object('ok', true, 'customers', v_customers, 'items', v_items);
end;
$$;
revoke all on function admin_recompute_usual_items(text, uuid, text) from public;
grant execute on function admin_recompute_usual_items(text, uuid, text) to anon, authenticated;

-- ── 顧客の「いつもの商品」一覧（確認画面用・スタッフ側） ──────────────
create or replace function admin_customer_usual_items(p_staff_key text, p_customer_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'product_id', u.product_id, 'species', p.species, 'display_name', p.display_name,
      'grade_label', p.grade_label, 'rank', u.rank, 'purchase_count', u.purchase_count,
      'total_kg', u.total_kg, 'avg_order_kg', u.avg_order_kg, 'usual_qty_kg', u.usual_qty_kg,
      'last_purchased_on', u.last_purchased_on, 'avg_interval_days', u.avg_interval_days,
      'reason', u.reason, 'is_pinned', u.is_pinned, 'is_hidden', u.is_hidden,
      'computed_at', u.computed_at) order by u.is_pinned desc, u.rank), '[]'::jsonb)
    into v
    from customer_usual_items u join portal_products p on p.id = u.product_id
   where u.customer_id = p_customer_id;
  return v;
end;
$$;
revoke all on function admin_customer_usual_items(text, uuid) from public;
grant execute on function admin_customer_usual_items(text, uuid) to anon, authenticated;

-- ── 顧客別 価格比較表 ────────────────────────────────────────────────
-- 選んだ顧客について、全ポータル商品の「適用価格・出所」と standard / ランク価格 / 個別価格を
-- 並べ、standard との差額を出す。個別価格の付け間違い（極端に安い/高い）の点検に使う。
create or replace function admin_customer_price_comparison(p_staff_key text, p_customer_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb; v_rank text;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  select price_rank into v_rank from customers where id = p_customer_id;
  if not found then raise exception '顧客が見つかりません'; end if;

  select coalesce(jsonb_agg(x order by x_sort, x_species, x_name), '[]'::jsonb) into v from (
    select jsonb_build_object(
        'product_id', p.id, 'species', p.species, 'display_name', p.display_name, 'grade_label', p.grade_label,
        'resolved_price', rp.unit_price, 'price_source', rp.price_source, 'price_rank_applied', rp.price_rank_applied,
        'standard_price', std.unit_price,
        'rank_label', coalesce(v_rank,'standard'),
        'rank_price', rnk.unit_price,
        'override_price', ovr.unit_price, 'has_override', (ovr.unit_price is not null),
        'diff_vs_standard', case when rp.unit_price is not null and std.unit_price is not null
                                 then rp.unit_price - std.unit_price else null end,
        'orderable', (coalesce(p.is_orderable,false) and rp.unit_price is not null)
      ) as x, p.sort_order as x_sort, p.species as x_species, p.display_name as x_name
      from portal_products p
      left join lateral (select * from resolve_unit_price(p_customer_id, p.id)) rp on true
      left join lateral (select unit_price from portal_product_prices where product_id = p.id and price_rank = 'standard' limit 1) std on true
      left join lateral (select unit_price from portal_product_prices where product_id = p.id and price_rank = coalesce(v_rank,'standard') limit 1) rnk on true
      left join lateral (select unit_price from customer_product_prices
                          where customer_id = p_customer_id and product_id = p.id
                            and (valid_from is null or valid_from <= current_date)
                            and (valid_until is null or valid_until >= current_date) limit 1) ovr on true
     where coalesce(p.is_active, true)
  ) t;
  return v;
end;
$$;
revoke all on function admin_customer_price_comparison(text, uuid) from public;
grant execute on function admin_customer_price_comparison(text, uuid) to anon, authenticated;

-- ── ポータル利用（portal_enabled）の確認一覧 ─────────────────────────
create or replace function admin_list_portal_enabled(p_staff_key text, p_filter text default 'all')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  select coalesce(jsonb_agg(x order by x_code), '[]'::jsonb) into v from (
    select jsonb_build_object(
        'id', c.id, 'code', c.code, 'name', c.name, 'price_rank', coalesce(c.price_rank,'standard'),
        'is_active', c.is_active, 'portal_enabled', c.portal_enabled,
        'has_login', (nullif(btrim(coalesce(c.portal_login_id,'')),'') is not null),
        'order_count', (select count(*) from orders o where o.customer_id = c.id),
        'usual_items', (select count(*) from customer_usual_items u where u.customer_id = c.id)
      ) as x, c.code as x_code
      from customers c
     where case coalesce(p_filter,'all')
             when 'enabled'  then c.portal_enabled is true
             when 'disabled' then c.portal_enabled is not true
             else true end
     order by c.code
     limit 2000
  ) t;
  return v;
end;
$$;
revoke all on function admin_list_portal_enabled(text, text) from public;
grant execute on function admin_list_portal_enabled(text, text) to anon, authenticated;

-- ── ポータル利用の有効化 / 無効化（スタッフキー必須・監査） ───────────
create or replace function admin_set_portal_enabled(p_staff_key text, p_customer_id uuid, p_enabled boolean, p_by text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_code text; v_name text; v_actor text := btrim(coalesce(p_by,''));
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if length(v_actor) = 0 or length(v_actor) > 80 then raise exception '担当者名を入力してください（80文字以内）'; end if;
  select code, name into v_code, v_name from customers where id = p_customer_id;
  if not found then raise exception '顧客が見つかりません'; end if;
  update customers set portal_enabled = coalesce(p_enabled, false) where id = p_customer_id;
  -- 監査（顧客コード・名のみ。住所/電話/キーは残さない）
  insert into security_events (event, detail)
  values ('portal_enabled_change',
    v_actor||' が '||coalesce(v_code,'')||' '||coalesce(v_name,'')||' を '
    ||case when p_enabled then 'ポータル利用可' else 'ポータル利用停止' end||'に変更');
  return jsonb_build_object('ok', true, 'portal_enabled', coalesce(p_enabled,false));
end;
$$;
revoke all on function admin_set_portal_enabled(text, uuid, boolean, text) from public;
grant execute on function admin_set_portal_enabled(text, uuid, boolean, text) to anon, authenticated;

notify pgrst, 'reload schema';
