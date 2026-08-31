-- ============================================================
-- P0-2 (a) 追加のみ: 公開VIEW と staff-key必須RPC を先に用意する
--
-- これは「追加のみ」で既存挙動を一切変えない。無停止移行のため、
-- ① 本ファイル（追加）→ ② client配信 → ③ p0b（RLS制限）の順で適用する。
-- ①の時点では base の staff/hunters は従来どおり anon で読めるので、
-- 新旧どちらの client でも壊れない。
--
-- ★ production へは Claude Code から適用しない（runbook参照）。
-- ============================================================

begin;

-- 公開VIEW（anon が読める最小列。機微列を含まない）。
-- security_invoker は付けない（既定=定義者権限）ので、本体RLSをバイパスして
-- 最小列だけを anon に見せられる。
create or replace view public.staff_public as
  select id, name, color, is_active, default_break_min
  from public.staff
  where deleted_at is null;

create or replace view public.hunters_public as
  select id, name, furigana, city, trap_area,
         (memo in ('逝去','返納')) as is_retired   -- memo本文は出さず除外判定だけ公開
  from public.hunters
  where deleted_at is null;

grant select on public.staff_public   to anon, authenticated;
grant select on public.hunters_public to anon, authenticated;

comment on view public.staff_public is
  'anon が読める最小列のみ（氏名/色/在籍/休憩既定）。給与・電話・保険は含めない。名前ボタン等の公開用途はこのVIEWを使う。';
comment on view public.hunters_public is
  'anon が読める最小列のみ（氏名/ふりがな/市/常用地区/退任判定）。電話・住所・口座・免許・銃所持は含めない。捕獲票の氏名補完はこのVIEWを使う。';

-- 全列が要る画面（給与台帳・捕獲者台帳・市役所様式）のための staff-key 必須 RPC
create or replace function public.admin_staff_list()
returns setof public.staff language plpgsql stable security definer set search_path to 'public' as $fn$
begin
  if not staff_key_header_ok() then
    raise exception 'この操作にはスタッフキーが必要です' using errcode = '42501';
  end if;
  return query select * from public.staff where deleted_at is null order by name;
end $fn$;
grant execute on function public.admin_staff_list() to anon, authenticated;

create or replace function public.admin_hunters_list()
returns setof public.hunters language plpgsql stable security definer set search_path to 'public' as $fn$
begin
  if not staff_key_header_ok() then
    raise exception 'この操作にはスタッフキーが必要です' using errcode = '42501';
  end if;
  return query select * from public.hunters where deleted_at is null order by name;
end $fn$;
grant execute on function public.admin_hunters_list() to anon, authenticated;

-- 認証なし画面の限定書き込みを、列を固定した RPC に逃がす
-- punch.html: 休憩の初期値(default_break_min)だけを更新する（他列は触れない）
create or replace function public.staff_set_break_default(p_staff_id uuid, p_minutes integer)
returns void language plpgsql volatile security definer set search_path to 'public' as $fn$
begin
  if p_staff_id is null then raise exception 'staff_id が必要です'; end if;
  if p_minutes is null or p_minutes < 0 or p_minutes > 600 then
    raise exception '休憩の初期値は0〜600分で指定してください';
  end if;
  update public.staff set default_break_min = p_minutes
   where id = p_staff_id and deleted_at is null;
end $fn$;
grant execute on function public.staff_set_break_default(uuid, integer) to anon, authenticated;

-- capture-form.html: 捕獲者の「仮登録」だけを行う（name と memo='仮登録' 固定・冪等）
create or replace function public.public_hunter_provisional(p_name text)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $fn$
declare v_name text := btrim(coalesce(p_name, '')); v_exists boolean;
begin
  if v_name = '' then raise exception '氏名が空です'; end if;
  if char_length(v_name) > 50 then raise exception '氏名が長すぎます'; end if;
  select exists(select 1 from public.hunters where name = v_name and deleted_at is null) into v_exists;
  if v_exists then return jsonb_build_object('ok', true, 'created', false); end if;
  insert into public.hunters (name, memo) values (v_name, '仮登録');
  return jsonb_build_object('ok', true, 'created', true);
end $fn$;
grant execute on function public.public_hunter_provisional(text) to anon, authenticated;

commit;
