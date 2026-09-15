-- 勤怠に「追加距離（km）」を持たせ、給与の通勤費に加算する（2026-09-16）
--
-- きっかけ: 自宅⇔センターの往復以外の移動（配達・引き取り・買い出しなど）が日によってあり、
-- 手書きメモで給与担当に渡していた。出退勤記録（管理者チェック）の行に km と内容を入れられるようにし、
-- 給与計算（payroll.html）が月合計を「勤怠の追加距離 X km × 円/km」として通勤費に足す。
-- 追加のみ。既存列・既存データは変えない。

alter table attendance
  add column if not exists extra_km numeric,          -- その日の追加移動距離（往復・km）
  add column if not exists extra_km_note text;        -- 内容（例: 千倉へ配達）

comment on column attendance.extra_km is '自宅⇔センター往復以外の追加移動距離（km）。給与の通勤費に 円/km で加算';
comment on column attendance.extra_km_note is '追加移動の内容';

-- admin_payroll_list: attendance の集計に extra_km（月合計）と件数を足す。
-- あわせて、20260910_payroll_monthly_salary.sql で落ちていた 'trips'・'trip_rates'（行き先別移動費。
-- 20260810_payroll_trips.sql で追加）を戻す。落ちていた間、payroll.html の🚚一覧は開くたびに空になっていた
create or replace function admin_payroll_list(p_staff_key text, p_month text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
$$;

grant execute on function admin_payroll_list(text, text) to anon, authenticated;

-- 本人ページ（payslip.html）の staff_payslip_view にも extra_km・extra_km_note を出す
create or replace function staff_payslip_view(p_token text, p_month text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_link record; v_month text; v_line jsonb; v_trips jsonb; v_att jsonb; v_months jsonb;
begin
  if coalesce(p_token,'') = '' then return jsonb_build_object('ok', false, 'error', 'リンクが正しくありません'); end if;

  select * into v_link from staff_payslip_links
   where token_hash = encode(extensions.digest(p_token,'sha256'),'hex') and revoked_at is null;
  if v_link.id is null then
    return jsonb_build_object('ok', false, 'error', 'リンクが無効です。担当者にお問い合わせください');
  end if;
  update staff_payslip_links set last_seen_at = now() where id = v_link.id;

  select coalesce(jsonb_agg(m.month order by m.month desc), '[]'::jsonb) into v_months
    from (select distinct month from payroll_lines where staff_id = v_link.staff_id) m;

  v_month := coalesce(nullif(p_month,''), (select max(month) from payroll_lines where staff_id = v_link.staff_id));
  if v_month is null then
    return jsonb_build_object('ok', true, 'staff_name', v_link.staff_name, 'months', v_months, 'month', null, 'line', null);
  end if;

  select to_jsonb(l) - 'staff_id' into v_line
    from payroll_lines l where l.staff_id = v_link.staff_id and l.month = v_month;
  select coalesce(jsonb_agg(jsonb_build_object(
           'destination', t.destination, 'round_km', t.round_km,
           'trip_count', t.trip_count, 'yen_per_km', t.yen_per_km)), '[]'::jsonb) into v_trips
    from payroll_trips t where t.staff_id = v_link.staff_id and t.month = v_month;
  -- 2026-09-16: 勤怠の追加距離（extra_km）と内容も本人ページに出す
  select coalesce(jsonb_agg(jsonb_build_object(
           'work_date', a.work_date, 'clock_in', a.clock_in, 'clock_out', a.clock_out,
           'break_minutes', a.break_minutes, 'extra_km', a.extra_km, 'extra_km_note', a.extra_km_note) order by a.work_date), '[]'::jsonb) into v_att
    from attendance a where a.staff_id = v_link.staff_id and to_char(a.work_date,'YYYY-MM') = v_month;

  return jsonb_build_object('ok', true, 'staff_name', v_link.staff_name, 'months', v_months,
    'month', v_month, 'line', v_line, 'trips', v_trips, 'attendance', v_att);
end;
$$;
grant execute on function staff_payslip_view(text, text) to anon, authenticated;
