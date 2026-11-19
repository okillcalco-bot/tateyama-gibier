-- スタッフ向け安全教育モジュール（追加のみ）。第1弾はマダニ対策。
-- hunters/staff/attendance/inventory 等の既存テーブルには一切手を加えない。
--
-- RLS方針: meal_voices と同じ「直接の読み書きは全拒否、RPC(security definer)経由のみ」。
-- training_modules/training_completions ともに RLS を有効化し、ポリシーは一切作らない
-- （anon/authenticated からの直接SELECT/INSERT/UPDATE/DELETEは常に拒否される）。
--
-- 公開範囲:
--   training_submit_completion … 受講完了の登録（本人が自己申告した氏名で記録。
--     punch.html 等、既存の「氏名を自己申告で選ぶ」方式をそのまま踏襲。
--     現状スタッフの個人認証の仕組みが無いための現実的な設計であり、
--     厳密な本人確認ではないことを既知の制約としてPR側に明記する）。
--   training_my_completions … 指定した氏名の受講履歴のみ返す（自己申告の氏名一致のみ）。
--   training_admin_stats    … 全スタッフの受講状況の集計。staff_key_header_ok() で保護
--     （sales-dashboard.html 等、既存の管理画面と同じ「共有スタッフキー」ゲート）。

create table if not exists training_modules (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  version text not null,
  published_at timestamptz not null default now(),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists training_completions (
  id uuid primary key default gen_random_uuid(),
  module_slug text not null references training_modules(slug),
  module_version text not null,
  staff_name text not null,
  score int,
  total_questions int,
  completed_at timestamptz not null default now()
);

create index if not exists training_completions_staff_idx
  on training_completions(staff_name, module_slug);

alter table training_modules enable row level security;
alter table training_completions enable row level security;

insert into training_modules (slug, title, version, is_active)
values ('tick-safety', 'マダニ対策', '1.0', true)
on conflict (slug) do nothing;

-- ── 受講完了の登録 ──────────────────────────────────────────
create or replace function public.training_submit_completion(
  p_module_slug text, p_module_version text, p_staff_name text,
  p_score int default null, p_total_questions int default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_version text;
begin
  if p_module_slug is null or btrim(p_module_slug) = '' then
    raise exception '教材が指定されていません';
  end if;
  if p_staff_name is null or btrim(p_staff_name) = '' then
    raise exception '氏名が指定されていません';
  end if;
  select version into v_version from training_modules
   where slug = p_module_slug and is_active;
  if v_version is null then
    raise exception '対象の教材が見つかりません';
  end if;

  insert into training_completions(module_slug, module_version, staff_name, score, total_questions)
  values (p_module_slug, coalesce(nullif(btrim(p_module_version), ''), v_version),
          btrim(p_staff_name), p_score, p_total_questions)
  returning id into v_id;

  return jsonb_build_object('ok', true, 'id', v_id);
end $$;
grant execute on function public.training_submit_completion(text, text, text, int, int) to anon, authenticated;

-- ── 本人の受講履歴（自己申告の氏名一致のみ）───────────────────
create or replace function public.training_my_completions(p_staff_name text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if p_staff_name is null or btrim(p_staff_name) = '' then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'module_slug', c.module_slug,
             'module_version', c.module_version,
             'score', c.score,
             'total_questions', c.total_questions,
             'completed_at', to_char(c.completed_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI')
           ) order by c.completed_at desc)
    from training_completions c
    where c.staff_name = btrim(p_staff_name)
  ), '[]'::jsonb);
end $$;
grant execute on function public.training_my_completions(text) to anon, authenticated;

-- ── 管理者向け集計（スタッフキーで保護）────────────────────────
create or replace function public.training_admin_stats()
returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not staff_key_header_ok() then
    raise exception 'スタッフキーが必要です';
  end if;
  return jsonb_build_object(
    'modules', coalesce((
      select jsonb_agg(jsonb_build_object(
               'slug', m.slug, 'title', m.title, 'version', m.version,
               'completed_count', (
                 select count(distinct c.staff_name) from training_completions c
                  where c.module_slug = m.slug and c.module_version = m.version)
             ) order by m.published_at desc)
      from training_modules m where m.is_active
    ), '[]'::jsonb),
    'completions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'staff_name', c.staff_name, 'module_slug', c.module_slug,
               'module_version', c.module_version, 'score', c.score,
               'total_questions', c.total_questions,
               'completed_at', to_char(c.completed_at at time zone 'Asia/Tokyo', 'YYYY-MM-DD HH24:MI')
             ) order by c.completed_at desc)
      from training_completions c
    ), '[]'::jsonb)
  );
end $$;
grant execute on function public.training_admin_stats() to anon, authenticated;
