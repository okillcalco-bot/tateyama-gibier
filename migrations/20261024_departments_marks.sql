-- 部門に「レシートの印」(mark) を持たせ、ヤマナハウス・里山未来拠点協議会を足す（2026-10-24 沖）
-- 沖「レシートの分類は各部門の頭を書く。館山ジビエセンター＝T、合同会社アルコ＝ア、ヤマナハウス＝ヤ、里山未来拠点＝里」
-- 追加のみ。トップレベルの DROP は書かない（CLAUDE.md）。2回流しても壊れない。

alter table public.departments add column if not exists mark text;
create unique index if not exists departments_mark_uidx on public.departments (mark) where mark is not null;

insert into public.departments as d (code, name, short_name, sort, report_to, mark) values
  ('gibier',   '館山ジビエセンター',     'ジビエ', 10, '館山市（通帳の報告義務）', 'T'),
  ('arco',     '合同会社アルコ（本体）', 'アルコ', 20, null, 'ア'),
  ('yamana',   'ヤマナハウス',           'ヤマナ', 30, null, 'ヤ'),
  ('satoyama', '里山未来拠点協議会',     '里山',   40, null, '里')
on conflict (code) do update set mark = coalesce(d.mark, excluded.mark);   -- 既にある部門は印だけ補う（名前は変えない）

-- 部門の追加・変更（印も直せる）
create or replace function public.staff_department_set(p_staff_key text, p_rows jsonb, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare n int := 0;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  insert into departments (code, name, short_name, sort, is_active, report_to, mark)
  select x->>'code', x->>'name', x->>'short_name', coalesce((x->>'sort')::int, 100), coalesce((x->>'is_active')::boolean, true), x->>'report_to', nullif(btrim(x->>'mark'),'')
    from jsonb_array_elements(p_rows) x
   where coalesce(x->>'code','') ~ '^[a-z][a-z0-9_]*$' and coalesce(btrim(x->>'name'),'') <> ''
  on conflict (code) do update set name = excluded.name, short_name = excluded.short_name, sort = excluded.sort, is_active = excluded.is_active,
    report_to = excluded.report_to, mark = excluded.mark;
  get diagnostics n = row_count;
  insert into finance_events (kind, detail, created_by) values ('department', jsonb_build_object('rows', n), p_by);
  return jsonb_build_object('ok', true, 'count', n);
end $$;
