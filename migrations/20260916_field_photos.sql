-- 現場からの写真（読めなかったラベル・重量物など）の受け箱（新規・追加のみ）
--
-- きっかけ（2026-09-16）: 出荷時にバーコードが読めなかった袋や、重量物の写真を
-- 共用スマホで撮ってチャットに送り、あとから手作業で出荷に足していた（1日で21枚）。
-- 打刻ページ（punch.html）に「📷 写真を送る」を置き、撮った写真をここに溜める。
-- 出荷管理（index.html）の先頭に「未処理の写真」として並び、担当者が識別コードを打って
-- 出荷に足したら「対応済み」にする。誰が出荷処理をしても同じ手順で拾える。

begin;

create table if not exists field_photos (
  id            uuid primary key default gen_random_uuid(),
  kind          text not null default 'その他',   -- 読めなかったラベル / 重量物 / その他
  note          text,                             -- 一言（例: にくひろ カタ3枚）
  staff_name    text,                             -- 撮った人
  photo_path    text not null,                    -- storage: field-photos バケット内のパス
  taken_at      timestamptz not null default now(),
  resolved_at   timestamptz,                      -- 対応済みにした日時（null＝未処理）
  resolved_by   text,
  resolved_note text,                             -- 何をしたか（例: DIR-20260916-091037 に追加）
  created_at    timestamptz not null default now()
);
create index if not exists field_photos_unresolved_idx on field_photos (taken_at desc) where resolved_at is null;

alter table field_photos enable row level security;
do $$
begin
  if not exists (select 1 from pg_policy where polname = 'allow_all' and polrelid = 'field_photos'::regclass) then
    create policy allow_all on field_photos for all using (true) with check (true);
  end if;
end $$;
grant select, insert, update, delete on field_photos to anon, authenticated;

-- 写真の置き場（公開バケット。5MBまで・画像のみ）
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('field-photos', 'field-photos', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

do $$
begin
  if not exists (select 1 from pg_policy where polname = 'field_photos_insert' and polrelid = 'storage.objects'::regclass) then
    create policy field_photos_insert on storage.objects for insert with check (bucket_id = 'field-photos');
  end if;
  if not exists (select 1 from pg_policy where polname = 'field_photos_read' and polrelid = 'storage.objects'::regclass) then
    create policy field_photos_read on storage.objects for select using (bucket_id = 'field-photos');
  end if;
end $$;

commit;
