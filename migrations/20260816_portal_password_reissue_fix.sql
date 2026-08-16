-- 20260816_portal_password_reissue_fix.sql
-- 緊急修正: staff_issue_portal_passwords の 42702（column reference "customer_id" is ambiguous）。
-- 原因: RETURNS TABLE の出力列 customer_id と on conflict (customer_id) の衝突。
-- 対応:
--   ・衝突対象を ON CONFLICT ON CONSTRAINT customer_secrets_pkey で明示（#variable_conflict だけに依存しない）。
--   ・ループ取得列に別名を付け、SQL 文中に customer_id/code/name/login_id/password を無修飾で出さない。
--   ・6桁を random() から暗号学的乱数 gen_random_bytes(4) 由来へ（先頭0可・6桁固定）。
--   ・存在しない顧客が含まれる場合は全体拒否（誤発行・部分更新を防止）。
--   ・平文は発行レスポンスで1回だけ返し、DB/ログ/監査へ保存しない。
-- 注: 仮パスワードの lifecycle（must_change/失効/再発行時のセッション失効）は後続マイグレーションで付与する。

create or replace function public.staff_issue_portal_passwords(p_staff_key text, p_customer_ids uuid[])
returns table(customer_id uuid, code text, name text, login_id text, password text)
language plpgsql security definer set search_path to 'public','extensions'
as $function$
#variable_conflict use_column
declare r record; v_pw text; v_hash text; v_rb bytea; v_n bigint;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if p_customer_ids is null or array_length(p_customer_ids, 1) is null then return; end if;
  if array_length(p_customer_ids, 1) > 1000 then raise exception '一度に発行できるのは1000件までです'; end if;
  if exists (select 1 from unnest(p_customer_ids) x(id)
              where not exists (select 1 from customers c where c.id = x.id)) then
    raise exception '存在しない顧客が含まれています';
  end if;

  for r in
    select c.id as cid, c.code as ccode, c.name as cname, coalesce(c.portal_login_id, c.code) as clogin
      from customers c where c.id = any(p_customer_ids) order by c.code
  loop
    v_rb := extensions.gen_random_bytes(4);
    v_n  := (get_byte(v_rb,0)::bigint << 24) | (get_byte(v_rb,1)::bigint << 16)
          | (get_byte(v_rb,2)::bigint << 8)  |  get_byte(v_rb,3)::bigint;
    v_pw := lpad((v_n % 1000000)::text, 6, '0');
    v_hash := extensions.crypt(v_pw, extensions.gen_salt('bf'));

    insert into customer_secrets as cs (customer_id, password_hash)
         values (r.cid, v_hash)
    on conflict on constraint customer_secrets_pkey do update
       set password_hash = excluded.password_hash, updated_at = now();

    customer_id := r.cid; code := r.ccode; name := r.cname; login_id := r.clogin; password := v_pw;
    return next;
  end loop;
end;
$function$;
