-- 20260816_capture_photos_private_grants.sql
-- P0-1: capture-photos を private 化し、「grant付きRLS＋クライアント署名URL」で
--       アップロード/表示を行う仕組みに移行する（B案）。看板写真の管理表も新設。
--
-- 前提（P0-5 の 20260816_capture_photos_readonly.sql 済み）:
--   ・capture-photos は現在 public、書込ポリシー無し、public SELECT(capture_photos_read) のみ。
--   ・実オブジェクト0件・individuals の旧写真列(image_url/map_image/photo_tail_*/photo_extra)も0件。
--
-- この移行で行うこと:
--   1) 事前ガード: capture-photos にオブジェクトが存在する、または個体に旧公開写真参照が
--      残っている場合は移行を中止（fail-closed）。
--   2) 写真管理表 individual_photos（object_pathのみ保持・公開URLは保持しない）。
--   3) grant表 photo_grants（upload/read分離・短命・1回限りのupload）。
--   4) storage.objects の RLS を「有効なgrantとobject_pathの完全一致」で検証（INSERT/SELECTのみ）。
--   5) 公開SELECTポリシー撤去 + バケット private 化。
--   6) スタッフ認証つきRPC（grant発行・確定・署名DL要求・一覧）。
--
-- 署名URLはクライアントが Supabase Storage API(createSignedUploadUrl/createSignedUrl) で作成し、
-- storage の RLS が grant を検証する（本RPCは署名URLそのものを作らない）。
-- セキュリティ変更は forward-only。ロールバックでも public へは戻さない。

begin;

-- ── 1) 事前ガード（0件確認を移行直前にも強制） ─────────────────────────────
do $$
declare v_obj int; v_legacy int;
begin
  select count(*) into v_obj from storage.objects where bucket_id='capture-photos';
  if v_obj > 0 then
    raise exception 'capture-photos に既存オブジェクトが % 件あります。private化前に確認/移行が必要です', v_obj;
  end if;
  select count(*) into v_legacy from individuals
   where image_url is not null or map_image is not null
      or photo_tail_before is not null or photo_tail_after is not null or photo_extra is not null;
  if v_legacy > 0 then
    raise exception '個体に旧写真参照が % 件残っています。移行を中止します', v_legacy;
  end if;
end $$;

-- ── 2) 写真管理表 ───────────────────────────────────────────────────────────
create table if not exists public.individual_photos (
  id             uuid primary key default gen_random_uuid(),
  individual_id  uuid not null references public.individuals(id) on delete cascade,
  photo_kind     text not null check (photo_kind in ('signboard','survey_before','survey_after','survey_extra')),
  bucket_id      text not null default 'capture-photos',
  object_path    text not null unique,             -- 公開URLは保持しない（object_pathのみ）
  mime           text,
  size_bytes     bigint,
  device_label   text,                              -- 撮影者端末（staff_device_tokens.label）
  captured_at    timestamptz,
  status         text not null default 'stored' check (status in ('stored','deleted')),
  client_request_id text not null,                  -- 冪等キー
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (individual_id, client_request_id)
);
create index if not exists idx_individual_photos_individual on public.individual_photos(individual_id) where status='stored';
alter table public.individual_photos enable row level security;   -- ポリシー無し＝anon/authenticated直接アクセス不可
revoke all on public.individual_photos from anon, authenticated;

-- ── 3) grant表（アップロード/読取を分離・短命） ──────────────────────────────
create table if not exists public.photo_grants (
  id             uuid primary key default gen_random_uuid(),
  mode           text not null check (mode in ('upload','read')),
  bucket_id      text not null,
  object_path    text not null,
  individual_id  uuid not null references public.individuals(id) on delete cascade,
  photo_kind     text not null,
  client_request_id text,
  mime           text,
  max_bytes      bigint,
  expires_at     timestamptz not null,
  used_at        timestamptz,                        -- upload grantは1回限り
  created_at     timestamptz not null default now()
);
create index if not exists idx_photo_grants_lookup on public.photo_grants(object_path, mode);
alter table public.photo_grants enable row level security;   -- ポリシー無し＝直接アクセス不可
revoke all on public.photo_grants from anon, authenticated;

