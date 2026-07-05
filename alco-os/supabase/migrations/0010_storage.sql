-- ============================================================
-- ALCO OS  0010: Storage バケット + RLS
-- 証跡写真・添付ファイル用の非公開バケット。
-- メタデータは files テーブル（0001）が台帳として持つ。
-- ============================================================

insert into storage.buckets (id, name, public)
values ('alco-os', 'alco-os', false)
on conflict (id) do nothing;

-- 認証済みユーザー（= 組織メンバー。profiles を持つ者）のみ読み書き可。
-- 二重チェック: バケット限定 + profiles 存在確認
do $$ begin
  create policy alco_os_objects_select on storage.objects for select to authenticated
    using (bucket_id = 'alco-os' and exists (select 1 from profiles where id = auth.uid()));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy alco_os_objects_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'alco-os' and exists (select 1 from profiles where id = auth.uid()));
exception when duplicate_object then null; end $$;

do $$ begin
  create policy alco_os_objects_update on storage.objects for update to authenticated
    using (bucket_id = 'alco-os' and exists (select 1 from profiles where id = auth.uid()));
exception when duplicate_object then null; end $$;

-- delete ポリシーなし = 証跡ファイルの削除不可（ソフトデリートは files.deleted_at で）
