-- ============================================================
-- ALCO OS  0009: プロフィール自動プロビジョニング + 承認権限
--
-- 1. デフォルト組織・ロールを投入（seed と同じ固定UUIDで冪等）
-- 2. provision_profile(): 初回ログイン時に profiles / user_roles を
--    自動作成する（最初のユーザーは owner、以降は staff）
-- 3. 承認権限: generated_drafts の update を owner / manager に限定
-- ============================================================

-- ── デフォルト組織・ロール ──
insert into organizations (id, name, slug)
values ('00000000-0000-0000-0000-000000000001', '合同会社アルコ', 'alco')
on conflict (slug) do nothing;

insert into roles (organization_id, key, name, permissions)
select o.id, r.key, r.name, r.permissions::jsonb
from organizations o,
     (values
       ('owner',   '代表',        '{"all": true}'),
       ('manager', 'マネージャー', '{"approve_drafts": true}'),
       ('staff',   'スタッフ',    '{"field_entry": true}')
     ) as r(key, name, permissions)
where o.slug = 'alco'
on conflict (organization_id, key) do nothing;

-- ── プロフィール自動プロビジョニング ──
-- 初回ログイン時にアプリから rpc('provision_profile') で呼ぶ。
-- Supabase Dashboard でユーザーを作るだけで ALCO OS を使い始められる。
create or replace function provision_profile(p_display_name text default null)
returns profiles
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_org uuid;
  v_profile profiles;
  v_role_key text;
  v_role_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  select p.* into v_profile from profiles p where p.id = v_uid;
  if found then
    return v_profile;
  end if;

  select email into v_email from auth.users where id = v_uid;
  select id into v_org from organizations where slug = 'alco';
  if v_org is null then
    raise exception 'default organization (slug=alco) not found';
  end if;

  insert into profiles (id, organization_id, display_name, email)
  values (
    v_uid,
    v_org,
    coalesce(nullif(p_display_name, ''), split_part(coalesce(v_email, ''), '@', 1), 'ユーザー'),
    v_email
  )
  returning * into v_profile;

  -- 最初のユーザーは owner、以降は staff（ロール変更は user_roles で行う）
  if (select count(*) from profiles where organization_id = v_org) = 1 then
    v_role_key := 'owner';
  else
    v_role_key := 'staff';
  end if;

  select id into v_role_id from roles where organization_id = v_org and key = v_role_key;
  if v_role_id is not null then
    insert into user_roles (user_id, role_id)
    values (v_uid, v_role_id)
    on conflict do nothing;
  end if;

  insert into audit_logs (organization_id, actor_id, action, table_name, record_id, note)
  values (v_org, v_uid, 'insert', 'profiles', v_uid,
          'auto-provisioned with role ' || v_role_key);

  return v_profile;
end;
$$;

-- ── 承認権限ヘルパー ──
create or replace function can_approve()
returns boolean
language sql stable security definer set search_path = public
as $$
  select has_role('owner') or has_role('manager');
$$;

-- ── generated_drafts: update を承認権限者に限定 ──
-- （select / insert はメンバー全員可。delete はポリシーなし＝不可）
drop policy if exists generated_drafts_member_all on generated_drafts;

do $$ begin
  create policy generated_drafts_select on generated_drafts for select
    using (organization_id = current_organization_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy generated_drafts_insert on generated_drafts for insert
    with check (organization_id = current_organization_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy generated_drafts_update_approver on generated_drafts for update
    using (organization_id = current_organization_id() and can_approve())
    with check (organization_id = current_organization_id());
exception when duplicate_object then null; end $$;
