-- 捕獲者台帳の個人情報（郵便番号・住所・電話・口座）を、スタッフキーの端末だけで読み書きする関数（2026-11-08）
--
-- 背景: hunters は RLS が「select/insert/update とも using(true)」で、ブラウザ用の鍵（公開サイトに埋め込み）
--   だけで 236名分の口座番号・住所・電話を読め、書き換えもできた（2026-11-08 実測: 口座128名・電話209名）。
--   2026-07-26 の hunters_rls_hardening で計画された「第2段階（口座列を anon から隠す）」が未実施だった。
--
-- このファイルは**追加のみ**（既存の動作は変えない）。続きの手順:
--   1. このファイルを本番に適用する
--   2. index.html / capture-form.html / buyback.html を、個人情報をこの関数で読む版に本番反映する
--   3. 本番の画面で表示・保存を確かめてから 20261108_hunters_private_columns_revoke.sql を適用する
--
-- 照合は staff_key_header_ok()（x-staff-key ヘッダの sha256。customers / orders と同じ方式）。
-- スタッフキーで守る関数は VOLATILE にする（20261010_staff_key_functions_volatile.sql の約束）。

create or replace function public.staff_hunters_private(p_ids uuid[] default null)
returns table (id uuid, postal_code text, address text, phone text, bank_name text, bank_branch text,
               account_type text, account_number text, account_holder text, account_furigana text, payee_no integer)
language plpgsql volatile security definer set search_path = public as $$
begin
  if not staff_key_header_ok() then
    raise exception 'STAFF_KEY_REQUIRED: 口座・住所・電話はスタッフキーを入れた端末でだけ表示できます' using errcode = '42501';
  end if;
  return query
    select h.id, h.postal_code, h.address, h.phone, h.bank_name, h.bank_branch, h.account_type,
           h.account_number, h.account_holder, h.account_furigana, h.payee_no
    from public.hunters h
    where h.deleted_at is null and (p_ids is null or h.id = any(p_ids));
end $$;
revoke all on function public.staff_hunters_private(uuid[]) from public;
grant execute on function public.staff_hunters_private(uuid[]) to anon, authenticated;

-- 渡したキーの項目だけ書き換える（キーが無い項目はそのまま）。空文字は null。
create or replace function public.staff_hunter_private_save(p_id uuid, p jsonb)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare v_n int;
begin
  if not staff_key_header_ok() then
    raise exception 'STAFF_KEY_REQUIRED: 口座・住所・電話はスタッフキーを入れた端末でだけ保存できます' using errcode = '42501';
  end if;
  update public.hunters set
    postal_code      = case when p ? 'postal_code'      then nullif(trim(p->>'postal_code'), '')      else postal_code end,
    address          = case when p ? 'address'          then nullif(trim(p->>'address'), '')          else address end,
    phone            = case when p ? 'phone'            then nullif(trim(p->>'phone'), '')            else phone end,
    bank_name        = case when p ? 'bank_name'        then nullif(trim(p->>'bank_name'), '')        else bank_name end,
    bank_branch      = case when p ? 'bank_branch'      then nullif(trim(p->>'bank_branch'), '')      else bank_branch end,
    account_type     = case when p ? 'account_type'     then nullif(trim(p->>'account_type'), '')     else account_type end,
    account_number   = case when p ? 'account_number'   then nullif(trim(p->>'account_number'), '')   else account_number end,
    account_holder   = case when p ? 'account_holder'   then nullif(trim(p->>'account_holder'), '')   else account_holder end,
    account_furigana = case when p ? 'account_furigana' then nullif(trim(p->>'account_furigana'), '') else account_furigana end,
    payee_no         = case when p ? 'payee_no'         then nullif(trim(p->>'payee_no'), '')::int    else payee_no end,
    updated_at = now()
  where id = p_id and deleted_at is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'HUNTER_NOT_FOUND: 捕獲者が見つかりません'; end if;
end $$;
revoke all on function public.staff_hunter_private_save(uuid, jsonb) from public;
grant execute on function public.staff_hunter_private_save(uuid, jsonb) to anon, authenticated;
