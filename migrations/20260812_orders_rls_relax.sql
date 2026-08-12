-- 出荷一覧・BASE取込・直接出荷など日常業務をスタッフキーなしで行えるようにする
-- （2026-08-12 オーナー判断: スタッフキーはマスタデータ＝顧客台帳の操作だけに求める）
--
-- 変更内容:
--   * orders / order_items: SELECT / INSERT / UPDATE を anon に開放（20260809_rls_tighten の部分的な巻き戻し）
--     DELETE ポリシーは作らない = 物理削除は引き続き不可
--   * customers（顧客マスタ）: 変更なし。スタッフキーのヘッダ必須のまま
--   * staff_lookup_customer_id(): 直接出荷で「顧客名→顧客ID」の解決だけを行う SECURITY DEFINER RPC。
--     customers を開けずに、名前が一意に一致したときだけ id を返す（住所・電話等は返さない）
--
-- ⚠ リスク（オーナー了承済み）:
--   anon キーの保有者が注文データ（配送先の氏名・住所・電話を含む）を読み書きできる状態に戻る。
--   顧客マスタ718件の一覧・書き換えは引き続き遮断される。
--   元へ戻す: migrations/rollback/20260812_orders_rls_relax_rollback.sql
--   （20260809_rls_tighten と同じキー必須ポリシーを再作成する）

-- ── orders / order_items ─────────────────────────────────────────
drop policy if exists orders_staff_all on orders;
drop policy if exists orders_anon_select on orders;
drop policy if exists orders_anon_insert on orders;
drop policy if exists orders_anon_update on orders;
create policy orders_anon_select on orders for select to anon, authenticated using (true);
create policy orders_anon_insert on orders for insert to anon, authenticated with check (true);
create policy orders_anon_update on orders for update to anon, authenticated using (true) with check (true);
-- DELETE ポリシーは作らない（誤削除・悪意の削除は不可のまま）

drop policy if exists order_items_staff_all on order_items;
drop policy if exists order_items_anon_select on order_items;
drop policy if exists order_items_anon_insert on order_items;
drop policy if exists order_items_anon_update on order_items;
create policy order_items_anon_select on order_items for select to anon, authenticated using (true);
create policy order_items_anon_insert on order_items for insert to anon, authenticated with check (true);
create policy order_items_anon_update on order_items for update to anon, authenticated using (true) with check (true);

-- ── 直接出荷の顧客ID解決（名前→id のみ。マスタは開けない） ───────
create or replace function staff_lookup_customer_id(p_name text)
returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_ids uuid[];
begin
  if p_name is null or btrim(p_name) = '' then return null; end if;
  select array_agg(c.id) into v_ids
    from customers c
   where c.name = btrim(p_name) and c.is_active is not false;
  -- 名前が一意に決まるときだけ返す（同名複数・該当なしは null）
  if coalesce(array_length(v_ids, 1), 0) = 1 then return v_ids[1]; end if;
  return null;
end;
$$;
revoke all on function staff_lookup_customer_id(text) from public;
grant execute on function staff_lookup_customer_id(text) to anon, authenticated;