-- ── 4) grant検証関数（storage RLSから呼ぶ。SECURITY DEFINERでgrant表を内部参照） ──
create or replace function public.capture_photo_grant_ok(p_bucket text, p_path text, p_mode text)
returns boolean language sql stable security definer set search_path=public as $$
  select exists(
    select 1 from public.photo_grants g
    where g.bucket_id = p_bucket
      and g.object_path = p_path
      and g.mode = p_mode
      and g.expires_at > now()
      and (p_mode = 'read' or g.used_at is null)      -- upload は未使用のみ
  );
$$;
revoke all on function public.capture_photo_grant_ok(text,text,text) from public;
grant execute on function public.capture_photo_grant_ok(text,text,text) to anon, authenticated;

-- ── 5) storage.objects の RLS（公開SELECT撤去 → grant検証のINSERT/SELECTのみ） ──
drop policy if exists capture_photos_read on storage.objects;      -- 公開SELECTを撤去
drop policy if exists capture_photos_all  on storage.objects;      -- 念のため旧名も
drop policy if exists capture_photos_grant_insert on storage.objects;
drop policy if exists capture_photos_grant_read   on storage.objects;

-- INSERTのみ許可（UPSERT/UPDATE/DELETEのポリシーは作らない＝拒否）
create policy capture_photos_grant_insert on storage.objects
  for insert to anon, authenticated
  with check (bucket_id='capture-photos' and public.capture_photo_grant_ok('capture-photos', name, 'upload'));

-- 署名DL用のSELECT（read grantのある object_path だけ・バケット一覧は不可）
create policy capture_photos_grant_read on storage.objects
  for select to anon, authenticated
  using (bucket_id='capture-photos' and public.capture_photo_grant_ok('capture-photos', name, 'read'));

-- バケット private 化
update storage.buckets set public=false where id='capture-photos';

-- ── 6) 認証ヘルパ（スタッフ端末トークン or 提出トークン） ────────────────────
-- 戻り値: スタッフ端末なら device_id(uuid)、提出トークンなら null（公開・看板限定）。失敗は raise。
-- ・スタッフ: dt_ 端末トークンのみ（_ind_require_staff。生スタッフキーへはフォールバックしない）。
-- ・提出: st_ トークンが「同一individual・scope=survey_photo・期限内」かつ photo_kind='signboard' のみ。
create or replace function public._photo_auth(p_credential text, p_individual_id uuid, p_photo_kind text)
returns uuid language plpgsql stable security definer set search_path=public,extensions as $$
declare v_iid uuid;
begin
  if coalesce(p_credential,'') = '' then
    raise exception '認証情報がありません'; end if;
  if p_credential like 'st\_%' then
    if p_photo_kind <> 'signboard' then
      raise exception '提出トークンで許可されるのは看板写真のみです'; end if;
    select individual_id into v_iid from public.submission_tokens
     where token_sha256 = encode(extensions.digest(p_credential,'sha256'),'hex')
       and scope='survey_photo' and expires_at > now() limit 1;
    if v_iid is null then raise exception '提出用トークンが無効か期限切れです'; end if;
    if v_iid <> p_individual_id then raise exception 'トークンが対象個体のものではありません'; end if;
    return null;                       -- 公開（提出トークン）
  end if;
  return _ind_require_staff(p_credential);   -- dt_ のみ受理。無効/期限切れ/失効は raise
end; $$;
revoke all on function public._photo_auth(text,uuid,text) from public;

-- 6-1) アップロードgrント発行（credential=スタッフ端末 or 提出トークン）
create or replace function public.photo_request_upload(
  p_credential text, p_individual_id uuid, p_photo_kind text,
  p_client_request_id text, p_mime text, p_size_bytes bigint)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare
  c_max_bytes constant bigint := 8*1024*1024;   -- 8MB上限
  v_exists public.individual_photos%rowtype;
  v_grant  public.photo_grants%rowtype;
  v_lbl text; v_ext text; v_path text; v_exp timestamptz := now()+interval '2 min';
