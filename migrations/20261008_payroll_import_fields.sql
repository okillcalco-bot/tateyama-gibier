-- 過去の給与明細（Excel）をアプリに取り込み、市役所提出用に期間でまとめて出せるようにする（2026-10-08）
--
-- きっかけ: 市役所（農水産課）から R7.10〜R8.9 の給与明細（全従業員分）の提出依頼。
--   アプリの給与データは 2026-07 から。それより前は Excel（パートタイム給与明細 9期/10期.xls、
--   沖・田口の 9期/10期.xlsx）にしか無かった。
--
-- Excel の明細にはアプリの行に無い項目がある。追加のみで受け皿を作る:
--   commute_fixed … 通勤費の金額そのもの（Excel は km×回数の内訳と合計。アプリの km×20円 とは単価が違う=17円 など）
--   allowances    … 技術手当・止めさし対応・立替・材料費・交通費・通勤費不足 など [{label, amount}]
--   care_insurance… 介護保険（40〜64歳）
--   base_label    … 基本給欄の名前（役員は「役員報酬」）
--   source        … 取込元（どのファイルから入れたか）
-- 賞与（年末賞与）は同じ月の給与と別の明細なので、別テーブル payroll_bonus_lines に置く
-- （payroll_lines は 月×氏名 で一意のため）。
alter table public.payroll_lines add column if not exists commute_fixed integer;
alter table public.payroll_lines add column if not exists allowances jsonb;
alter table public.payroll_lines add column if not exists care_insurance integer;
alter table public.payroll_lines add column if not exists base_label text;
alter table public.payroll_lines add column if not exists source text;

create table if not exists public.payroll_bonus_lines (
  id uuid primary key default gen_random_uuid(),
  month text not null check (month ~ '^\d{4}-\d{2}$'),
  title text not null default '賞与',
  staff_id uuid references public.staff(id),
  staff_name text not null,
  amount integer not null,
  health_insurance integer, care_insurance integer, pension integer, employment_insurance integer,
  income_tax integer, resident_tax integer, other_deduction integer,
  memo text, source text,
  created_at timestamptz not null default now(),
  unique (month, staff_name, title)
);
alter table public.payroll_bonus_lines enable row level security;   -- 直接の読み書きは不可（スタッフキー付きRPCのみ）

-- 一覧: 賞与も返す
create or replace function public.admin_payroll_list(p_staff_key text, p_month text)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if p_month !~ '^\d{4}-\d{2}$' then raise exception '月の形式が違います（例 2026-07）'; end if;
  return jsonb_build_object(
    'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.staff_name)
                        from payroll_lines l where l.month = p_month), '[]'::jsonb),
    'bonuses', coalesce((select jsonb_agg(to_jsonb(b) order by b.staff_name)
                        from payroll_bonus_lines b where b.month = p_month), '[]'::jsonb),
    'trips', coalesce((select jsonb_agg(to_jsonb(t) order by t.staff_name, t.destination)
                        from payroll_trips t where t.month = p_month), '[]'::jsonb),
    'trip_rates', coalesce((select jsonb_agg(jsonb_build_object(
                     'staff_name', r.staff_name, 'destination', r.destination, 'round_km', r.round_km)
                     order by r.staff_name, r.destination)
                     from staff_trip_rates r), '[]'::jsonb),
    'staff', coalesce((select jsonb_agg(jsonb_build_object(
                'id', s.id, 'name', s.name, 'hourly_wage', s.hourly_wage,
                'monthly_salary', s.monthly_salary, 'employment_type', s.employment_type,
                'commute_round_km', s.commute_round_km,
                'commute_yen_per_km', coalesce(s.commute_yen_per_km, 20),
                'stopkill_eligible', coalesce(s.stopkill_eligible, false),
                'default_break_min', s.default_break_min,
                'is_active', s.is_active, 'deleted', s.deleted_at is not null
              ) order by s.name)
              from staff s where s.deleted_at is null and s.is_active is not false), '[]'::jsonb),
    'attendance', coalesce((
      select jsonb_agg(jsonb_build_object(
               'staff_name', a.staff_name, 'days', a.days, 'hours', a.hours,
               'extra_km', a.extra_km, 'extra_km_days', a.extra_km_days))
        from (
          select att.staff_name,
                 count(distinct att.work_date) filter (where att.clock_in ~ '^\d{1,2}:\d{2}' and att.clock_out ~ '^\d{1,2}:\d{2}') as days,
                 round(coalesce(sum(greatest(0,
                   (extract(epoch from (att.clock_out::time - att.clock_in::time)) / 60.0
                    - coalesce(att.break_minutes, 0)))) filter (where att.clock_in ~ '^\d{1,2}:\d{2}' and att.clock_out ~ '^\d{1,2}:\d{2}'), 0) / 60.0, 2) as hours,
                 round(coalesce(sum(att.extra_km), 0), 1) as extra_km,
                 count(*) filter (where coalesce(att.extra_km, 0) > 0) as extra_km_days
            from attendance att
           where to_char(att.work_date, 'YYYY-MM') = p_month
           group by att.staff_name
        ) a
       where a.days > 0 or a.extra_km > 0), '[]'::jsonb)
  );
