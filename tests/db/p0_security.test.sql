-- tests/db/p0_security.test.sql
-- P0-A セキュリティ是正の DBテスト（negative 中心・positive も含む）。
--
-- 【安全性】このテストは migration の DDL をトランザクション内で適用し、
-- 最後に raise exception でロールバックする（CLAUDE.md の破壊的検証の流儀）。
-- 本番に対して流しても副作用はゼロ（全て巻き戻る）。
--
-- 実行例（本番に無害・ロールバックされる）:
--   supabase execute_sql < tests/db/p0_security.test.sql
--   → 最終行に "TESTRESULT: ALL PASS" が出れば成功。

begin;

-- ===== 適用: P0-2 (a) 追加 =====
create or replace view public.staff_public as
  select id, name, color, is_active, default_break_min from public.staff where deleted_at is null;
create or replace view public.hunters_public as
  select id, name, furigana, (memo in ('逝去','返納')) as is_retired, name_public
  from public.hunters where deleted_at is null;
grant select on public.staff_public to anon, authenticated;
grant select on public.hunters_public to anon, authenticated;
create or replace function public.admin_staff_list()
returns setof public.staff language plpgsql stable security definer set search_path to 'public' as $fn$
begin
  if not staff_key_header_ok() then raise exception 'staffkey' using errcode='42501'; end if;
  return query select * from public.staff where deleted_at is null order by name;
end $fn$;
grant execute on function public.admin_staff_list() to anon, authenticated;
create or replace function public.public_hunter_provisional(p_name text)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $fn$
declare v_name text := btrim(regexp_replace(coalesce(p_name,''), '\s+', ' ', 'g')); v_exists boolean; v_rl jsonb;
begin
  if char_length(v_name) < 2 then raise exception '氏名が短すぎます'; end if;
  if char_length(v_name) > 30 then raise exception '氏名が長すぎます'; end if;
  if v_name !~ '[[:alpha:]ぁ-んァ-ヶ一-龠々〆ヵヶ]' then raise exception '氏名に文字が含まれていません'; end if;
  if v_name ~ '[[:cntrl:]]' then raise exception '氏名に使えない文字が含まれています'; end if;
  select exists(select 1 from public.hunters where name=v_name and deleted_at is null) into v_exists;
  if v_exists then return jsonb_build_object('ok',true,'created',false); end if;
  v_rl := _rl_hit('hunter_provisional', 3600, 20);
  if not (v_rl->>'allowed')::boolean then raise exception '仮登録が短時間に多すぎます'; end if;
  insert into public.hunters(name,memo) values(v_name,'仮登録');
  return jsonb_build_object('ok',true,'created',true);
end $fn$;
grant execute on function public.public_hunter_provisional(text) to anon, authenticated;
-- 2026-10-15 再適用で追加: 物語に名前を出すかの既定（hunters.name_public）を列固定RPCで更新
create or replace function public.public_hunter_set_name_public(p_name text, p_public boolean)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $fn$
declare v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')); v_cur boolean; v_found boolean; v_rl jsonb;
begin
  if p_public is null or char_length(v_name) < 1 or char_length(v_name) > 30 then raise exception '指定が不正です'; end if;
  select true, h.name_public into v_found, v_cur from public.hunters h where h.name = v_name and h.deleted_at is null limit 1;
  if v_found is null then return jsonb_build_object('ok', true, 'changed', false); end if;
  if v_cur is not distinct from p_public then return jsonb_build_object('ok', true, 'changed', false); end if;
  if p_public and v_cur is false and not staff_key_header_ok() then
    raise exception '「出さない」を取り消すには基幹アプリ（捕獲者台帳）で変更してください' using errcode = '42501';
  end if;
  v_rl := _rl_hit('hunter_name_public', 3600, 60);
  if not (v_rl->>'allowed')::boolean then raise exception '変更が短時間に多すぎます'; end if;
  update public.hunters set name_public = p_public where name = v_name and deleted_at is null;
  return jsonb_build_object('ok', true, 'changed', true);
end $fn$;
revoke all on function public.public_hunter_set_name_public(text, boolean) from public;
grant execute on function public.public_hunter_set_name_public(text, boolean) to anon, authenticated;

-- ===== 適用: P0-2 (b) 制限 =====
drop policy if exists "Allow all access to staff" on public.staff;
drop policy if exists staff_all on public.staff;
drop policy if exists staff_select on public.staff;
create policy staff_select on public.staff for select to anon using ((select staff_key_header_ok()));
create policy staff_write on public.staff for all to anon using ((select staff_key_header_ok())) with check ((select staff_key_header_ok()));
drop policy if exists hunters_select on public.hunters;
drop policy if exists hunters_insert on public.hunters;
drop policy if exists hunters_update on public.hunters;
create policy hunters_select on public.hunters for select to anon using ((select staff_key_header_ok()));
create policy hunters_insert on public.hunters for insert to anon with check ((select staff_key_header_ok()));
create policy hunters_update on public.hunters for update to anon using ((select staff_key_header_ok())) with check ((select staff_key_header_ok()));

