-- 労働条件通知書をアプリで出す（2026-10-08）
--
-- きっかけ: 市役所（農水産課）から「労働条件通知書（全従業員分）」の提出依頼。
--   これまでは Word（Drive「202410労働条件通知書（○○）.docx」）を人ごとに手で作っていて、
--   7名分（白石・大和田・渡邉・相川・長谷川・大橋 2024/10/2、田口 2021/12/23）しか無かった。
--
-- 方針:
--   ・通知書は「発行の記録」なので追記のみ（直すときは新しく発行し直す。前の版は残る）
--   ・条件の中身は conditions jsonb（厚労省モデル様式の各欄）。賃金・保険はスタッフ台帳から下書きする
--   ・会社共通の既定値（就業場所・相談窓口など）は labor_notice_defaults（1行）。
--     app_settings は誰でも読めるので、連絡先を含む既定値はこちらに置く
--   ・読み書きはスタッフキー付きRPCのみ（賃金を含む個人情報のため。表は RLS で直接不可）
create table if not exists public.labor_notices (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid references public.staff(id),
  staff_name text not null,
  issued_on date not null,
  conditions jsonb not null default '{}'::jsonb,
  source text,                      -- 取込元（Drive の Word 原本など）。アプリで発行したものは null
  source_url text,
  created_at timestamptz not null default now()
);
create index if not exists labor_notices_staff_idx on public.labor_notices (staff_name, issued_on desc);
alter table public.labor_notices enable row level security;

create table if not exists public.labor_notice_defaults (
  id int primary key default 1 check (id = 1),
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
alter table public.labor_notice_defaults enable row level security;

create or replace function public.admin_labor_notice_list(p_staff_key text)
 returns jsonb language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  return jsonb_build_object(
    'notices', coalesce((select jsonb_agg(to_jsonb(n) order by n.staff_name, n.issued_on desc, n.created_at desc)
                          from labor_notices n), '[]'::jsonb),
    'defaults', coalesce((select value from labor_notice_defaults where id = 1), '{}'::jsonb),
    'staff', coalesce((select jsonb_agg(jsonb_build_object(
                'id', s.id, 'name', s.name, 'employment_type', s.employment_type,
                'hourly_wage', s.hourly_wage, 'monthly_salary', s.monthly_salary,
                'commute_yen_per_km', coalesce(s.commute_yen_per_km, 20),
                'stopkill_eligible', coalesce(s.stopkill_eligible, false),
                'hire_date', s.hire_date, 'role', s.role,
                'social_insurance', s.social_insurance, 'employment_insurance', s.employment_insurance
              ) order by s.name)
              from staff s where s.deleted_at is null and s.is_active is not false), '[]'::jsonb)
  );
end;
$function$;

-- 発行（追記のみ）
create or replace function public.admin_labor_notice_issue(p_staff_key text, p jsonb)
 returns uuid language plpgsql security definer set search_path to 'public'
as $function$
declare v_id uuid;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if coalesce(btrim(p->>'staff_name'),'') = '' then raise exception '氏名がありません'; end if;
  if coalesce(p->>'issued_on','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception '交付日がありません'; end if;
  if jsonb_typeof(p->'conditions') is distinct from 'object' then raise exception '条件がありません'; end if;
  insert into labor_notices (staff_id, staff_name, issued_on, conditions)
  values (nullif(p->>'staff_id','')::uuid, btrim(p->>'staff_name'), (p->>'issued_on')::date, p->'conditions')
  returning id into v_id;
  return v_id;
end;
$function$;

-- 2026-10-08 データ投入（記録のみ）:
--   labor_notice_defaults: 既存の Word 通知書の共通欄（就業場所・業務・休日・締日/支払日・相談窓口 など）
--   labor_notices: 既存7名分の Word を source/source_url 付きで登録（賃金・通勤手当の値のみ。○印は Word 原本が正）
