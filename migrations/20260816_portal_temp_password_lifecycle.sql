-- 20260816_portal_temp_password_lifecycle.sql
-- 仮パスワード方式（数字6桁・7日失効・初回変更必須・単一使用）＋顧客単位ロックアウト。
-- Codexレビュー(P0-1/P1-1/P1-2/P1-3/P1-4)対応版。前提: 20260816_portal_password_reissue_fix.sql 適用済み。
--
-- 重要な設計:
--   ・初回変更は login＋旧pw の匿名RPCではなく「変更専用トークン」で行う（総当り・期限迂回の遮断＝P0-1）。
--     portal_login_v2 が仮pwを正しく検証したときだけ 15分有効の変更専用セッションを発行し、
--     portal_complete_temp_password がそのトークンで DB側の全条件を確認して変更する。
--   ・再発行時に対象顧客の全セッションを失効（P0-3）。
--   ・must_change=true のログイン応答は PII を返さない（P1-1）。
--   ・ロック中・存在しない・停止・無効・pw違い・期限切れ仮pw・識別子曖昧 は全て status=invalid（列挙防止＝P1-2/P1-4）。
--     解除予定時刻は管理RPC admin_portal_credential_status のみが返す。
--   ・IP単位制限は信頼できるIPが無いため今回は省略（偽の共有IP/固定値で束ねない）。
--     TODO(gateway移行後に強制): portal ログインを信頼gateway経由に切替後、信頼IPで顧客＋IP二重制限を追加する。
--     移行条件: (1)ログインが必ずgateway経由 (2)クライアントがIPを詐称できないことを実測で確認できたとき。

begin;

-- ── 1) 状態列 ──
alter table public.customer_secrets
  add column if not exists must_change          boolean not null default false,
  add column if not exists temp_issued_at        timestamptz,
  add column if not exists temp_expires_at        timestamptz,
  add column if not exists password_changed_at    timestamptz,
  add column if not exists last_login_at          timestamptz,
  add column if not exists failed_attempts        integer not null default 0,
  add column if not exists last_failed_at         timestamptz,
  add column if not exists locked_until           timestamptz;

-- ── 2) 発行（仮pw・7日失効・初回変更必須。再発行で全セッション失効＝P0-3） ──
create or replace function public.staff_issue_portal_passwords(p_staff_key text, p_customer_ids uuid[])
returns table(customer_id uuid, code text, name text, login_id text, password text)
language plpgsql security definer set search_path to 'public','extensions'
as $function$
#variable_conflict use_column
declare r record; v_pw text; v_hash text; v_rb bytea; v_n bigint;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if p_customer_ids is null or array_length(p_customer_ids,1) is null then return; end if;
  if array_length(p_customer_ids,1) > 1000 then raise exception '一度に発行できるのは1000件までです'; end if;
  if exists (select 1 from unnest(p_customer_ids) x(id) where not exists (select 1 from customers c where c.id = x.id)) then
    raise exception '存在しない顧客が含まれています'; end if;

  for r in
    select c.id as cid, c.code as ccode, c.name as cname, coalesce(c.portal_login_id, c.code) as clogin
      from customers c where c.id = any(p_customer_ids) order by c.code
  loop
    v_rb := extensions.gen_random_bytes(4);
    v_n  := (get_byte(v_rb,0)::bigint << 24) | (get_byte(v_rb,1)::bigint << 16)
          | (get_byte(v_rb,2)::bigint << 8)  |  get_byte(v_rb,3)::bigint;
    v_pw := lpad((v_n % 1000000)::text, 6, '0');
    v_hash := extensions.crypt(v_pw, extensions.gen_salt('bf'));

    insert into customer_secrets as cs
      (customer_id, password_hash, must_change, temp_issued_at, temp_expires_at,
       password_changed_at, failed_attempts, last_failed_at, locked_until, updated_at)
      values (r.cid, v_hash, true, now(), now() + interval '7 days', null, 0, null, null, now())
    on conflict on constraint customer_secrets_pkey do update
       set password_hash = excluded.password_hash,
           must_change = true, temp_issued_at = now(), temp_expires_at = now() + interval '7 days',
           password_changed_at = null, failed_attempts = 0, last_failed_at = null, locked_until = null,
           updated_at = now();

    -- P0-3: この顧客の既存セッション（通常・変更専用とも）を全失効。他顧客には影響しない。
    delete from portal_sessions ps where ps.customer_id = r.cid;

    customer_id := r.cid; code := r.ccode; name := r.cname; login_id := r.clogin; password := v_pw;
    return next;
  end loop;
end;
$function$;

-- ── 3) ログイン ──
-- 戻り: status('ok'|'invalid') と、ok時のtoken/expires_at/must_change。
--   must_change=true のときは変更専用の15分トークンのみ返し PII は返さない（P1-1）。
--   must_change=false のときは通常30日トークン＋顧客情報を返す。
--   失敗理由（不存在/停止/無効/pw違い/期限切れ仮pw/ロック中/識別子曖昧）は全て invalid（P1-2/P1-4）。
drop function if exists public.portal_login_v2(text,text,text);
create function public.portal_login_v2(p_login text, p_password text, p_user_agent text default null)
returns table(status text, token text, expires_at timestamptz, must_change boolean,
              code text, name text, honorific text, price_rank text, portal_login_id text,
              phone text, address text, building text, default_time_zone text)
