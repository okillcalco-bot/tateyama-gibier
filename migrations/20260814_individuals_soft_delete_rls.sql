-- 20260814_individuals_soft_delete_rls.sql
-- 目的: 個体データ(individuals)の物理削除を禁止し、論理削除(deleted_at)に統一する。
--   市役所提出データの改ざん耐性・監査可能性を高めるため、公開キー(anon)からの
--   物理削除(DELETE/TRUNCATE)を権限・RLSの両面で不可にする。
-- 方針: 追加のみ／冪等。現場PWAの SELECT/INSERT/UPDATE は従来どおり動作する。
--   削除はアプリ側で deleted_at をセットする論理削除に置き換え済み（record-list.html）。

-- 論理削除カラム(既存)に索引（未削除の絞り込みを高速化）
create index if not exists idx_individuals_deleted_at on public.individuals (deleted_at);

-- 全許可(ALL)ポリシーを、DELETE を含まない形へ置き換え
drop policy if exists allow_all on public.individuals;
drop policy if exists individuals_select on public.individuals;
drop policy if exists individuals_insert on public.individuals;
drop policy if exists individuals_update on public.individuals;

create policy individuals_select on public.individuals for select using (true);
create policy individuals_insert on public.individuals for insert with check (true);
create policy individuals_update on public.individuals for update using (true) with check (true);
-- DELETE ポリシーは作成しない → RLS により物理削除は不可

-- テーブル権限からも物理削除系を剥奪（多層防御）
revoke delete, truncate on public.individuals from anon, authenticated;
