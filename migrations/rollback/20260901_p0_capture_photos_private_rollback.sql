-- rollback: 20260901_p0_capture_photos_private.sql
-- capture-photos を再び public に戻す（写真表示が公開URL前提の場合の緊急復旧用）。
begin;
update storage.buckets set public = true where id = 'capture-photos';
commit;
