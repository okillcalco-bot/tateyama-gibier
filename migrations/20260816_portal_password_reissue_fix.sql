-- 20260816_portal_password_reissue_fix.sql
-- 緊急修正: staff_issue_portal_passwords の 42702（column reference "customer_id" is ambiguous）。
--
-- 原因: RETURNS TABLE の出力列 customer_id と、customer_secrets への
--   `on conflict (customer_id)` が衝突し、PL/pgSQL 変数かテーブル列か曖昧になっていた。
-- 対応（既存マイグレーションは編集せず、この追加マイグレーションで CREATE OR REPLACE）:
--   ・#variable_conflict use_column を宣言し、SQL 内の無修飾列参照はテーブル列として解決する。
--   ・ループの取得列に別名(cid/ccode/…)を付け、customer_id/code/name/login_id/password を
--     SQL 文の中で無修飾に出さない（出力変数への代入は明示 :=）。
--   ・INSERT/ON CONFLICT はテーブル別名 cs を付与。
--   ・6桁パスワードは Math.random 相当の random() をやめ、暗号学的乱数(gen_random_bytes)で生成。
--     先頭0を許可し必ず6桁。数字4桁は総当たりに弱いため不採用（6桁を維持）。
--   ・平文は「発行成功時のレスポンスで1回だけ返す」現行方針を維持し、DB/ログ/監査へ保存しない。
-- 署名（引数・戻り列）は変更しないため、order-admin 既存クライアントは無改修で動作する。

create or replace function public.staff_issue_portal_passwords(p_staff_key text, p_customer_ids uuid[])
returns table(customer_id uuid, code text, name text, login_id text, password text)
language plpgsql
security definer
set search_path to 'public','extensions'
as $function$
#variable_conflict use_column
declare
  r record;
  v_pw text;
  v_hash text;
  v_rb bytea;
  v_n bigint;
begin
  if not staff_key_ok(p_staff_key) then
    raise exception 'スタッフキーが違います';
  end if;
  if p_customer_ids is null or array_length(p_customer_ids, 1) is null then
    return;
  end if;
  if array_length(p_customer_ids, 1) > 1000 then
    raise exception '一度に発行できるのは1000件までです';
  end if;
  -- 存在しない顧客が含まれていたら全体を拒否（誤った顧客への発行・部分更新を防ぐ）。
  if exists (
    select 1 from unnest(p_customer_ids) x(id)
     where not exists (select 1 from customers c where c.id = x.id)
  ) then
    raise exception '存在しない顧客が含まれています';
  end if;

  for r in
    select c.id as cid, c.code as ccode, c.name as cname,
           coalesce(c.portal_login_id, c.code) as clogin
      from customers c
     where c.id = any(p_customer_ids)
     order by c.code
  loop
    -- 暗号学的乱数で 6 桁（0〜999999・先頭0可）。32bit を取り出しモジュロ（偏りは無視できる範囲）。
    v_rb := extensions.gen_random_bytes(4);
    v_n  := (get_byte(v_rb,0)::bigint << 24) | (get_byte(v_rb,1)::bigint << 16)
          | (get_byte(v_rb,2)::bigint << 8)  |  get_byte(v_rb,3)::bigint;
    v_pw := lpad((v_n % 1000000)::text, 6, '0');
    v_hash := extensions.crypt(v_pw, extensions.gen_salt('bf'));

    insert into customer_secrets as cs (customer_id, password_hash)
         values (r.cid, v_hash)
    on conflict (customer_id) do update
       set password_hash = excluded.password_hash, updated_at = now();

    -- 出力変数へは明示代入（SQL 無修飾参照を残さない）。平文は返すだけで保存しない。
    customer_id := r.cid;
    code        := r.ccode;
    name        := r.cname;
    login_id    := r.clogin;
    password    := v_pw;
    return next;
  end loop;
end;
$function$;
