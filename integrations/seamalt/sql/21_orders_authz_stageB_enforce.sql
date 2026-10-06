-- ============================================================================
-- 既存の直接アクセス経路の認可移行 — 段階B: anon は「スタッフキーのヘッダ」がある要求だけ orders / order_items を読み書きできる
-- 状態: 【案・本番未適用】段階Aの計測で「キー無しの書込み=0」を確認し、本人の承認を得てから適用
-- ============================================================================
-- 内容は migrations/rollback/20260812_orders_rls_relax_rollback.sql と同じ形（2026-08-09 のキー必須ポリシー）。
-- 影響: スタッフキー未設定の端末では、出荷一覧・BASE取込・直接出荷で注文が読めず書けなくなる。
--       → 適用前に、出荷で使う全端末へスタッフキーの共有リンクを配って設定する（docs/03-approval.md の手順）。
-- 影響しないもの: 顧客ポータル（portal_* は SECURITY DEFINER 関数経由）、service_role を使う処理、
--       order_link.api_*（MCP）、物理削除（もともと DELETE ポリシー無し）。
-- staff_lookup_customer_id / staff_register_customer_on_ship（直接出荷の顧客解決）はそのまま残す。
begin;
drop policy if exists orders_anon_select on public.orders;
drop policy if exists orders_anon_insert on public.orders;
drop policy if exists orders_anon_update on public.orders;
drop policy if exists orders_staff_all on public.orders;
create policy orders_staff_all on public.orders
  for all to anon, authenticated using ((select staff_key_header_ok())) with check ((select staff_key_header_ok()));

drop policy if exists order_items_anon_select on public.order_items;
drop policy if exists order_items_anon_insert on public.order_items;
drop policy if exists order_items_anon_update on public.order_items;
drop policy if exists order_items_staff_all on public.order_items;
create policy order_items_staff_all on public.order_items
  for all to anon, authenticated using ((select staff_key_header_ok())) with check ((select staff_key_header_ok()));
commit;
