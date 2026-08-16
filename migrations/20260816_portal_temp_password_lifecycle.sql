-- 20260816_portal_temp_password_lifecycle.sql
-- 仮パスワード方式（数字6桁・7日失効・初回変更必須・単一使用）＋顧客単位ロックアウト。
-- 前提: 20260816_portal_password_reissue_fix.sql 適用済み（staff_issue_portal_passwords 修正版）。
-- 既存マイグレーションは編集せず、追加マイグレーションとして CREATE OR REPLACE / DROP+CREATE する。
--
-- IP 制限について（重要）:
--   portal_login_v2 はブラウザから anon 直呼びのため、信頼できるクライアントIPを取得できない。
--   ブラウザ由来のIP・p_ip・任意の X-Forwarded-For は信頼しない。偽の共有IPや固定値で
--   全顧客をまとめて制限しない。したがって本移行では IP 単位制限は行わず、顧客単位ロックのみ実装する。
--   TODO(gateway移行後に強制): 将来 portal ログインを信頼できるgateway(Edge Function)経由に切り替えた
--   時点で、gatewayが付与する信頼IPを用いて auth_rate_check による「顧客単位＋IP単位」の二重制限を追加する。
--   移行条件: (1) ログインが必ずgateway経由になり、(2) クライアントがIPを詐称できないことを実測で確認できたとき。

begin;

-- ── 1) customer_secrets に仮パスワード/ロックの状態列を追加 ──
alter table public.customer_secrets
  add column if not exists must_change          boolean not null default false,
  add column if not exists temp_issued_at        timestamptz,
  add column if not exists temp_expires_at        timestamptz,
  add column if not exists password_changed_at    timestamptz,
  add column if not exists last_login_at          timestamptz,
  add column if not exists failed_attempts        integer not null default 0,
  add column if not exists last_failed_at         timestamptz,
  add column if not exists locked_until           timestamptz;

-- ── 2) 仮パスワード発行（6桁・7日失効・初回変更必須） ──
-- 署名（引数・戻り列）は再発行修正版と同一に保つ（order-admin 既存クライアント互換）。有効期限は
-- クライアントで「発行時刻＋7日」を表示する（発行時刻＝now）。
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
      values (r.cid, v_hash, true, now(), now() + interval '7 days',
              null, 0, null, null, now())
    on conflict (customer_id) do update
       set password_hash = excluded.password_hash,
           must_change = true, temp_issued_at = now(), temp_expires_at = now() + interval '7 days',
           password_changed_at = null, failed_attempts = 0, last_failed_at = null, locked_until = null,
           updated_at = now();

    customer_id := r.cid; code := r.ccode; name := r.cname; login_id := r.clogin; password := v_pw;
    return next;
  end loop;
end;
$function$;

-- ── 3) ログイン（顧客単位ロック＋初回変更必須＋列挙防止の共通エラー） ──
-- 戻り: status('ok'|'invalid'|'locked') と、ok時のtoken/must_change/顧客情報、locked時のlocked_until。
-- 失敗理由（不存在/無効/PW違い/期限切れ仮PW）は全て 'invalid' に集約し、存在や状態を推測させない。
drop function if exists public.portal_login_v2(text,text,text);
create or replace function public.portal_login_v2(p_login text, p_password text, p_user_agent text default null)
returns table(status text, token text, expires_at timestamptz, must_change boolean, locked_until timestamptz,
              code text, name text, honorific text, price_rank text, portal_login_id text,
              phone text, address text, building text, default_time_zone text)