language plpgsql security definer set search_path to 'public','extensions'
as $function$
declare v_login text := lower(btrim(coalesce(p_login,''))); v_n int; v_rec record; v_ok boolean; v_tok text; v_exp timestamptz;
begin
  status := 'invalid';
  if v_login = '' or coalesce(p_password,'') = '' then return next; return; end if;

  -- P1-4: 識別子（portal_login_id / code）が複数顧客に一致するときは invalid（任意選択しない）。
  select count(distinct c.id) into v_n
    from customers c join customer_secrets s on s.customer_id = c.id
   where lower(c.portal_login_id) = v_login or lower(c.code) = v_login;
  if v_n <> 1 then
    perform extensions.crypt(p_password, extensions.gen_salt('bf'));   -- タイミング均一化（存在推測防止）
    return next; return;
  end if;

  select s.customer_id, s.password_hash, s.must_change as mc, s.temp_expires_at, s.failed_attempts,
         s.last_failed_at, s.locked_until as lu, c.portal_enabled, c.is_active,
         c.code as ccode, c.name as cname, c.honorific as chon, c.price_rank as crank,
         c.portal_login_id as clogin, c.phone as cphone, c.address as caddr, c.building as cbldg,
         c.default_time_zone as ctz
    into v_rec
    from customers c join customer_secrets s on s.customer_id = c.id
   where lower(c.portal_login_id) = v_login or lower(c.code) = v_login
   limit 1 for update of s;

  -- P1-2: ロック中は invalid（存在・ロック状態を推測させない）。カウンタは増やさない。
  if v_rec.lu is not null and v_rec.lu > now() then return next; return; end if;

  v_ok := coalesce(v_rec.is_active, true)
          and coalesce(v_rec.portal_enabled, false)
          and v_rec.password_hash = extensions.crypt(p_password, v_rec.password_hash)
          and not (v_rec.temp_expires_at is not null and v_rec.temp_expires_at < now());

  if not v_ok then
    -- 15分窓で失敗回数を原子的に加算。5回目で locked_until を設定（P1-3）。
    if v_rec.last_failed_at is null or now() - v_rec.last_failed_at > interval '15 min' then
      update customer_secrets set failed_attempts = 1, last_failed_at = now()
       where customer_id = v_rec.customer_id;
    else
      update customer_secrets
         set failed_attempts = failed_attempts + 1, last_failed_at = now(),
             locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 min'
                                 else customer_secrets.locked_until end
       where customer_id = v_rec.customer_id;
    end if;
    return next; return;
  end if;

  -- 成功: 失敗回数/ロックをクリア。
  v_tok := encode(extensions.gen_random_bytes(24), 'hex');
  delete from portal_sessions ps where ps.customer_id = v_rec.customer_id and ps.expires_at <= now();

  if coalesce(v_rec.mc, false) then
    -- 仮pw: 変更専用の短命(15分)セッションのみ。PIIは返さない（P1-1）。
    update customer_secrets set failed_attempts = 0, last_failed_at = null, locked_until = null
     where customer_id = v_rec.customer_id;
    v_exp := now() + interval '15 min';
    insert into portal_sessions (token, customer_id, user_agent, expires_at)
    values (encode(extensions.digest(v_tok,'sha256'),'hex'), v_rec.customer_id, left(coalesce(p_user_agent,''),200), v_exp);
    status := 'ok'; token := v_tok; expires_at := v_exp; must_change := true;
    return next; return;
  end if;

  -- 通常: 30日セッション＋顧客情報。最終ログインを記録。
  update customer_secrets set failed_attempts = 0, last_failed_at = null, locked_until = null, last_login_at = now()
   where customer_id = v_rec.customer_id;
  v_exp := now() + interval '30 days';
  insert into portal_sessions (token, customer_id, user_agent, expires_at)
  values (encode(extensions.digest(v_tok,'sha256'),'hex'), v_rec.customer_id, left(coalesce(p_user_agent,''),200), v_exp);
  status := 'ok'; token := v_tok; expires_at := v_exp; must_change := false;
  code := v_rec.ccode; name := v_rec.cname; honorific := v_rec.chon; price_rank := v_rec.crank;
  portal_login_id := v_rec.clogin; phone := v_rec.cphone; address := v_rec.caddr; building := v_rec.cbldg;
  default_time_zone := v_rec.ctz;
  return next;
end;
$function$;
revoke all on function public.portal_login_v2(text,text,text) from public;
grant execute on function public.portal_login_v2(text,text,text) to anon, authenticated;

