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

-- hunters_public: 捕獲票の氏名補完に要る最小列のみ。
-- ★ Codexレビュー反映(2026-09): 「氏名＋活動地域」を anon に出さないため city / trap_area は含めない。
-- ★ 2026-10-15 再適用: 20260918_hunter_name_public.sql で増えた name_public（「この肉の物語」に
--   名前を出してよいかの前回の選択）を含める。捕獲票の既定値に使う。機微情報ではない。
create or replace view public.hunters_public as
  select id, name, furigana,
         (memo in ('逝去','返納')) as is_retired,   -- memo本文は出さず除外判定だけ公開
         name_public
  from public.hunters
  where deleted_at is null;

grant select on public.staff_public   to anon, authenticated;
grant select on public.hunters_public to anon, authenticated;

comment on view public.staff_public is
  'anon が読める最小列のみ（氏名/色/在籍/休憩既定）。給与・電話・保険は含めない。名前ボタン等の公開用途はこのVIEWを使う。';
comment on view public.hunters_public is
  'anon が読める最小列のみ（氏名/ふりがな/退任判定/物語に名前を出すかの既定）。電話・住所・口座・免許・銃所持・市・常用地区は含めない（氏名＋活動地域の露出を避ける）。捕獲票の氏名補完はこのVIEWを使う。';

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

-- ★ Codexレビュー反映(2026-09): 休憩初期値の更新RPC(staff_set_break_default)は廃止した。
--   anon から任意スタッフの列を書き換えられる無認証writeになっており、本P0の目的
--   （無認証の状態変更を閉じる）と矛盾するため。休憩初期値の変更は、スタッフキーで
--   保護された基幹アプリ（index.html のスタッフ台帳）でのみ行う。punch.html からは
--   staff への書き込みを一切しない。

-- capture-form.html: 捕獲者の「仮登録」だけを行う（name と memo='仮登録' 固定）。
-- ★ Codexレビュー反映(2026-09): anon INSERT の濫用（スパム・台帳汚染）を抑えるため
--   入力制約＋重複排除＋施設全体のレート制限を入れる。仮登録は memo='仮登録' で明示され、
--   管理者がスタッフ台帳で確認・是正できる（正式な承認待ちキュー分離は P1）。
create or replace function public.public_hunter_provisional(p_name text)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $fn$
declare
  v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_exists boolean;
  v_rl jsonb;
begin
  -- 入力制約: 長さと、少なくとも1文字の日本語/英字を要求。制御文字は拒否
  if char_length(v_name) < 2 then raise exception '氏名が短すぎます'; end if;
  if char_length(v_name) > 30 then raise exception '氏名が長すぎます'; end if;
  if v_name !~ '[[:alpha:]ぁ-んァ-ヶ一-龠々〆ヵヶ]' then raise exception '氏名に文字が含まれていません'; end if;
  if v_name ~ '[[:cntrl:]]' then raise exception '氏名に使えない文字が含まれています'; end if;

  -- 重複排除（既に台帳にある名なら何もしない＝冪等）
  select exists(select 1 from public.hunters where name = v_name and deleted_at is null) into v_exists;
  if v_exists then return jsonb_build_object('ok', true, 'created', false); end if;

  -- レート制限（施設全体で1時間あたり20件まで）。台帳汚染・スパム抑止
  v_rl := _rl_hit('hunter_provisional', 3600, 20);
  if not (v_rl->>'allowed')::boolean then
    raise exception '仮登録が短時間に多すぎます。しばらく経ってからお試しください（管理者にご連絡ください）';
  end if;

  insert into public.hunters (name, memo) values (v_name, '仮登録');
  return jsonb_build_object('ok', true, 'created', true);
end $fn$;
grant execute on function public.public_hunter_provisional(text) to anon, authenticated;

-- capture-form.html: 「この肉の物語」に名前を出すかの前回の選択（hunters.name_public）を覚える。
-- ★ 2026-10-15 再適用で追加: 捕獲票は登録後に hunters を直接 PATCH していたが、p0b で本体の
--   anon 書き込みを閉じるため、列固定の RPC にする。同意に関わる列なので向きで扱いを分ける:
--     ・false（出さない）への変更 … 誰でも可（名前を隠す方向は安全側）
--     ・null（未設定）→ true      … 可（既定が「出す」なので実質の変化なし）
--     ・false → true（出さないを取り消す）… スタッフキー必須（基幹アプリの捕獲者台帳で行う）
create or replace function public.public_hunter_set_name_public(p_name text, p_public boolean)
returns jsonb language plpgsql volatile security definer set search_path to 'public' as $fn$
declare
  v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_cur boolean;
  v_found boolean;
  v_rl jsonb;
begin
  if p_public is null or char_length(v_name) < 1 or char_length(v_name) > 30 then
    raise exception '指定が不正です';
  end if;
  select true, h.name_public into v_found, v_cur
    from public.hunters h where h.name = v_name and h.deleted_at is null limit 1;
  if v_found is null then return jsonb_build_object('ok', true, 'changed', false); end if;
  if v_cur is not distinct from p_public then return jsonb_build_object('ok', true, 'changed', false); end if;
  if p_public and v_cur is false and not staff_key_header_ok() then
    raise exception '「出さない」を取り消すには基幹アプリ（捕獲者台帳）で変更してください' using errcode = '42501';
  end if;
  v_rl := _rl_hit('hunter_name_public', 3600, 60);
  if not (v_rl->>'allowed')::boolean then
    raise exception '変更が短時間に多すぎます。しばらく経ってからお試しください';
  end if;
  update public.hunters set name_public = p_public where name = v_name and deleted_at is null;
  return jsonb_build_object('ok', true, 'changed', true);
end $fn$;
revoke all on function public.public_hunter_set_name_public(text, boolean) from public;
grant execute on function public.public_hunter_set_name_public(text, boolean) to anon, authenticated;

commit;
