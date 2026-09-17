-- 解析タブ「公的データで解析できそうなこと」を実データで動かす（2026-09-17）
-- 1) public_files: Edge Function public-fetch 経由で取った公的資料（PDF・Excel・CSV）の置き場（bytea）
-- 2) public_stats: 資料から起こした数字を1表に（キー: 年度・年・月・市町村・地区。出どころと取得日つき）
-- 3) tateyama_districts: 館山市の大字 → 旧町村地区（市の「地区別イノシシ捕獲状況」と突き合わせる）
-- 4) tgc_import_public_stats: リポジトリの data/public_stats.csv を DB に取り込む（追加のみ・同じ dataset は入れ替え）
-- 追加のみ。既存テーブルは触らない。

create table if not exists public_files (
  id uuid primary key default gen_random_uuid(),
  url text unique not null,
  fetched_at timestamptz not null default now(),
  status int, content_type text, bytes int, data bytea, note text
);
alter table public_files enable row level security;
drop policy if exists public_files_read on public_files;
create policy public_files_read on public_files for select using (true);

-- Edge Function public-fetch（許可した公的サイトだけを取りに行き base64 で返す）を DB から呼ぶ。
-- DB の http_get はバイナリ（PDF/Excel）を扱えないため。
create or replace function tgc_public_fetch(p_url text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r extensions.http_response; j jsonb; b bytea;
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS','150000');
  select * into r from extensions.http((
    'GET',
    'https://clpdyrehdgzgiidbfucj.supabase.co/functions/v1/public-fetch?url=' || extensions.urlencode(p_url),
    ARRAY[extensions.http_header('Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNscGR5cmVoZGd6Z2lpZGJmdWNqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyODEzNDksImV4cCI6MjA4ODg1NzM0OX0.cKxpyw0gyZj0Flsd8wzojiNFqyCEcrAF8tFpXXUmZck')],
    null, null)::extensions.http_request);
  if r.status <> 200 then
    return jsonb_build_object('ok', false, 'status', r.status, 'error', left(r.content, 300));
  end if;
  j := r.content::jsonb;
  if j ? 'error' then return jsonb_build_object('ok', false, 'error', j->>'error'); end if;
  b := decode(j->>'base64', 'base64');
  insert into public_files(url, status, content_type, bytes, data, note, fetched_at)
    values (p_url, (j->>'status')::int, j->>'content_type', (j->>'bytes')::int, b, p_note, now())
  on conflict (url) do update set status = excluded.status, content_type = excluded.content_type, bytes = excluded.bytes, data = excluded.data, note = coalesce(excluded.note, public_files.note), fetched_at = now();
  return jsonb_build_object('ok', true, 'status', j->>'status', 'content_type', j->>'content_type', 'bytes', j->>'bytes');
end $$;

create table if not exists public_stats (
  id bigserial primary key,
  dataset text not null,
  source text not null,
  source_url text,
  fetched_at timestamptz not null default now(),
  fiscal_year int,                -- 令和y（平成は 30 を引いてマイナス）
  cal_year int,
  month int,
  city text,
  area text,
  category text,
  metric text not null,
  value numeric,
  unit text,
  note text
);
create index if not exists public_stats_ds on public_stats(dataset, fiscal_year, city, area);
alter table public_stats enable row level security;
drop policy if exists public_stats_read on public_stats;
create policy public_stats_read on public_stats for select using (true);

create table if not exists tateyama_districts (
  oaza text primary key,
  district text not null
);
alter table tateyama_districts enable row level security;
drop policy if exists tateyama_districts_read on tateyama_districts;
create policy tateyama_districts_read on tateyama_districts for select using (true);
insert into tateyama_districts(oaza, district) values
('船形','船形'),('川名','船形'),
('那古','那古'),('正木','那古'),('小原','那古'),('亀ケ原','那古'),('亀ヶ原','那古'),
('湊','北条'),('八幡','北条'),('北条','北条'),('新宿','北条'),('長須賀','北条'),('高井','北条'),('北条正木','北条'),('上野原','北条'),
('館山','館山'),('上真倉','館山'),('下真倉','館山'),('沼','館山'),('富士見','館山'),('宮城','館山'),('笠名','館山'),('大賀','館山'),
('安布里','館野'),('大網','館野'),('山本','館野'),('国分','館野'),('稲','館野'),('腰越','館野'),('広瀬','館野'),
('二子','九重'),('薗','九重'),('安東','九重'),('水玉','九重'),('大井','九重'),('竹原','九重'),('江田','九重'),('水岡','九重'),('宝貝','九重'),
('南条','豊房'),('飯沼','豊房'),('山荻','豊房'),('山萩','豊房'),('古茂口','豊房'),('作名','豊房'),('畑','豊房'),('大戸','豊房'),('東長田','豊房'),('西長田','豊房'),('岡田','豊房'),('出野尾','豊房'),('神余','豊房'),
('布沼','神戸'),('洲宮','神戸'),('茂名','神戸'),('藤原','神戸'),('佐野','神戸'),('犬石','神戸'),('中里','神戸'),('竜岡','神戸'),('大神宮','神戸'),
('相浜','富崎'),('布良','富崎'),
('香','西岬'),('塩見','西岬'),('浜田','西岬'),('見物','西岬'),('早物','西岬'),('加賀名','西岬'),('波左間','西岬'),('坂田','西岬'),('洲崎','西岬'),('西川名','西岬'),('伊戸','西岬'),('坂足','西岬'),('小沼','西岬'),('坂井','西岬')
on conflict (oaza) do nothing;

-- data/public_stats.csv（リポジトリ）を取り込む。列: dataset,source,source_url,fiscal_year,cal_year,month,city,area,category,metric,value,unit,note
-- 同じ dataset の行は入れ替える（追記の考え方はそのまま、二重に増えない）。
create or replace function tgc_import_public_stats(p_url text default 'https://raw.githubusercontent.com/okillcalco-bot/tateyama-gibier/main/data/public_stats.csv')
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r extensions.http_response; n int := 0; ds text[];
begin
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS','120000');
  select * into r from extensions.http_get(p_url);
  if r.status <> 200 then return jsonb_build_object('ok', false, 'status', r.status); end if;
  create temp table _ps on commit drop as
    select c[1] dataset, c[2] source, c[3] source_url, nullif(c[4],'')::int fiscal_year, nullif(c[5],'')::int cal_year, nullif(c[6],'')::int as month,
           nullif(c[7],'') city, nullif(c[8],'') area, nullif(c[9],'') category, c[10] metric, nullif(c[11],'')::numeric value, nullif(c[12],'') unit, nullif(c[13],'') note
    from tgc_csv_rows(r.content) c where c[1] <> 'dataset' and array_length(c,1) >= 13;
  select array_agg(distinct dataset) into ds from _ps;
  delete from public_stats where dataset = any(ds);
  insert into public_stats(dataset, source, source_url, fiscal_year, cal_year, month, city, area, category, metric, value, unit, note)
    select dataset, source, source_url, fiscal_year, cal_year, month, city, area, category, metric, value, unit, note from _ps;
  get diagnostics n = row_count;
  return jsonb_build_object('ok', true, 'rows', n, 'datasets', ds);
end $$;

-- 出どころ一覧（解析ページの「出典」欄用）
create or replace view v_public_sources as
select dataset, source, source_url, max(fetched_at) fetched_at, count(*) rows_n, min(coalesce(fiscal_year, cal_year)) y_from, max(coalesce(fiscal_year, cal_year)) y_to
from public_stats group by dataset, source, source_url;
grant select on v_public_sources to anon, authenticated;
