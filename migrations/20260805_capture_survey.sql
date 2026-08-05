-- 有害鳥獣捕獲票（市役所提出）に必要な項目と、写真票用の画像
-- 適用済み: 2026-08-05（Supabase migration: capture_survey_fields_and_photos）
alter table individuals add column if not exists capture_koaza text;        -- 捕獲場所（小字）
alter table individuals add column if not exists trap_number text;          -- 箱わな番号
alter table individuals add column if not exists bait_type text;            -- 餌の種類
alter table individuals add column if not exists trap_set_date date;        -- わな設置日
alter table individuals add column if not exists disposal_method text;      -- 捕獲個体の処理方法
alter table individuals add column if not exists submitter_name text;       -- 捕獲票提出者名
alter table individuals add column if not exists special_notes text;        -- その他特記事項
alter table individuals add column if not exists is_juvenile boolean;       -- 幼獣かどうか
alter table individuals add column if not exists photo_tail_before text;    -- 尾を切る前（storageのパス）
alter table individuals add column if not exists photo_tail_after text;     -- 尾を切った後
alter table individuals add column if not exists photo_extra text;          -- その他の写真
alter table individuals add column if not exists map_image text;            -- 捕獲地点の地図
alter table individuals add column if not exists survey_downloaded_at timestamptz;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('capture-photos', 'capture-photos', true, 3145728, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update set
  public = true, file_size_limit = 3145728,
  allowed_mime_types = array['image/jpeg','image/png','image/webp'];

drop policy if exists capture_photos_all on storage.objects;
create policy capture_photos_all on storage.objects
  for all using (bucket_id = 'capture-photos') with check (bucket_id = 'capture-photos');
