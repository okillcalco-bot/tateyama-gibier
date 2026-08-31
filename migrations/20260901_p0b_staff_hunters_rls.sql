-- ============================================================
-- P0-2 (b) 制限: staff / hunters 本体の anon 直読み/直書きを staff-key 必須に
--
-- 前提: 20260901_p0a_staff_hunters_views_rpcs.sql 適用済み ＋ 新clientが配信済み。
-- これを適用すると、anon キーだけでは staff/hunters（電話/住所/給与/口座/免許/銃）が
-- 取得できなくなる。最小列は公開VIEW、全列は staff-key RPC 経由で新clientが読む。
--
-- ★ production へは Claude Code から適用しない（runbook参照）。
--   この順序を守ること: p0a（追加）→ client配信 → 本ファイル（制限）。
-- ============================================================

begin;

-- staff: 既存の allow-all 系ポリシーを staff-key 必須へ差し替え
drop policy if exists "Allow all access to staff" on public.staff;
drop policy if exists staff_all    on public.staff;
drop policy if exists staff_select on public.staff;
create policy staff_select on public.staff for select to anon using ((select staff_key_header_ok()));
create policy staff_write  on public.staff for all    to anon
  using ((select staff_key_header_ok())) with check ((select staff_key_header_ok()));

-- hunters: select/insert/update を staff-key 必須へ（delete は引き続き不可）
drop policy if exists hunters_select on public.hunters;
drop policy if exists hunters_insert on public.hunters;
drop policy if exists hunters_update on public.hunters;
create policy hunters_select on public.hunters for select to anon using ((select staff_key_header_ok()));
create policy hunters_insert on public.hunters for insert to anon with check ((select staff_key_header_ok()));
create policy hunters_update on public.hunters for update to anon
  using ((select staff_key_header_ok())) with check ((select staff_key_header_ok()));

comment on table public.staff is
  'スタッフ台帳。anon直読み/直書きは staff_key_header_ok() 必須（P0-2）。最小列は staff_public、全列は admin_staff_list()。休憩既定の更新は staff_set_break_default()。';
comment on table public.hunters is
  '捕獲者台帳。anon直読み/直書きは staff_key_header_ok() 必須（P0-2）。最小列は hunters_public、全列は admin_hunters_list()。仮登録は public_hunter_provisional()。物理削除は不可。';

commit;