-- ── 4) 初回パスワード変更（変更専用トークン方式＝P0-1） ──
-- login＋旧pw の匿名試行を廃止。変更専用トークンで DB側の全条件を確認し、成功で全セッション失効＋通常セッション再発行。
create function public.portal_complete_temp_password(p_temp_token text, p_new text)
returns table(status text, token text, expires_at timestamptz)
language plpgsql security definer set search_path to 'public','extensions'
as $function$
declare v_cid uuid; v_rec record; v_tok text; v_exp timestamptz; v_lc text := lower(coalesce(p_new,''));
begin
  status := 'invalid';
  if length(coalesce(p_new,'')) < 8 or length(p_new) > 64 then status := 'weak'; return next; return; end if;
  if v_lc = any (array['password','12345678','123456789','1234567890','0123456789','00000000',
                       '11111111','12341234','1qaz2wsx','qwertyui','iloveyou','88888888','87654321']) then
    status := 'too_common'; return next; return; end if;
  if p_new ~ '^(.)\1{7,}$' then status := 'too_common'; return next; return; end if;

  -- 変更専用トークン → セッション → 顧客。portal_session_customer は使わない（must_change=true を明示確認するため）。
  select ps.customer_id into v_cid
    from portal_sessions ps
   where ps.token = encode(extensions.digest(coalesce(p_temp_token,''),'sha256'),'hex')
     and ps.expires_at > now()
   limit 1;
  if v_cid is null then status := 'invalid'; return next; return; end if;

  select cs.password_hash, cs.must_change as mc, cs.temp_expires_at, c.portal_enabled, c.is_active
    into v_rec
    from customers c join customer_secrets cs on cs.customer_id = c.id
   where c.id = v_cid
   for update of cs;

  -- 全条件をDB側で確認（must_change/temp期限/enabled/active）。
  if not (coalesce(v_rec.mc,false)
          and v_rec.temp_expires_at is not null and v_rec.temp_expires_at > now()
          and coalesce(v_rec.portal_enabled,false)
          and coalesce(v_rec.is_active,true)) then
    status := 'invalid'; return next; return;
  end if;
  -- 仮pwと同一を拒否。
  if v_rec.password_hash = extensions.crypt(p_new, v_rec.password_hash) then
    status := 'same_as_temp'; return next; return; end if;

  update customer_secrets
     set password_hash = extensions.crypt(p_new, extensions.gen_salt('bf')),
         must_change = false, temp_expires_at = null, password_changed_at = now(),
         failed_attempts = 0, last_failed_at = null, locked_until = null, updated_at = now()
   where customer_id = v_cid;

  -- 単一使用: 変更専用トークンを含む全セッションを失効させ、通常30日セッションを再発行。
  delete from portal_sessions ps where ps.customer_id = v_cid;
  v_tok := encode(extensions.gen_random_bytes(24), 'hex');
  v_exp := now() + interval '30 days';
  insert into portal_sessions (token, customer_id, expires_at)
  values (encode(extensions.digest(v_tok,'sha256'),'hex'), v_cid, v_exp);

  status := 'ok'; token := v_tok; expires_at := v_exp;
  return next;
end;
$function$;
revoke all on function public.portal_complete_temp_password(text,text) from public;
grant execute on function public.portal_complete_temp_password(text,text) to anon, authenticated;

-- ── 5) 管理: ロック解除 ──
create or replace function public.staff_unlock_portal(p_staff_key text, p_customer_id uuid)
returns boolean language plpgsql security definer set search_path to 'public','extensions'
as $function$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  update customer_secrets
     set failed_attempts = 0, last_failed_at = null, locked_until = null, updated_at = now()
   where customer_id = p_customer_id;
  return found;
end;
$function$;
revoke all on function public.staff_unlock_portal(text,uuid) from public;
grant execute on function public.staff_unlock_portal(text,uuid) to anon, authenticated;

-- ── 6) 管理: 名簿の認証状態（本pwは表示・復元しない。解除予定時刻はここだけが返す） ──
create or replace function public.admin_portal_credential_status(p_staff_key text)
returns table(customer_id uuid, code text, name text, portal_enabled boolean, login_id text,
              pw_state text, temp_issued_at timestamptz, last_login_at timestamptz,
              locked boolean, locked_until timestamptz)
language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  return query
    select c.id, c.code, c.name, coalesce(c.portal_enabled,false), coalesce(c.portal_login_id, c.code),
           case
             when s.customer_id is null then 'unissued'
             when s.locked_until is not null and s.locked_until > now() then 'locked'
             when s.must_change and s.temp_expires_at is not null and s.temp_expires_at < now() then 'temp_expired'
             when s.must_change then 'temp_issued'
             when s.password_changed_at is not null then 'changed'
             else 'set'
           end as pw_state,
           s.temp_issued_at, s.last_login_at,
           (s.locked_until is not null and s.locked_until > now()) as locked, s.locked_until
      from customers c
      left join customer_secrets s on s.customer_id = c.id
     where coalesce(c.is_active, true)
     order by c.code;
end;
$function$;
revoke all on function public.admin_portal_credential_status(text) from public;
grant execute on function public.admin_portal_credential_status(text) to anon, authenticated;

commit;
