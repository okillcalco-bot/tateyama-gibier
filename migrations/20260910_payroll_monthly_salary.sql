-- 給与計算: 月給者（沖浩志・田口和利）の基本給が計算されていなかった問題の修正: 2026-09-10
-- 経緯:
--  * calc()（画面側の計算）は base = 時給×時間 のみで、月給者は hourly_wage が
--    null のため基本給が常に0円になっていた。staff.monthly_salary は既に
--    登録済みだったが、admin_payroll_list/admin_payroll_upsertのどちらも
--    monthly_salaryを一切扱っておらず、画面（staffList/lines）に届いていなかった。
--  * 「差引支給額をLINE用にコピー」機能を追加したことでこの欠落が可視化された
--    （沖・田口の実際の振込額が毎月固定なのに画面の計算結果は0円近くになる）。
--
-- ロールバック: migrations/rollback/20260910_payroll_monthly_salary_rollback.sql

-- ── 1. 明細行にも月給を持たせる（時給と同様、月ごとに上書き可能） ──
alter table payroll_lines add column if not exists monthly_salary numeric;

-- ── 2. 一覧RPC: staffにmonthly_salary/employment_typeを追加 ──
create or replace function admin_payroll_list(p_staff_key text, p_month text)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if p_month !~ '^\d{4}-\d{2}$' then raise exception '月の形式が違います（例 2026-07）'; end if;
  return jsonb_build_object(
    'lines', coalesce((select jsonb_agg(to_jsonb(l) order by l.staff_name)
                        from payroll_lines l where l.month = p_month), '[]'::jsonb),
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

-- ── 3. 保存RPC: monthly_salaryを受け取って保存 ──
create or replace function admin_payroll_upsert(p_staff_key text, p jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
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
    other_deduction, memo)
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
    nullif(p->>'memo',''))
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
    memo = excluded.memo, updated_at = now()
  returning l.id into v_id;
  return v_id;
end;
$$;
