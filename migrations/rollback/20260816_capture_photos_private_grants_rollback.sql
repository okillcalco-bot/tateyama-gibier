-- 20260816_capture_photos_private_grants_rollback.sql
-- 注意: セキュリティ変更は forward-only。
--   ・バケットを public へ戻さない。
--   ・公開SELECTポリシー(capture_photos_read)を復活させない。
-- 露出の再発を防ぐため、このロールバックは「私有アクセスの仕組み（RPC・表・grant検証RLS）」だけを撤去する。
-- 撤去後 capture-photos は private かつ read/write ポリシー不在＝完全に fail-closed（表示もされない）。
-- 表示経路が必要なら、公開化ではなく grant 方式を再適用すること。

begin;

drop policy if exists capture_photos_grant_insert on storage.objects;
drop policy if exists capture_photos_grant_read   on storage.objects;

drop function if exists public.photo_list(text,uuid);
drop function if exists public.photo_request_read(text,uuid);
drop function if exists public.photo_confirm_upload(text,text);
drop function if exists public.photo_request_upload(text,uuid,text,text,text,bigint);
drop function if exists public._photo_device_label(text);
drop function if exists public.capture_photo_grant_ok(text,text,text);

drop table if exists public.photo_grants;
drop table if exists public.individual_photos;

commit;