-- ===== 適用: P0-1 RPC（5関数すべてを rename+wrapper 化し、impl は PUBLIC も剥奪） =====
-- ★ PUBLIC を剥奪しないと anon が PUBLIC 経由で impl を直接呼べてしまう（バイパス）。
alter function public.sale_event_settle(uuid, text) rename to sale_event_settle_impl;
revoke all on function public.sale_event_settle_impl(uuid, text) from public, anon, authenticated;
create or replace function public.sale_event_settle(p_event_id uuid, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $fn$
begin if not staff_key_header_ok() then raise exception 'staffkey' using errcode='42501'; end if;
  return public.sale_event_settle_impl(p_event_id, p_by); end $fn$;
grant execute on function public.sale_event_settle(uuid, text) to anon;

alter function public.sale_event_reopen(uuid, text) rename to sale_event_reopen_impl;
revoke all on function public.sale_event_reopen_impl(uuid, text) from public, anon, authenticated;
create or replace function public.sale_event_reopen(p_event_id uuid, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $fn$
begin if not staff_key_header_ok() then raise exception 'staffkey' using errcode='42501'; end if;
  return public.sale_event_reopen_impl(p_event_id, p_by); end $fn$;
grant execute on function public.sale_event_reopen(uuid, text) to anon;

alter function public.sale_event_takeout(uuid, text) rename to sale_event_takeout_impl;
revoke all on function public.sale_event_takeout_impl(uuid, text) from public, anon, authenticated;
create or replace function public.sale_event_takeout(p_event_id uuid, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $fn$
begin if not staff_key_header_ok() then raise exception 'staffkey' using errcode='42501'; end if;
  return public.sale_event_takeout_impl(p_event_id, p_by); end $fn$;
grant execute on function public.sale_event_takeout(uuid, text) to anon;

alter function public.staff_voice_moderate(uuid, text, text) rename to staff_voice_moderate_impl;
revoke all on function public.staff_voice_moderate_impl(uuid, text, text) from public, anon, authenticated;
create or replace function public.staff_voice_moderate(p_id uuid, p_action text, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $fn$
begin if not staff_key_header_ok() then raise exception 'staffkey' using errcode='42501'; end if;
  return public.staff_voice_moderate_impl(p_id, p_action, p_by); end $fn$;
grant execute on function public.staff_voice_moderate(uuid, text, text) to anon;

alter function public.staff_voices_list(text, integer) rename to staff_voices_list_impl;
revoke all on function public.staff_voices_list_impl(text, integer) from public, anon, authenticated;
create or replace function public.staff_voices_list(p_status text default 'pending', p_limit integer default 200)
returns jsonb language plpgsql stable security definer set search_path to 'public' as $fn$
begin if not staff_key_header_ok() then raise exception 'staffkey' using errcode='42501'; end if;
  return public.staff_voices_list_impl(p_status, p_limit); end $fn$;
grant execute on function public.staff_voices_list(text, integer) to anon;

revoke execute on function public.tgc_assign_scan_code() from anon, public;
revoke execute on function public.waste_summary(date, date) from anon, public;

-- ===== 適用: P0-3 write revoke =====
revoke insert, update, delete on customer_prices      from anon;
revoke insert, update, delete on public_holidays       from anon;
revoke insert, update, delete on staff_fixed_schedule  from anon;

-- ===== 適用: P0-6 portal_password purge =====
update customers set portal_password = null where portal_password is not null;

-- ===== アサーション =====
do $$
declare
  s int; h int; sp int; hp int; pw int; msg text := '';
  v_scan text; prov1 jsonb; prov2 jsonb; k int; rl_blocked boolean := false; junk_rejected boolean := false;
  impl text; bad_impls text := ''; called boolean; np_blocked boolean := false; v_np boolean; r jsonb;
begin
  -- P0-6
  select count(*) into pw from customers where portal_password is not null;
  if pw <> 0 then msg := msg || format('portal_pw残=%s; ', pw); end if;

  -- P0-2 negative/positive
  set local role anon;
  select count(*) into s from staff; select count(*) into h from hunters;
  select count(*) into sp from staff_public; select count(*) into hp from hunters_public;
  reset role;
  if s <> 0  then msg := msg || format('anon staff=%s; ', s); end if;
  if h <> 0  then msg := msg || format('anon hunters=%s; ', h); end if;
  if sp = 0  then msg := msg || 'staff_public空; '; end if;
  if hp = 0  then msg := msg || 'hunters_public空; '; end if;
  if exists (select 1 from information_schema.columns where table_name='hunters_public' and column_name in ('city','trap_area')) then
    msg := msg || 'hunters_publicにcity/trap_area残存; '; end if;
  begin set local role anon; insert into staff(name) values('P0不正'); reset role; msg := msg || 'anon staff INSERT通過; ';
  exception when others then reset role; end;

  -- P0-1 negative: ラッパーは staff-key無しで 42501
  begin set local role anon; perform sale_event_settle('00000000-0000-0000-0000-000000000000'::uuid, null); reset role; msg := msg || 'settle未ガード; ';
  exception when insufficient_privilege then reset role; when others then reset role; msg := msg || 'settle想定外:'||sqlerrm||'; '; end;
  begin set local role anon; perform admin_staff_list(); reset role; msg := msg || 'adminlist未ガード; ';
  exception when insufficient_privilege then reset role; when others then reset role; msg := msg || 'adminlist想定外:'||sqlerrm||'; '; end;

  -- ★ Codexレビュー反映: anon は *_impl を「権限として」呼べない（PUBLICバイパス封鎖）＝全5関数
  foreach impl in array array[
    'public.sale_event_settle_impl(uuid,text)',
    'public.sale_event_reopen_impl(uuid,text)',
    'public.sale_event_takeout_impl(uuid,text)',
    'public.staff_voice_moderate_impl(uuid,text,text)',
    'public.staff_voices_list_impl(text,integer)'
  ] loop
    if has_function_privilege('anon', impl, 'EXECUTE') then bad_impls := bad_impls || impl || ' '; end if;
  end loop;
  if bad_impls <> '' then msg := msg || 'anonがimpl実行可: '||bad_impls; end if;

  -- ★ 実行でも封鎖（anonロールで直接 impl を呼ぶと insufficient_privilege）
  called := false;
  begin set local role anon; perform sale_event_settle_impl('00000000-0000-0000-0000-000000000000'::uuid, null); reset role; called := true;
  exception when insufficient_privilege then reset role; when others then reset role; called := true; end;
  if called then msg := msg || 'anonがsale_event_settle_implを実行できた; '; end if;

  -- staff_set_break_default RPC は存在しない（無認証writeを廃止）
  if exists (select 1 from pg_proc where proname='staff_set_break_default' and pronamespace='public'::regnamespace) then
    msg := msg || 'staff_set_break_default残存; '; end if;

  -- P0-3 negative
  begin set local role anon; insert into public_holidays(holiday_date,name) values('2099-01-01','X'); reset role; msg := msg || 'anon holidays INSERT通過; ';
  exception when others then reset role; end;

  -- positive: トリガはanon剥奪後も発火
  set local role anon;
  insert into inventory(part_name, weight) values('P0テスト', 1.0) returning scan_code into v_scan;
  reset role;
  if v_scan is null or v_scan !~ '^[0-9]{8}$' then msg := msg || 'トリガ採番失敗; '; end if;

  -- 仮登録: 入力制約・冪等・レート制限
  begin set local role anon; perform public_hunter_provisional('!!!'); reset role;
  exception when others then reset role; junk_rejected := true; end;
  if not junk_rejected then msg := msg || '不正氏名が拒否されない; '; end if;
  set local role anon;
  prov1 := public_hunter_provisional('P0テスト捕獲者ZZZ');
  prov2 := public_hunter_provisional('P0テスト捕獲者ZZZ');
  reset role;
  if (prov1->>'created')::boolean is not true then msg := msg || '仮登録1≠true; '; end if;
  if (prov2->>'created')::boolean is not false then msg := msg || '仮登録2≠false; '; end if;
  set local role anon;
  begin for k in 1..25 loop perform public_hunter_provisional('P0RLテスト_'||k::text); end loop;
  exception when others then rl_blocked := true; end;
  reset role;
  if not rl_blocked then msg := msg || 'レート制限が効いていない; '; end if;

  -- name_public: 「出さない」へは anon で変えられる／「出さない」→「出す」は staff-key 無しでは拒否
  set local role anon;
  r := public_hunter_set_name_public('P0テスト捕獲者ZZZ', false);
  reset role;
  select name_public into v_np from hunters where name = 'P0テスト捕獲者ZZZ' and deleted_at is null;
  if v_np is distinct from false then msg := msg || 'name_public=false にできない; '; end if;
  begin set local role anon; perform public_hunter_set_name_public('P0テスト捕獲者ZZZ', true); reset role;
  exception when insufficient_privilege then reset role; np_blocked := true; when others then reset role; msg := msg || 'name_public想定外:'||sqlerrm||'; '; end;
  if not np_blocked then msg := msg || 'anonが出さない→出すに戻せた; '; end if;
  select name_public into v_np from hunters where name = 'P0テスト捕獲者ZZZ' and deleted_at is null;
  if v_np is distinct from false then msg := msg || 'name_publicが書き換わった; '; end if;
  -- 公開VIEWに name_public がある（捕獲票の既定値に使う）／電話は無い
  if not exists (select 1 from information_schema.columns where table_name='hunters_public' and column_name='name_public') then
    msg := msg || 'hunters_publicにname_publicなし; '; end if;
  if exists (select 1 from information_schema.columns where table_name='hunters_public' and column_name='phone') then
    msg := msg || 'hunters_publicにphone; '; end if;

  raise exception 'TESTRESULT: %', case when msg = '' then 'ALL PASS' else 'FAIL: '||msg end;
end $$;
