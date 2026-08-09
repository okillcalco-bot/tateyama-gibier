-- フェーズ2（その2）: RLS引き締め
--
-- ⚠️ 適用タイミングに注意 ⚠️
-- このマイグレーションを適用すると、customers / orders / order_items への
-- 匿名アクセスが「スタッフキーのHTTPヘッダ（x-staff-key）を付けたリクエスト」だけになる。
-- センター側画面（index.html / order-admin.html / sales-dashboard.html）が
-- ヘッダを送る版に本番反映されてから適用すること。先に適用すると本番の画面が読めなくなる。
--
-- これで塞がるもの:
--   * anon キーによる 718件の顧客情報（氏名・住所・電話）の読み取り・書き換え
--   * anon キーによる全注文履歴の読み取り・書き換え
-- 残るもの（フェーズ5のセンター側 Supabase Auth で対応）:
--   * スタッフキーが漏れた場合の危険。キーは staff_key_set() で随時変更できる
--   * documents / payments など他テーブルの anon ポリシー（別途、同様に締める）
--
-- 事前条件: 20260809_portal_sessions_rpc.sql 適用済み、
--           staff_key_register_header() で sha256 登録済み（登録済みを確認してから流す）。
-- ロールバック: migrations/rollback/20260809_rls_tighten_rollback.sql

-- ── customers ────────────────────────────────────────────────────
-- 旧ポリシー（anon/public に全許可）を撤去
drop policy if exists allow_all on customers;
drop policy if exists allow_all_customers on customers;
drop policy if exists portal_customers_select on customers;

-- スタッフキーのヘッダがあるときだけ読める・書ける
create policy customers_staff_select on customers
  for select to anon using ((select staff_key_header_ok()));
create policy customers_staff_update on customers
  for update to anon using ((select staff_key_header_ok()))
  with check ((select staff_key_header_ok()));
create policy customers_staff_delete on customers
  for delete to anon using ((select staff_key_header_ok()));
-- 新規登録フォーム（customer-signup.html）は signup-form 経由の行だけ入れられる
create policy customers_insert on customers
  for insert to anon
  with check (signup_source = 'signup-form' or (select staff_key_header_ok()));

-- ── orders / order_items ─────────────────────────────────────────
drop policy if exists allow_all on orders;
drop policy if exists allow_all_orders on orders;
drop policy if exists portal_orders_insert on orders;
drop policy if exists portal_orders_select on orders;
create policy orders_staff_all on orders
  for all to anon using ((select staff_key_header_ok()))
  with check ((select staff_key_header_ok()));

drop policy if exists allow_all on order_items;
drop policy if exists allow_all_order_items on order_items;
drop policy if exists portal_items_insert on order_items;
drop policy if exists portal_items_select on order_items;
create policy order_items_staff_all on order_items
  for all to anon using ((select staff_key_header_ok()))
  with check ((select staff_key_header_ok()));

-- お客様側は portal_login_v2() 以降のRPC（SECURITY DEFINER）だけを使うため、
-- anon から customers / orders / order_items を直接読む経路は存在しなくなる。