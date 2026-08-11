-- スタッフ本人が毎月同じリンクで自分の給与明細を見られるようにする 2026-08-11
--
-- 給与計算画面(payroll.html)からの明細発行はスタッフキー必須の管理者操作のまま。
-- ここでは「本人専用の恒久リンク」を別に発行する。トークンはスタッフ1人につき1つ
-- （明示的に失効させない限り変わらない＝毎月同じリンクを送り直さなくてよい）。
--
-- ⚠️ セキュリティ上の重要な注意（施主説明用）:
-- このリンクは意図的に長期間（既定は「失効させるまで無期限」）有効。給与・
-- 社会保険料という機微な個人情報に恒久的にアクセスできる鍵になるため、
-- 必ず本人だけに、LINEの個別トークなど転送されにくい経路で共有すること。
-- 漏洩・端末紛失時は admin_revoke_staff_payslip_link() で即座に失効できる
-- （失効後、再度 admin_issue_staff_payslip_link() を呼べば新しいリンクを発行できる。
--   ただし新しいリンクなので、また一度だけ本人に送り直す必要がある）。
--
-- トークンはハッシュ化して保存し、平文は発行した瞬間しか取得できない
-- （パスワードと同じ扱い。紛失した場合は再発行のみ可能）。
--
-- ロールバック: migrations/rollback/20260811_staff_payslip_link_rollback.sql

create table if not exists staff_payslip_links (
  id           uuid primary key default gen_random_uuid(),
  staff_id     uuid not null references staff(id),
  staff_name   text not null,
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  revoked_at   timestamptz,
  last_seen_at timestamptz
);
-- スタッフ1人につき「有効なリンク」は常に1つまで
create unique index if not exists staff_payslip_links_staff_active_uq
  on staff_payslip_links (staff_id) where revoked_at is null;
alter table staff_payslip_links enable row level security;
revoke all on staff_payslip_links from anon, authenticated;

-- ── 発行（冪等）: 既に有効なリンクがあれば新規発行せず「発行済み」を返す ──
create or replace function admin_issue_staff_payslip_link(p_staff_key text, p_staff_id uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_name text; v_token text; v_hash text; v_existing_id uuid; v_existing_at timestamptz;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  select name into v_name from staff where id = p_staff_id and deleted_at is null;
  if v_name is null then raise exception 'スタッフが見つかりません'; end if;

  select id, created_at into v_existing_id, v_existing_at
    from staff_payslip_links where staff_id = p_staff_id and revoked_at is null;
  if v_existing_id is not null then
    return jsonb_build_object('ok', true, 'already_issued', true, 'issued_at', v_existing_at);
  end if;

  v_token := encode(extensions.gen_random_bytes(24), 'hex');
  v_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');
  insert into staff_payslip_links (staff_id, staff_name, token_hash) values (p_staff_id, v_name, v_hash);
  insert into security_events (event, detail) values ('staff_payslip_link_issued', v_name);

  return jsonb_build_object('ok', true, 'already_issued', false, 'token', v_token, 'staff_name', v_name);
end;
$$;
grant execute on function admin_issue_staff_payslip_link(text, uuid) to anon, authenticated;

-- ── 失効（漏洩・端末紛失時） ──
create or replace function admin_revoke_staff_payslip_link(p_staff_key text, p_staff_id uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
declare v_name text;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  select name into v_name from staff where id = p_staff_id;
  update staff_payslip_links set revoked_at = now()
   where staff_id = p_staff_id and revoked_at is null;
  if found then
    insert into security_events (event, detail) values ('staff_payslip_link_revoked', coalesce(v_name,p_staff_id::text));
  end if;
  return found;
end;
$$;
grant execute on function admin_revoke_staff_payslip_link(text, uuid) to anon, authenticated;

-- ── 本人ページ（payslip.html）用の閲覧RPC。トークンだけで認証する ──
create or replace function staff_payslip_view(p_token text, p_month text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
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
  select coalesce(jsonb_agg(jsonb_build_object(
           'work_date', a.work_date, 'clock_in', a.clock_in, 'clock_out', a.clock_out,
           'break_minutes', a.break_minutes) order by a.work_date), '[]'::jsonb) into v_att
    from attendance a where a.staff_id = v_link.staff_id and to_char(a.work_date,'YYYY-MM') = v_month;

  return jsonb_build_object('ok', true, 'staff_name', v_link.staff_name, 'months', v_months,
    'month', v_month, 'line', v_line, 'trips', v_trips, 'attendance', v_att);
end;
$$;
grant execute on function staff_payslip_view(text, text) to anon, authenticated;

-- admin_payroll_list に「本人ページのリンクを発行済みか」を足す（給与画面のボタン表示用）
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
                'is_active', s.is_active, 'deleted', s.deleted_at is not null,
                'has_payslip_link', exists (select 1 from staff_payslip_links pl
                                             where pl.staff_id = s.id and pl.revoked_at is null)
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
