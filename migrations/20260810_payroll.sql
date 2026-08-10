-- 給与計算（月次）: 2026-08-10
-- 方針:
--  * 勤怠(attendance)は原本のまま。給与は月×人の「明細行」(payroll_lines)に入力値だけを持ち、
--    金額（基本給・止めさし手当・通勤費・支給合計・控除計・差引）は画面側で毎回計算する
--    → どの欄も後から編集できる。わからない欄は空のままでよい
--  * 給与データは個人情報のため anon から直接読み書き不可。
--    アクセスはスタッフキー必須の admin_payroll_* RPC のみ（admin_* 規約に従う）
--  * 通勤費 = 往復km × 単価(既定20円/km) × 出勤回数（過去の給与エクセルと同じ式）
--  * 止めさし手当 = 3000円 × 回数（対象者のみ。白石・大和田・今泉）
--
-- ロールバック: migrations/rollback/20260810_payroll_rollback.sql

-- ── 1. staff に通勤・止めさし対象の既定値を追加（列の追加のみ） ──────
alter table staff add column if not exists commute_round_km numeric;      -- 自宅⇔センター往復km
alter table staff add column if not exists commute_yen_per_km int default 20;
alter table staff add column if not exists stopkill_eligible boolean default false; -- 止めさし手当の対象者か

-- ── 2. 給与明細行 ─────────────────────────────────────────────────
create table if not exists payroll_lines (
  id                   uuid primary key default gen_random_uuid(),
  month                text not null check (month ~ '^\d{4}-\d{2}$'),  -- 例 2026-07
  staff_id             uuid references staff(id),
  staff_name           text not null,
  hourly_wage          numeric,          -- この月に適用する時給（staffの値を初期値に、月ごとに上書き可）
  work_days            int,              -- 出勤日数
  work_hours           numeric,          -- 勤務時間（休憩控除後）
  stopkill_count       int,              -- 止めさし対応回数
  stopkill_unit        int default 3000, -- 1回あたりの手当
  commute_count        int,              -- 通勤回数（普通は出勤日数と同じ）
  commute_round_km     numeric,          -- 往復km
  commute_yen_per_km   int default 20,
  other_allowance      int,              -- その他手当（円）
  other_allowance_memo text,
  health_insurance     int,              -- 健康保険（従業員負担・円）
  pension              int,              -- 厚生年金（従業員負担・円）
  employment_insurance int,              -- 雇用保険（従業員負担・円）
  income_tax           int,              -- 所得税
  resident_tax         int,              -- 住民税
  other_deduction      int,              -- その他控除
  memo                 text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (month, staff_name)
);

alter table payroll_lines enable row level security;   -- ポリシー無し＝RPC以外では読めない
revoke all on payroll_lines from anon, authenticated;

-- ── 3. RPC（スタッフキー必須） ─────────────────────────────────────
-- 一覧: 明細行＋在籍スタッフ＋その月の勤怠集計（取込ボタン用）をまとめて返す
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
grant execute on function admin_payroll_list(text, text) to anon, authenticated;

-- 明細行の保存（(月, 氏名) で upsert。入力の無い欄は null のままでよい）
create or replace function admin_payroll_upsert(p_staff_key text, p jsonb)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if coalesce(p->>'month','') !~ '^\d{4}-\d{2}$' then raise exception '月の形式が違います'; end if;
  if coalesce(btrim(p->>'staff_name'),'') = '' then raise exception '氏名がありません'; end if;
  insert into payroll_lines as l (
    month, staff_id, staff_name, hourly_wage, work_days, work_hours,
    stopkill_count, stopkill_unit, commute_count, commute_round_km, commute_yen_per_km,
    other_allowance, other_allowance_memo,
    health_insurance, pension, employment_insurance, income_tax, resident_tax,
    other_deduction, memo)
  values (
    p->>'month', nullif(p->>'staff_id','')::uuid, btrim(p->>'staff_name'),
    nullif(p->>'hourly_wage','')::numeric, nullif(p->>'work_days','')::int,
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
grant execute on function admin_payroll_upsert(text, jsonb) to anon, authenticated;

-- 行の削除
create or replace function admin_payroll_delete(p_staff_key text, p_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  delete from payroll_lines where id = p_id;
  return found;
end;
$$;
grant execute on function admin_payroll_delete(text, uuid) to anon, authenticated;
