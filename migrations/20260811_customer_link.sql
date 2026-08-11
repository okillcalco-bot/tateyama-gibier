-- お客様向け「かんたんログインリンク」2026-08-11
--
-- 背景: order.html のログインはID・パスワード方式のみで、案内文をLINE等で送っても
-- お客様が毎回IDとパスワードを入力する必要があった。給与明細と同じ「本人専用リンク」の
-- 考え方をお客様の注文サイトにも適用し、リンクを開くだけでログインできるようにする。
--
-- 仕組み: portal_login_v2() と同じ portal_sessions（ハッシュ化トークン）を、
-- パスワード入力なしでスタッフキー認証のもとに発行するだけ。既存の
-- portal_session_customer() / portal_me() / portal_catalog() 等はそのまま使える
-- （トークンの発行経路が増えるだけで、検証側の変更は不要）。
--
-- セキュリティ: portal_enabled=true のお客様にしか発行できない（既存の合意事項どおり、
-- 試験運用は施主確認済みの数社に限る）。リンクは他人に渡ればログインできてしまう点は
-- パスワードと同じリスクであり、既定90日・最大365日で発行者が指定できる。
-- 発行はすべて security_events に記録する。
--
-- ロールバック: migrations/rollback/20260811_customer_link_rollback.sql

create or replace function admin_issue_customer_link(p_staff_key text, p_customer_ids uuid[], p_days int default 90)
returns table (customer_id uuid, code text, name text, token text, expires_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
declare r record; v_token text; v_days int := least(greatest(coalesce(p_days,90),1),365); v_exp timestamptz;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if p_customer_ids is null or array_length(p_customer_ids,1) is null then return; end if;
  if array_length(p_customer_ids,1) > 1000 then
    raise exception '一度に発行できるのは1000件までです';
  end if;

  for r in
    select c.id, c.code, c.name from customers c
     where c.id = any(p_customer_ids)
       and c.is_active is not false
       and c.portal_enabled is true      -- 未有効なお客様は発行対象から自然に外れる（呼び出し側が件数差で気づける）
     order by c.code
  loop
    delete from portal_sessions ps where ps.customer_id = r.id and ps.expires_at <= now();
    -- 前回発行したリンク（admin-issued-link）は今回の発行で失効させる。
    -- 通常ログイン（portal_login_v2）のセッションはブラウザのUAが入るため対象外。
    delete from portal_sessions ps where ps.customer_id = r.id and ps.user_agent = 'admin-issued-link';
    v_token := encode(extensions.gen_random_bytes(24), 'hex');
    v_exp := now() + (v_days || ' days')::interval;
    insert into portal_sessions (token, customer_id, user_agent, expires_at)
    values (encode(extensions.digest(v_token, 'sha256'), 'hex'), r.id, 'admin-issued-link', v_exp);
    insert into security_events (event, detail) values ('customer_link_issued', r.code);

    customer_id := r.id; code := r.code; name := r.name; token := v_token; expires_at := v_exp;
    return next;
  end loop;
end;
$$;
grant execute on function admin_issue_customer_link(text, uuid[], int) to anon, authenticated;