language plpgsql security definer set search_path to 'public','extensions'
as $function$
declare v_login text := lower(btrim(coalesce(p_login,''))); v_rec record; v_ok boolean; v_tok text;
begin
  status := 'invalid';
  if v_login = '' or coalesce(p_password,'') = '' then return next; return; end if;

  select s.customer_id, s.password_hash, s.must_change as mc, s.temp_expires_at, s.failed_attempts,
         s.last_failed_at, s.locked_until as lu, c.portal_enabled, c.is_active,
         c.code as ccode, c.name as cname, c.honorific as chon, c.price_rank as crank,
         c.portal_login_id as clogin, c.phone as cphone, c.address as caddr, c.building as cbldg,
         c.default_time_zone as ctz
    into v_rec
    from customers c
    join customer_secrets s on s.customer_id = c.id
   where lower(c.portal_login_id) = v_login or lower(c.code) = v_login
   limit 1
   for update of s;                      -- 行ロックで同時ログインの失敗回数を取りこぼさない

  if not found then
    perform extensions.crypt(p_password, extensions.gen_salt('bf'));   -- タイミング均一化（存在推測防止）
    return next; return;
  end if;

  -- ロック中は正しいPWでも通さない。解除予定時刻のみ返す。
  if v_rec.lu is not null and v_rec.lu > now() then
    status := 'locked'; locked_until := v_rec.lu; return next; return;
  end if;

  v_ok := coalesce(v_rec.is_active, true)
          and coalesce(v_rec.portal_enabled, false)
          and v_rec.password_hash = extensions.crypt(p_password, v_rec.password_hash)
          and not (v_rec.temp_expires_at is not null and v_rec.temp_expires_at < now());  -- 期限切れ仮PWは無効

  if not v_ok then
    -- 15分窓で失敗回数を原子的に加算。5回で15分ロック。
    if v_rec.last_failed_at is null or now() - v_rec.last_failed_at > interval '15 min' then
      update customer_secrets
         set failed_attempts = 1, last_failed_at = now()
       where customer_id = v_rec.customer_id;
    else
      update customer_secrets
         set failed_attempts = failed_attempts + 1, last_failed_at = now(),
             locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 min'
                                 else customer_secrets.locked_until end
       where customer_id = v_rec.customer_id;
    end if;
    status := 'invalid'; return next; return;
  end if;

  -- 成功: 失敗回数/ロックをクリアし、最終ログインを記録。セッション発行。
  update customer_secrets
     set failed_attempts = 0, last_failed_at = null, locked_until = null, last_login_at = now()
   where customer_id = v_rec.customer_id;
  delete from portal_sessions ps where ps.customer_id = v_rec.customer_id and ps.expires_at <= now();
  v_tok := encode(extensions.gen_random_bytes(24), 'hex');
  insert into portal_sessions (token, customer_id, user_agent)
  values (encode(extensions.digest(v_tok,'sha256'),'hex'), v_rec.customer_id, left(coalesce(p_user_agent,''),200));

  status := 'ok'; token := v_tok; expires_at := now() + interval '30 days'; must_change := coalesce(v_rec.mc,false);
  code := v_rec.ccode; name := v_rec.cname; honorific := v_rec.chon; price_rank := v_rec.crank;
  portal_login_id := v_rec.clogin; phone := v_rec.cphone; address := v_rec.caddr; building := v_rec.cbldg;
  default_time_zone := v_rec.ctz;
  return next;
end;
$function$;
revoke all on function public.portal_login_v2(text,text,text) from public;
grant execute on function public.portal_login_v2(text,text,text) to anon, authenticated;

-- ── 4) 本パスワードへの変更（8〜64文字・仮PWと同一/よくある値を拒否・session再発行） ──
drop function if exists public.portal_change_password(text,text,text);
create or replace function public.portal_change_password(p_login text, p_old text, p_new text)
returns table(status text, token text, expires_at timestamptz)
language plpgsql security definer set search_path to 'public','extensions'
as $function$
declare v_login text := lower(btrim(coalesce(p_login,''))); v_rec record; v_tok text; v_lc text := lower(coalesce(p_new,''));
begin
  status := 'invalid';
  -- 新パスワードのポリシー（数字だけでも8文字以上ならOK。記号/大文字は強制しない）
  if length(coalesce(p_new,'')) < 8 or length(p_new) > 64 then status := 'weak'; return next; return; end if;
  if p_new = p_old then status := 'same_as_temp'; return next; return; end if;
  if v_lc = any (array['password','12345678','123456789','1234567890','0123456789','00000000',
                       '11111111','12341234','1qaz2wsx','qwertyui','iloveyou','88888888','87654321']) then
    status := 'too_common'; return next; return;
  end if;
  if p_new ~ '^(.)\1{7,}$' then status := 'too_common'; return next; return; end if;   -- 同一文字の連続

  select s.customer_id, s.locked_until as lu
    into v_rec
    from customers c join customer_secrets s on s.customer_id = c.id
   where c.is_active is not false
     and (lower(c.portal_login_id) = v_login or lower(c.code) = v_login)
     and s.password_hash = extensions.crypt(p_old, s.password_hash)
   limit 1
   for update of s;
  if not found then status := 'invalid'; return next; return; end if;
  if v_rec.lu is not null and v_rec.lu > now() then status := 'locked'; return next; return; end if;

  update customer_secrets
     set password_hash = extensions.crypt(p_new, extensions.gen_salt('bf')),
         must_change = false, temp_expires_at = null, password_changed_at = now(),
         failed_attempts = 0, last_failed_at = null, locked_until = null, updated_at = now()
   where customer_id = v_rec.customer_id;

  -- 既存セッションを再発行（変更後は新しいセッションで商品一覧へ）
  delete from portal_sessions ps where ps.customer_id = v_rec.customer_id;
  v_tok := encode(extensions.gen_random_bytes(24), 'hex');
  insert into portal_sessions (token, customer_id) values (encode(extensions.digest(v_tok,'sha256'),'hex'), v_rec.customer_id);

  status := 'ok'; token := v_tok; expires_at := now() + interval '30 days';
  return next;
end;
$function$;
revoke all on function public.portal_change_password(text,text,text) from public;
grant execute on function public.portal_change_password(text,text,text) to anon, authenticated;

-- ── 5) 管理: ロック解除（スタッフキー） ──
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

-- ── 6) 管理: 顧客名簿の認証状態（本パスワードは表示・復元しない） ──
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
