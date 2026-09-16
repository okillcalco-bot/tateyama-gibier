-- 住所→座標のキャッシュ（フードマイレージ解析用・追加のみ）2026-09-16
--
-- センター→お客さんの距離を出すのに、顧客住所の「都道府県＋市区町村」を国土地理院の住所検索で
-- 座標にする。毎回外部APIを叩かないよう、検索した結果（見つからなかった場合も）をここに残す。
--   q          … 検索した文字列（例: 神奈川県横浜市）
--   lat / lng  … 見つからなければ null（fetched_at で「いつ試したか」が分かる。画面から再取得できる）
--   src        … 取得元（gsi=国土地理院 / manual=画面で貼り付け）
create table if not exists geo_cache (
  q          text primary key,
  lat        numeric,
  lng        numeric,
  title      text,
  src        text not null default 'gsi',
  fetched_at timestamptz not null default now()
);
alter table geo_cache enable row level security;
do $$
begin
  if not exists (select 1 from pg_policy where polname = 'allow_all' and polrelid = 'geo_cache'::regclass) then
    create policy allow_all on geo_cache for all using (true) with check (true);
  end if;
end $$;
grant select, insert, update, delete on geo_cache to anon, authenticated;
