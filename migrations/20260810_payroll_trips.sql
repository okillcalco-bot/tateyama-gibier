-- 給与: 行き先別の移動費（産廃処理・アワコネ・資材購入など）2026-08-10
-- 通常出勤（センター往復）は payroll_lines の commute_* のまま。
-- センター以外へ行った日は、その日ぶんを「行き先別の行」として数える
-- （例: 白石さん 産廃112km×1回 → その日はセンター29kmの回数から外す）。
-- 金額 = 往復km × 単価(既定20円) × 回数。画面側で毎回計算する。
--
-- ロールバック: migrations/rollback/20260810_payroll_trips_rollback.sql

-- 行き先別の往復km（スタッフごとの既定値。過去の給与エクセル「往復交通費」より）
create table if not exists staff_trip_rates (
  id         uuid primary key default gen_random_uuid(),
  staff_id   uuid references staff(id),
  staff_name text not null,
  destination text not null,
  round_km   numeric not null,
  unique (staff_name, destination)
);
alter table staff_trip_rates enable row level security;
revoke all on staff_trip_rates from anon, authenticated;

-- 月×人×行き先の実績
create table if not exists payroll_trips (
  id          uuid primary key default gen_random_uuid(),
  month       text not null check (month ~ '^\d{4}-\d{2}$'),
  staff_id    uuid references staff(id),
  staff_name  text not null,
  destination text not null,
  round_km    numeric,
  trip_count  int,
  yen_per_km  int default 20,
  memo        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (month, staff_name, destination)
);
alter table payroll_trips enable row level security;
revoke all on payroll_trips from anon, authenticated;

-- 既定値の投入（過去エクセルより）
insert into staff_trip_rates (staff_id, staff_name, destination, round_km)
select s.id, v.nm, v.dest, v.km
from (values
  ('白石秀一','産廃処理',112), ('白石秀一','アワコネ',16),
  ('大和田薫','産廃処理',150),
  ('渡邊恵','アワコネ',42), ('渡邊恵','資材購入',14),
  ('大橋直人','産廃処理',116)
) as v(nm,dest,km)
join staff s on s.name = v.nm
on conflict (staff_name, destination) do nothing;

-- 一覧RPCに trips / trip_rates を追加
create or replace function admin_payroll_list(p_staff_key text, p_month text)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if p_month !~ '^\d{4}-\d{2}$' then raise exception '月の形式が違います（例 2026-07）'; end if;
  return jsonb_build_object(
    'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.staff_name)
                        from payroll_lines l where l.month = p_month), '[]'::jsonb),
    'trips', coalesce((select jsonb_agg(to_jsonb(t) order by t.staff_name, t.destination)
                        from payroll_trips t where t.month = p_month), '[]'::jsonb),
    'trip_rates', coalesce((select jsonb_agg(jsonb_build_object(
                     'staff_name', r.staff_name, 'destination', r.destination, 'round_km', r.round_km)
                     order by r.staff_name, r.destination)
                     from staff_trip_rates r), '[]'::jsonb),
    'staff', coalesce((select jsonb_agg(jsonb_build_object(
                'id', s.id, 'name', s.name, 'hourly_wage', s.hourly_wage,
                'commute_round_km', s.commute_round_km,
                'commute_yen_per_km', coalesce(s.commute_yen_per_km, 20),
                'stopkill_eligible', coalesce(s.stopkill_eligible, false),
                'default_break_min', s.default_break_min,
                'is_active', s.is_active, 'deleted', s.deleted_at is not null
              ) order by s.name)
              from staff s where s.deleted_at is null and s.is_active is not false), '[]'::jsonb),
    'attendance', coalesce((
      select jsonb_agg(jsonb_build_object(
               'staff_name', a.staff_name, 'days', a.days, 'hours', a.hours))
        from (
          select att.staff_name,
                 count(distinct att.work_date) as days,
                 round(sum(greatest(0,
                   (extract(epoch from (att.clock_out::time - att.clock_in::time)) / 60.0
                    - coalesce(att.break_minutes, 0)))) / 60.0, 2) as hours
            from attendance att
           where to_char(att.work_date, 'YYYY-MM') = p_month
             and att.clock_in ~ '^\d{1,2}:\d{2}' and att.clock_out ~ '^\d{1,2}:\d{2}'
           group by att.staff_name
        ) a), '[]'::jsonb)
  );
end;
$$;

-- 行き先別の保存（(月,氏名,行き先)でupsert。回数0または空なら削除）
create or replace function admin_payroll_trip_upsert(p_staff_key text, p jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_cnt int;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if coalesce(p->>'month','') !~ '^\d{4}-\d{2}$' then raise exception '月の形式が違います'; end if;
  if coalesce(btrim(p->>'staff_name'),'') = '' then raise exception '氏名がありません'; end if;
  if coalesce(btrim(p->>'destination'),'') = '' then raise exception '行き先がありません'; end if;
  v_cnt := nullif(p->>'trip_count','')::int;
  if v_cnt is null or v_cnt <= 0 then
    delete from payroll_trips
     where month = p->>'month' and staff_name = btrim(p->>'staff_name')
       and destination = btrim(p->>'destination');
    return null;
  end if;
  insert into payroll_trips as t (month, staff_id, staff_name, destination, round_km, trip_count, yen_per_km, memo)
  values (p->>'month', nullif(p->>'staff_id','')::uuid, btrim(p->>'staff_name'),
          btrim(p->>'destination'), nullif(p->>'round_km','')::numeric, v_cnt,
          coalesce(nullif(p->>'yen_per_km','')::int, 20), nullif(p->>'memo',''))
  on conflict (month, staff_name, destination) do update set
    staff_id = excluded.staff_id, round_km = excluded.round_km,
    trip_count = excluded.trip_count, yen_per_km = excluded.yen_per_km,
    memo = excluded.memo, updated_at = now()
  returning t.id into v_id;
  -- 行き先の既定値も覚える（次月から選ぶだけで済む）
  if nullif(p->>'round_km','') is not null then
    insert into staff_trip_rates (staff_id, staff_name, destination, round_km)
    values (nullif(p->>'staff_id','')::uuid, btrim(p->>'staff_name'), btrim(p->>'destination'),
            (p->>'round_km')::numeric)
    on conflict (staff_name, destination) do update set round_km = excluded.round_km;
  end if;
  return v_id;
end;
$$;
grant execute on function admin_payroll_trip_upsert(text, jsonb) to anon, authenticated;
