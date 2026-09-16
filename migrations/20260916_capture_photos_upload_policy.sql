-- 看板つきカメラ・引き取り写真のサーバー保存が、公開から一度も成功していなかった（2026-09-16）
--
-- 実測: storage.objects の capture-photos バケットは 0 件。8月以降の個体 172 頭すべて image_url が null。
-- 原因: 20260805_capture_survey.sql で作った capture_photos_all（insert/update を許すポリシー）が
-- 現在の DB に無く、select だけの capture_photos_read しか残っていない。anon からの POST が RLS で
-- 弾かれ、capture-form.html 側は失敗を握り潰していた（端末には保存されるため気づかれなかった）。
-- 9/15 の引き取り写真（M193）も端末側の切れた1枚しか残っていない。
-- 追加のみ：insert / update（x-upsert 用）を戻す。

do $$
begin
  if not exists (select 1 from pg_policy where polname = 'capture_photos_insert' and polrelid = 'storage.objects'::regclass) then
    create policy capture_photos_insert on storage.objects for insert with check (bucket_id = 'capture-photos');
  end if;
  if not exists (select 1 from pg_policy where polname = 'capture_photos_update' and polrelid = 'storage.objects'::regclass) then
    create policy capture_photos_update on storage.objects for update using (bucket_id = 'capture-photos') with check (bucket_id = 'capture-photos');
  end if;
end $$;