begin
  if p_photo_kind not in ('signboard','survey_before','survey_after','survey_extra') then
    raise exception '写真種別が不正です'; end if;
  if coalesce(p_mime,'') not in ('image/jpeg','image/png','image/webp') then
    raise exception '対応していない画像形式です'; end if;
  if p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > c_max_bytes then
    raise exception '画像サイズが不正です（8MBまで）'; end if;
  if coalesce(p_client_request_id,'') = '' then raise exception 'request_idが必要です'; end if;
  if not exists(select 1 from public.individuals where id=p_individual_id and deleted_at is null) then
    raise exception '個体が見つかりません'; end if;
  perform public._photo_auth(p_credential, p_individual_id, p_photo_kind);   -- 認証（失敗はraise）

  -- 冪等: 既に確定済みなら同じ object_path を返す（新規grantは出さない）
  select * into v_exists from public.individual_photos
   where individual_id=p_individual_id and client_request_id=p_client_request_id;
  if v_exists.id is not null then
    return jsonb_build_object('object_path', v_exists.object_path, 'bucket_id', v_exists.bucket_id,
                              'already_confirmed', true);
  end if;

  -- 冪等: 未使用の upload grant があれば同じ path を返す（再送）
  select * into v_grant from public.photo_grants
   where mode='upload' and individual_id=p_individual_id and photo_kind=p_photo_kind
     and client_request_id=p_client_request_id and used_at is null and expires_at>now();
  if v_grant.id is not null then
    return jsonb_build_object('object_path', v_grant.object_path, 'bucket_id', v_grant.bucket_id,
                              'expires_at', v_grant.expires_at);
  end if;

  select label_id into v_lbl from public.individuals where id=p_individual_id;
  v_ext := case p_mime when 'image/png' then 'png' when 'image/webp' then 'webp' else 'jpg' end;
  -- サーバ選定path: label_id/種別/128bit乱数.ext（予測不可・label_idだけの形式にしない）
  v_path := coalesce(nullif(regexp_replace(v_lbl,'[^A-Za-z0-9_-]','_','g'),''),'unknown') || '/' || p_photo_kind || '/'
            || encode(extensions.gen_random_bytes(16),'hex') || '.' || v_ext;

  insert into public.photo_grants(mode,bucket_id,object_path,individual_id,photo_kind,client_request_id,mime,max_bytes,expires_at)
  values ('upload','capture-photos',v_path,p_individual_id,p_photo_kind,p_client_request_id,p_mime,p_size_bytes,v_exp);

  return jsonb_build_object('object_path', v_path, 'bucket_id','capture-photos', 'expires_at', v_exp);
end; $$;
revoke all on function public.photo_request_upload(text,uuid,text,text,text,bigint) from public;
grant execute on function public.photo_request_upload(text,uuid,text,text,text,bigint) to anon, authenticated;

-- 6-2) アップロード確定（storage実在確認 → individual_photos 記録・grant消費）
create or replace function public.photo_confirm_upload(p_credential text, p_client_request_id text)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_grant public.photo_grants%rowtype; v_exists public.individual_photos%rowtype;
        v_sz bigint; v_mt text; v_oid uuid; v_id uuid; v_dev uuid; v_label text;
