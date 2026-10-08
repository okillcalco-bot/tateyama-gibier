-- 給与: 保険料の自動計算と「1日の実働を15分単位で切捨て」（2026-10-08 沖）
--
-- きっかけ: 9月の給与振込の前に「保険料も自動計算するようにして」「時給の人は15分刻みで計算している」。
--   これまで社会保険料・雇用保険料は毎月手で入れていた（8月分は空欄のまま）。
--   勤怠からの取込は分単位の合計で、15分刻みになっていなかった（8月: 149.65h など）。
--
-- 追加のみ:
--   staff.std_monthly_remuneration … 標準報酬月額（円）。健保・厚年の計算元
--   staff.care_insurance           … 介護保険 '対象'（40〜64歳）/ '対象外'
--   staff.pension_insurance        … 厚生年金 '対象' / '対象外'（70歳以上）。空欄は対象
--   app_settings 'payroll_rates'   … 料率（協会けんぽ千葉 令和8年度。本人負担はこの半分）
alter table public.staff add column if not exists std_monthly_remuneration integer;
alter table public.staff add column if not exists care_insurance text;
alter table public.staff add column if not exists pension_insurance text;

insert into public.app_settings (key, value, updated_at) values ('payroll_rates', jsonb_build_object(
  'health_pct', 9.73, 'care_pct', 1.62, 'child_support_pct', 0.23, 'pension_pct', 18.3, 'employment_pct', 0.5,
  'note', '協会けんぽ千葉 令和8年度（健保9.73%・介護1.62%・子ども子育て支援金0.23%は労使折半、厚年18.3%折半）。雇用保険は本人負担0.5%。本人負担の端数は50銭以下切捨て・50銭超切上げ',
  'effective_from', '2026-04'), now())
on conflict (key) do nothing;

-- 一覧: 勤怠の時間は「1日の実働を15分単位で切捨て」て合計する。スタッフの保険情報と料率も返す
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
    'rates', coalesce((select value from app_settings where key = 'payroll_rates'), '{}'::jsonb),
    'staff', coalesce((select jsonb_agg(jsonb_build_object(
                'id', s.id, 'name', s.name, 'hourly_wage', s.hourly_wage,
                'monthly_salary', s.monthly_salary, 'employment_type', s.employment_type,
                'commute_round_km', s.commute_round_km,
                'commute_yen_per_km', coalesce(s.commute_yen_per_km, 20),
                'stopkill_eligible', coalesce(s.stopkill_eligible, false),
                'default_break_min', s.default_break_min,
                'social_insurance', s.social_insurance, 'employment_insurance', s.employment_insurance,
                'std_monthly_remuneration', s.std_monthly_remuneration,
                'care_insurance', s.care_insurance, 'pension_insurance', s.pension_insurance,
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
                 round(coalesce(sum(floor(greatest(0,
                   (extract(epoch from (att.clock_out::time - att.clock_in::time)) / 60.0
                    - coalesce(att.break_minutes, 0))) / 15) * 15) filter (where att.clock_in ~ '^\d{1,2}:\d{2}' and att.clock_out ~ '^\d{1,2}:\d{2}'), 0) / 60.0, 2) as hours,
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

-- 2026-10-08 データ投入（記録のみ）: 標準報酬月額・介護・厚年の対象は、7月の給与メモと沖・田口の10期給与表から
--   今泉 200,000・介護対象 / 吉田 200,000・介護対象 / 大和田 170,000・介護対象外・厚年対象外（70歳以上）
--   沖 98,000・介護対象 / 田口 220,000・介護対象
