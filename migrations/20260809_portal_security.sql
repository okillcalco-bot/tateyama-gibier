-- 注文ポータルのログイン情報を守る（追加のみ／既存テーブルは壊さない）
--
-- いままでの問題:
--   customers に平文のパスワードが入っていて、公開ページに埋め込まれた anon キーで
--   誰でも全件読めた（お名前・住所・電話・パスワード）。
--
-- ここでやること:
--   1. パスワードは customer_secrets に bcrypt で保管する。
--      このテーブルは RLS 有効・ポリシー無しなので anon からは一切触れない。
--   2. ログインは SECURITY DEFINER の関数だけが行う（パスワードは外に出ない）。
--   3. パスワードの発行は「スタッフキー」を知っている人だけができる。
--      スタッフキーは画面に埋め込まず、担当者が1度だけ入力して端末に保存する。

create extension if not exists pgcrypto with schema extensions;

-- ── 1. パスワードの保管場所（anon からは見えない） ──────────────────────
create table if not exists customer_secrets (
  customer_id   uuid primary key references customers(id) on delete cascade,
  password_hash text not null,
  updated_at    timestamptz not null default now()
);
alter table customer_secrets enable row level security;
-- ポリシーを作らない = anon / public からは読み書きできない。
-- 下の SECURITY DEFINER 関数だけが触れる。
revoke all on customer_secrets from anon, authenticated;

-- ── 2. アプリ共通の秘密（スタッフキー）──────────────────────────────
create table if not exists app_secrets (
  key        text primary key,
  hash       text not null,
  updated_at timestamptz not null default now()
);
alter table app_secrets enable row level security;
revoke all on app_secrets from anon, authenticated;

-- ── 3. いまの平文パスワードを移す ────────────────────────────────────
insert into customer_secrets (customer_id, password_hash)
select id, extensions.crypt(portal_password, extensions.gen_salt('bf'))
  from customers
 where portal_password is not null and portal_password <> ''
on conflict (customer_id) do nothing;

-- ── 4. ログイン ──────────────────────────────────────────────────────
-- お客様番号（portal_login_id）またはお名前 ＋ パスワードで照合する。
-- 見つからなければ0行。パスワードそのものは決して返さない。
create or replace function portal_login(p_login text, p_password text)
returns table (
  id uuid, code text, name text, kana text, honorific text,
  contact_name text, email text, phone text, address text, building text,
  price_rank text, default_item text, default_time_zone text,
  default_carriers text[], notify_method text, portal_login_id text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_login text := btrim(coalesce(p_login, ''));
begin
  if v_login = '' or coalesce(p_password, '') = '' then return; end if;

  return query
  select c.id, c.code, c.name, c.kana, c.honorific,
         c.contact_name, c.email, c.phone, c.address, c.building,
         c.price_rank, c.default_item, c.default_time_zone,
         c.default_carriers, c.notify_method, c.portal_login_id
    from customers c
    join customer_secrets s on s.customer_id = c.id
   where c.is_active is not false
     and (lower(c.portal_login_id) = lower(v_login)
          or lower(c.code) = lower(v_login)
          or lower(c.name) = lower(v_login))
     and s.password_hash = extensions.crypt(p_password, s.password_hash)
   limit 1;
end;
$$;

-- ── 5. お客様が自分でパスワードを変える ──────────────────────────────
create or replace function portal_change_password(p_login text, p_old text, p_new text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_id uuid;
begin
  if length(coalesce(p_new, '')) < 6 then
    raise exception 'パスワードは6文字以上にしてください';
  end if;

  select c.id into v_id
    from customers c
    join customer_secrets s on s.customer_id = c.id
   where c.is_active is not false
     and (lower(c.portal_login_id) = lower(btrim(p_login))
          or lower(c.code) = lower(btrim(p_login))
          or lower(c.name) = lower(btrim(p_login)))
     and s.password_hash = extensions.crypt(p_old, s.password_hash)
   limit 1;

  if v_id is null then return false; end if;

  update customer_secrets
     set password_hash = extensions.crypt(p_new, extensions.gen_salt('bf')),
         updated_at = now()
   where customer_id = v_id;
  return true;
end;
$$;

-- ── 6. スタッフキーの確認 ────────────────────────────────────────────
create or replace function staff_key_ok(p_staff_key text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_hash text;
begin
  select hash into v_hash from app_secrets where key = 'staff_key';
  if v_hash is null then return false; end if;
  return v_hash = extensions.crypt(coalesce(p_staff_key, ''), v_hash);
end;
$$;

create or replace function staff_key_set(p_current_key text, p_new_key text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if length(coalesce(p_new_key, '')) < 12 then
    raise exception 'スタッフキーは12文字以上にしてください';
  end if;
  if not staff_key_ok(p_current_key) then return false; end if;
  update app_secrets
     set hash = extensions.crypt(p_new_key, extensions.gen_salt('bf')), updated_at = now()
   where key = 'staff_key';
  return true;
end;
$$;

-- ── 7. パスワードの発行（スタッフキーを知っている人だけ）──────────────
-- 案内を送るときに、対象のお客様ぶんを新しく発行して1度だけ受け取る。
-- 発行後は誰も平文を取り出せない（もう一度発行するしかない）。
create or replace function staff_issue_portal_passwords(p_staff_key text, p_customer_ids uuid[])
returns table (customer_id uuid, code text, name text, login_id text, password text)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare r record; v_pw text;
begin
  if not staff_key_ok(p_staff_key) then
    raise exception 'スタッフキーが違います';
  end if;
  if p_customer_ids is null or array_length(p_customer_ids, 1) is null then return; end if;
  if array_length(p_customer_ids, 1) > 1000 then
    raise exception '一度に発行できるのは1000件までです';
  end if;

  for r in
    select c.id, c.code, c.name, coalesce(c.portal_login_id, c.code) as login_id
      from customers c
     where c.id = any(p_customer_ids)
     order by c.code
  loop
    -- 6桁の数字（お客様が電話で伝えやすいように）
    v_pw := lpad((floor(random() * 1000000))::int::text, 6, '0');
    insert into customer_secrets (customer_id, password_hash)
         values (r.id, extensions.crypt(v_pw, extensions.gen_salt('bf')))
    on conflict (customer_id)
      do update set password_hash = excluded.password_hash, updated_at = now();

    customer_id := r.id; code := r.code; name := r.name;
    login_id := r.login_id; password := v_pw;
    return next;
  end loop;
end;
$$;

-- 関数の呼び出し許可（中身は SECURITY DEFINER で守られている）
grant execute on function portal_login(text, text) to anon, authenticated;
grant execute on function portal_change_password(text, text, text) to anon, authenticated;
grant execute on function staff_key_ok(text) to anon, authenticated;
grant execute on function staff_key_set(text, text) to anon, authenticated;
grant execute on function staff_issue_portal_passwords(text, uuid[]) to anon, authenticated;

-- 平文のパスワードを customers から消すのは、画面側の入れ替えが本番に出てから。
-- → migrations/20260809_portal_security_step2.sql