end;
$function$;

-- 保存: 新しい欄は、送られてきたときだけ書き換える（古い画面から保存しても取込値を消さない）
create or replace function public.admin_payroll_upsert(p_staff_key text, p jsonb)
 returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare v_id uuid;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if coalesce(p->>'month','') !~ '^\d{4}-\d{2}$' then raise exception '月の形式が違います'; end if;
  if coalesce(btrim(p->>'staff_name'),'') = '' then raise exception '氏名がありません'; end if;
  insert into payroll_lines as l (
    month, staff_id, staff_name, hourly_wage, monthly_salary, work_days, work_hours,
    stopkill_count, stopkill_unit, commute_count, commute_round_km, commute_yen_per_km,
    other_allowance, other_allowance_memo,
    health_insurance, pension, employment_insurance, income_tax, resident_tax,
    other_deduction, memo, commute_fixed, allowances, care_insurance, base_label)
  values (
    p->>'month', nullif(p->>'staff_id','')::uuid, btrim(p->>'staff_name'),
    nullif(p->>'hourly_wage','')::numeric, nullif(p->>'monthly_salary','')::numeric,
    nullif(p->>'work_days','')::int,
    nullif(p->>'work_hours','')::numeric,
    nullif(p->>'stopkill_count','')::int, coalesce(nullif(p->>'stopkill_unit','')::int, 3000),
    nullif(p->>'commute_count','')::int, nullif(p->>'commute_round_km','')::numeric,
    coalesce(nullif(p->>'commute_yen_per_km','')::int, 20),
    nullif(p->>'other_allowance','')::int, nullif(p->>'other_allowance_memo',''),
    nullif(p->>'health_insurance','')::int, nullif(p->>'pension','')::int,
    nullif(p->>'employment_insurance','')::int, nullif(p->>'income_tax','')::int,
    nullif(p->>'resident_tax','')::int, nullif(p->>'other_deduction','')::int,
    nullif(p->>'memo',''),
    nullif(p->>'commute_fixed','')::int,
    case when jsonb_typeof(p->'allowances') = 'array' then p->'allowances' end,
    nullif(p->>'care_insurance','')::int, nullif(p->>'base_label',''))
  on conflict (month, staff_name) do update set
    staff_id = excluded.staff_id, hourly_wage = excluded.hourly_wage,
    monthly_salary = excluded.monthly_salary,
    work_days = excluded.work_days, work_hours = excluded.work_hours,
    stopkill_count = excluded.stopkill_count, stopkill_unit = excluded.stopkill_unit,
    commute_count = excluded.commute_count, commute_round_km = excluded.commute_round_km,
    commute_yen_per_km = excluded.commute_yen_per_km,
    other_allowance = excluded.other_allowance, other_allowance_memo = excluded.other_allowance_memo,
    health_insurance = excluded.health_insurance, pension = excluded.pension,
    employment_insurance = excluded.employment_insurance, income_tax = excluded.income_tax,
    resident_tax = excluded.resident_tax, other_deduction = excluded.other_deduction,
    memo = excluded.memo,
    commute_fixed  = case when p ? 'commute_fixed'  then excluded.commute_fixed  else l.commute_fixed end,
    allowances     = case when p ? 'allowances'     then excluded.allowances     else l.allowances end,
    care_insurance = case when p ? 'care_insurance' then excluded.care_insurance else l.care_insurance end,
    base_label     = case when p ? 'base_label'     then excluded.base_label     else l.base_label end,
    updated_at = now()
  returning l.id into v_id;
  return v_id;
end;
$function$;

-- 2026-10-08 データ投入（記録のみ・SQLは scratchpad で生成）:
--   payroll_lines: 2025-10〜2026-06 のパート（9期/10期.xls）・沖・田口（9期/10期.xlsx）を source 付きで追記
--   payroll_bonus_lines: 2025年 年末賞与（白石・大和田・渡邉・長谷川・沖・田口）
