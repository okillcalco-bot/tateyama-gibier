-- 産廃（動植物性残さ）の計量票を記録する（新規・追加のみ）
--
-- これまで産廃の搬出量はどこにも入っていなかった。紙の計量票だけが記録で、
-- 月次の業務報告や、歩留まり（枝肉→精肉→残さ）を見るときに数字が出せない。
--
-- 計量票の見方
--   総重（積んだ状態の全体） − 風袋（空車） = 正味（実際に出した産廃の重さ）
--   実測した5枚すべてでこの式が成り立っていたので、正味は計算で持つ。
--   手で入れた正味と計算がずれることが構造的に起きない。
--
-- 同じ票を二度入れないように、マニフェスト番号と「日付＋車番＋時刻」で重複を止める。

begin;

create table if not exists waste_weighings (
  id            uuid primary key default gen_random_uuid(),
  weighed_on    date not null,
  weighed_time  text,                                   -- 票の時刻（HH:MM）
  vehicle_no    text,                                   -- 車番
  trip_no       integer,                                -- 回数
  gross_kg      numeric not null,                       -- 総重
  tare_kg       numeric not null,                       -- 風袋
  net_kg        numeric generated always as (gross_kg - tare_kg) stored,
  waste_type    text not null default '動植物性残さ',
  manifest_no   text,                                   -- マニフェスト（産業廃棄物管理票）番号
  vendor_name   text,                                   -- 処理業者
  site_name     text,                                   -- 搬入先
  carrier_name  text,                                   -- 運送業者
  customer_code text,                                   -- 計量票の社名コード
  photo_path    text,                                   -- 票の写真（将来用）
  note          text,
  recorded_by   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  constraint waste_weighings_kg_ck check (gross_kg >= 0 and tare_kg >= 0 and gross_kg >= tare_kg)
);

create index if not exists waste_weighings_date_idx on waste_weighings (weighed_on desc) where deleted_at is null;

-- 同じ票を二度入れない
create unique index if not exists waste_weighings_manifest_uidx
  on waste_weighings (manifest_no) where deleted_at is null and manifest_no is not null;
create unique index if not exists waste_weighings_slip_uidx
  on waste_weighings (weighed_on, vehicle_no, weighed_time)
  where deleted_at is null and vehicle_no is not null and weighed_time is not null;

alter table waste_weighings enable row level security;
do $$
begin
  if not exists (select 1 from pg_policy where polname = 'allow_all' and polrelid = 'waste_weighings'::regclass) then
    create policy allow_all on waste_weighings for all using (true) with check (true);
  end if;
end $$;
grant select, insert, update, delete on waste_weighings to anon, authenticated;

-- 月ごと・年度ごとの搬出量（月次報告と、残さの傾向を見るため）
create or replace function public.waste_summary(p_from date default null, p_to date default null)
returns jsonb
language sql stable security definer set search_path to 'public'
as $function$
  with rows as (
    select * from waste_weighings
    where deleted_at is null
      and (p_from is null or weighed_on >= p_from)
      and (p_to   is null or weighed_on <= p_to)
  )
  select jsonb_build_object(
    'count', (select count(*) from rows),
    'net_kg', (select coalesce(sum(net_kg), 0) from rows),
    'first', (select min(weighed_on) from rows),
    'last',  (select max(weighed_on) from rows),
    'by_month', (select coalesce(jsonb_agg(x order by x->>'month' desc), '[]'::jsonb) from (
        select jsonb_build_object('month', to_char(weighed_on, 'YYYY-MM'),
                                  'count', count(*), 'net_kg', sum(net_kg)) x
        from rows group by to_char(weighed_on, 'YYYY-MM')) m),
    'by_year', (select coalesce(jsonb_agg(x order by x->>'year' desc), '[]'::jsonb) from (
        -- 年度は4月はじまり
        select jsonb_build_object('year', (extract(year from weighed_on) - case when extract(month from weighed_on) < 4 then 1 else 0 end)::int,
                                  'count', count(*), 'net_kg', sum(net_kg)) x
        from rows
        group by (extract(year from weighed_on) - case when extract(month from weighed_on) < 4 then 1 else 0 end)::int) y)
  );
$function$;

grant execute on function public.waste_summary(date, date) to anon, authenticated;

commit;
