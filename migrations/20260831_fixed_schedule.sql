-- 月給制スタッフの所定勤務を毎月自動で入れる（追加のみ）
--
-- 2026年8月は手で43件入れた。毎月これをやるのは現実的でないので仕組みにする。
--
-- 決めごと
--   ・所定はコードに書かず表(staff_fixed_schedule)で持つ。人が増えても曜日が変わっても
--     SQLを直さずに済む。
--   ・実際に打刻がある日は絶対に触らない。入れるのは「その日の記録が1件も無いとき」だけ。
--     打刻は本人がその場で押した事実なので、あとから機械が上書きしない。
--   ・何度流しても同じ結果になる（同じ日を二重に作らない）。
--
-- いまの所定（2026-09-01 から）
--   沖浩志   毎日            8:30-17:30 休憩60分
--   田口和利 水・土日・祝以外 8:30-17:30 休憩60分

begin;

create table if not exists staff_fixed_schedule (
  id            uuid primary key default gen_random_uuid(),
  staff_id      uuid not null references staff(id),
  start_time    text not null default '08:30',
  end_time      text not null default '17:30',
  break_minutes integer not null default 60,
  -- 出る曜日。postgresの dow に合わせる（日=0 月=1 … 土=6）
  weekdays      integer[] not null default '{0,1,2,3,4,5,6}',
  skip_holidays boolean not null default false,   -- 祝祭日を外すか
  active_from   date not null,
  active_to     date,                             -- nullなら当面ずっと
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists staff_fixed_schedule_staff_idx on staff_fixed_schedule (staff_id, active_from);

alter table staff_fixed_schedule enable row level security;
do $$
begin
  if not exists (select 1 from pg_policy where polname='allow_all' and polrelid='staff_fixed_schedule'::regclass) then
    create policy allow_all on staff_fixed_schedule for all using (true) with check (true);
  end if;
end $$;
grant select, insert, update, delete on staff_fixed_schedule to anon, authenticated;

-- 期間を渡すと、所定の日で記録が無いものだけを作る。入れた件数を返す。
create or replace function public.apply_fixed_schedule(p_from date, p_to date)
returns integer
language plpgsql security definer set search_path to 'public'
as $function$
declare n integer;
begin
  if p_from is null or p_to is null or p_to < p_from then return 0; end if;

  with d as (select generate_series(p_from, p_to, '1 day')::date dt),
  plan as (
    select sc.staff_id, s.name staff_name, d.dt,
           sc.start_time, sc.end_time, sc.break_minutes
    from staff_fixed_schedule sc
    join staff s on s.id = sc.staff_id and s.deleted_at is null
    cross join d
    where d.dt >= sc.active_from
      and (sc.active_to is null or d.dt <= sc.active_to)
      and extract(dow from d.dt)::int = any (sc.weekdays)
      and (not sc.skip_holidays
           or not exists (select 1 from public_holidays h where h.holiday_date = d.dt))
  )
  insert into attendance (staff_id, staff_name, work_date, clock_in, clock_out, break_minutes, note)
  select p.staff_id, p.staff_name, p.dt, p.start_time, p.end_time, p.break_minutes, '月給制・所定勤務（自動）'
  from plan p
  where not exists (
    select 1 from attendance a
     where a.work_date = p.dt
       and (a.staff_id = p.staff_id or a.staff_name = p.staff_name)   -- 実打刻がある日は触らない
  );
  get diagnostics n = row_count;
  return n;
end $function$;

grant execute on function public.apply_fixed_schedule(date, date) to anon, authenticated;

-- 前月ぶんをまとめて埋める（毎月1日に流す用）
create or replace function public.apply_fixed_schedule_prev_month()
returns integer
language sql security definer set search_path to 'public'
as $function$
  select public.apply_fixed_schedule(
    (date_trunc('month', (now() at time zone 'Asia/Tokyo')::date) - interval '1 month')::date,
    (date_trunc('month', (now() at time zone 'Asia/Tokyo')::date) - interval '1 day')::date);
$function$;

grant execute on function public.apply_fixed_schedule_prev_month() to anon, authenticated;

-- いまの所定を登録（2026-09-01 から）
insert into staff_fixed_schedule (staff_id, weekdays, skip_holidays, active_from, note)
select s.id, '{0,1,2,3,4,5,6}'::int[], false, '2026-09-01', '毎日 8:30-17:30'
from staff s where s.name = '沖浩志'
  and not exists (select 1 from staff_fixed_schedule x where x.staff_id = s.id);

insert into staff_fixed_schedule (staff_id, weekdays, skip_holidays, active_from, note)
select s.id, '{1,2,4,5}'::int[], true, '2026-09-01', '水・土日・祝以外 8:30-17:30'
from staff s where s.name = '田口和利'
  and not exists (select 1 from staff_fixed_schedule x where x.staff_id = s.id);

commit;

-- 毎月1日の朝5時(JST)＝前日20時(UTC)に、前月ぶんをまとめて入れる。
-- 月末の給与計算の前には必ず埋まっている状態にする。
-- （cron.schedule はトランザクションの外で流す）
select cron.schedule('apply-fixed-schedule-monthly', '0 20 1 * *',
  $cron$select public.apply_fixed_schedule_prev_month();$cron$);