begin
  if coalesce(p_client_request_id,'')='' then raise exception 'request_idが必要です'; end if;

  select * into v_grant from public.photo_grants
   where mode='upload' and client_request_id=p_client_request_id
   order by created_at desc limit 1;
  if v_grant.id is null then raise exception '対象のアップロード許可が見つかりません'; end if;

  -- 認証（grantのindividual/種別に対して credential を検証）
  v_dev := public._photo_auth(p_credential, v_grant.individual_id, v_grant.photo_kind);

  -- 冪等: 既に確定済みなら同じ結果
  select * into v_exists from public.individual_photos
   where individual_id=v_grant.individual_id and client_request_id=p_client_request_id;
  if v_exists.id is not null then
    return jsonb_build_object('photo_id', v_exists.id, 'object_path', v_exists.object_path, 'duplicate', true);
  end if;

  -- storage.objects に bucket+path 完全一致で実在するか（＋MIME・容量）
  select o.id, (o.metadata->>'size')::bigint, o.metadata->>'mimetype'
    into v_oid, v_sz, v_mt
    from storage.objects o
   where o.bucket_id=v_grant.bucket_id and o.name=v_grant.object_path;
  if v_oid is null then raise exception 'アップロードが確認できません'; end if;
  if v_sz is not null and v_grant.max_bytes is not null and v_sz > v_grant.max_bytes then
    raise exception 'サイズ超過です'; end if;
  if v_mt is not null and v_mt not in ('image/jpeg','image/png','image/webp') then
    raise exception '対応していない画像形式です'; end if;

  if v_dev is not null then
    select label into v_label from public.staff_device_tokens where id=v_dev;
  end if;
  insert into public.individual_photos(individual_id, photo_kind, bucket_id, object_path, mime, size_bytes,
                                       device_label, captured_at, status, client_request_id)
  values (v_grant.individual_id, v_grant.photo_kind, v_grant.bucket_id, v_grant.object_path,
          coalesce(v_mt, v_grant.mime), v_sz, v_label, now(), 'stored', p_client_request_id)
  on conflict (individual_id, client_request_id) do nothing
  returning id into v_id;

  if v_id is null then   -- 競合で既に入っていた
    select id into v_id from public.individual_photos
     where individual_id=v_grant.individual_id and client_request_id=p_client_request_id;
    return jsonb_build_object('photo_id', v_id, 'object_path', v_grant.object_path, 'duplicate', true);
  end if;

  -- 看板写真は市役所提出用の主画像ポインタ(image_url=object_path)も更新（公開URLは保存しない）
  if v_grant.photo_kind = 'signboard' then
    update public.individuals set image_url = v_grant.object_path where id = v_grant.individual_id;
  end if;

  update public.photo_grants set used_at=now() where id=v_grant.id;   -- upload grant消費（1回限り）
  return jsonb_build_object('photo_id', v_id, 'object_path', v_grant.object_path, 'duplicate', false);
end; $$;
revoke all on function public.photo_confirm_upload(text,text) from public;
grant execute on function public.photo_confirm_upload(text,text) to anon, authenticated;

-- 6-3) 署名DL要求（read grant を60秒で発行。クライアントが createSignedUrl を呼ぶ）
create or replace function public.photo_request_read(p_credential text, p_photo_id uuid)
returns jsonb language plpgsql security definer set search_path=public,extensions as $$
declare v_p public.individual_photos%rowtype; v_exp timestamptz := now()+interval '60 sec';
begin
  select * into v_p from public.individual_photos where id=p_photo_id and status='stored';
  if v_p.id is null then raise exception '写真が見つかりません'; end if;
  perform public._photo_auth(p_credential, v_p.individual_id, v_p.photo_kind);   -- 認証
  insert into public.photo_grants(mode,bucket_id,object_path,individual_id,photo_kind,expires_at)
  values ('read', v_p.bucket_id, v_p.object_path, v_p.individual_id, v_p.photo_kind, v_exp);
  return jsonb_build_object('bucket_id', v_p.bucket_id, 'object_path', v_p.object_path, 'expires_at', v_exp);
end; $$;
revoke all on function public.photo_request_read(text,uuid) from public;
grant execute on function public.photo_request_read(text,uuid) to anon, authenticated;

-- 6-4) 個体の写真一覧（スタッフ端末のみ。表示メタのみ返し公開URLは作らない）
create or replace function public.photo_list(p_credential text, p_individual_id uuid)
returns table(id uuid, photo_kind text, mime text, size_bytes bigint, captured_at timestamptz, created_at timestamptz)
language plpgsql stable security definer set search_path=public,extensions as $$
begin
  perform public._ind_require_staff(p_credential);   -- 一覧はスタッフ端末のみ
  return query
    select p.id, p.photo_kind, p.mime, p.size_bytes, p.captured_at, p.created_at
      from public.individual_photos p
     where p.individual_id=p_individual_id and p.status='stored'
     order by p.created_at;
end; $$;
revoke all on function public.photo_list(text,uuid) from public;
grant execute on function public.photo_list(text,uuid) to anon, authenticated;

commit;
