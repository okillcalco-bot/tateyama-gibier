-- ============================================================
-- ALCO OS  0029: FB投稿 横展開システム（Phase 1）
--
-- 沖浩志のFacebook投稿を一次原稿として保存し、媒体別の下書きを生成する。
-- **自動投稿はしない。** 下書き生成 → 人の確認・修正 → 承認 が必ず入る。
--
-- 絶対ルール:
-- - 既存 social_projects（0015）とジビエ基幹は一切変更しない
-- - AI出力は generated_drafts を通る。承認は draft-service.approveDraft() のみ
-- - 承認対象は「人が編集した後の本文」。AIの元出力は証跡として不変
-- - 承認・却下・投稿済み登録・スタイル変更は owner/manager のみ（DB側でも強制）
-- - SQLは「参照より定義が先」の順（テーブル → index → 関数 → ポリシー/トリガー → seed）
-- ============================================================

-- ────────────── 1. テーブル ──────────────

-- 元のFacebook投稿（一次原稿）
create table if not exists social_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  source_url text,                          -- FB投稿URL（重複登録の主判定）
  source_no text,                           -- 沖さんの投稿番号 #連番（重複は警告のみ）
  title text,
  body text not null,                       -- 原文（必須）
  posted_on date,
  category text,                            -- 現場記録 / ジビエ / 研究データ / 自然資本 / 里山 / 経営 / 地域活動 / イベント告知 / 商品営業 / 個人的な気づき / その他
  visibility text,                          -- 元投稿の公開範囲
  related_project_id uuid,                  -- 既存 projects への汎用参照（FKなし）
  fact_sheet jsonb,                         -- analyze_crosspost_source の結果（事実・数値・引用）
  note text,
  status text not null default 'inbox',     -- inbox / analyzing / generating / reviewing / done / archived
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint social_sources_status_check
    check (status in ('inbox', 'analyzing', 'generating', 'reviewing', 'done', 'archived'))
);

-- 写真・動画（実体は Storage(alco-os) + files。ここは順番と確認フラグだけ）
create table if not exists social_source_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  social_source_id uuid not null references social_sources(id),
  file_id uuid not null references files(id),
  sort_order integer not null default 0,
  caption text,                             -- 職員が書く説明
  ai_caption text,                          -- AIの説明案（確定値ではない）
  has_person boolean not null default false,        -- 人物が写っている
  needs_public_check boolean not null default false,-- 公開してよいか確認が必要
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 媒体マスタ（画面から追加・非表示できる）
create table if not exists social_channels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  channel_key text not null,
  label text not null,
  enabled boolean not null default true,
  sort_order integer not null default 0,
  min_chars integer,
  max_chars integer,
  max_hashtags integer,
  cta_policy text,
  guidance text,                            -- 媒体固有の注意（プロンプトへ注入）
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 沖浩志スタイル（版管理。owner/manager のみ変更可）
create table if not exists social_style_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  name text not null default '沖浩志スタイル',
  version integer not null default 1,
  structure_notes text,                     -- 基本構造①〜⑥
  keep_rules text,                          -- 残すもの
  avoid_rules text,                         -- 避けるもの
  hard_rules text,                          -- 重要ルール（美化禁止など）
  is_active boolean not null default true,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 媒体ごとの下書き（人が編集する作業コピー）
create table if not exists social_channel_drafts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  social_source_id uuid not null references social_sources(id),
  channel_key text not null,
  /** 直近のAI出力。人が編集しても書き換えない（再生成したときだけ置き換わる） */
  ai_generated_draft_id uuid references generated_drafts(id),
  ai_body text,
  /** 人が編集した本文。承認されるのはこちら */
  edited_body text,
  /** 承認ボタンを押した瞬間に固定した本文（承認スナップショット） */
  approved_body text,
  approval_draft_id uuid references generated_drafts(id),
  title text,
  hashtags text[] not null default '{}',
  link_guidance text,
  cta text,
  photo_order integer[] not null default '{}',
  photo_captions text[] not null default '{}',
  narration text,
  cautions text[] not null default '{}',
  anonymized_notes text[] not null default '{}',   -- どこを伏せたか
  char_count integer,
  status text not null default 'not_generated',
    -- not_generated / draft / needs_review / editing / approved / queued / published / rejected / error
  review_reasons text[] not null default '{}',     -- センシティブ判定の理由（承認後も消さない）
  review_acknowledged_by uuid references profiles(id),
  review_acknowledged_at timestamptz,
  reject_reason text,
  approved_by uuid references profiles(id),
  approved_at timestamptz,
  error_message text,
  regenerate_count integer not null default 0,
  style_profile_id uuid references social_style_profiles(id),
  style_version integer,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint social_channel_drafts_status_check
    check (status in ('not_generated','draft','needs_review','editing','approved','queued','published','rejected','error'))
);

-- 投稿履歴
create table if not exists social_publications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  social_source_id uuid not null references social_sources(id),
  social_channel_draft_id uuid references social_channel_drafts(id),
  channel_key text not null,
  final_body text not null,                 -- 投稿した本文のスナップショット
  posted_url text,
  posted_at timestamptz,
  result text not null default 'success',   -- success / failed
  error_message text,
  publisher text not null default 'manual', -- manual / meta_api / line_api …（Phase 2）
  -- ▼ Phase 2（明示的な再投稿）で使う。Phase 1 では常に null
  repost_of_id uuid references social_publications(id),
  account_ref text,
  revision integer,
  idempotency_key text,
  approved_by uuid references profiles(id),
  approved_at timestamptz,
  posted_by uuid references profiles(id),
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint social_publications_result_check check (result in ('success', 'failed'))
);

-- ────────────── 2. index ──────────────

create unique index if not exists idx_social_sources_url
  on social_sources (organization_id, source_url) where source_url is not null;
create index if not exists idx_social_sources_status
  on social_sources (organization_id, status, created_at desc);

create unique index if not exists idx_social_source_assets_unique
  on social_source_assets (social_source_id, file_id);
create index if not exists idx_social_source_assets_order
  on social_source_assets (social_source_id, sort_order);

create unique index if not exists idx_social_channels_key
  on social_channels (organization_id, channel_key);

create unique index if not exists idx_social_style_profiles_version
  on social_style_profiles (organization_id, name, version);

create unique index if not exists idx_social_channel_drafts_unique
  on social_channel_drafts (social_source_id, channel_key);
create index if not exists idx_social_channel_drafts_status
  on social_channel_drafts (organization_id, status, updated_at desc);

-- 誤操作の二重登録を防ぐ（Phase 1 は再投稿を扱わない。Phase 2 で条件を差し替える）
create unique index if not exists idx_social_publications_unique_success
  on social_publications (social_source_id, channel_key) where result = 'success';
create index if not exists idx_social_publications_recent
  on social_publications (organization_id, created_at desc);

-- ────────────── 3. 関数（権限と整合性の強制） ──────────────

-- 子テーブルが別組織の親を参照していないか確かめる
create or replace function alco_social_assert_same_org()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  parent_org uuid;
  draft_org uuid;
  draft_source uuid;
  draft_channel text;
begin
  if tg_table_name = 'social_source_assets' then
    select organization_id into parent_org from social_sources where id = new.social_source_id;
    if parent_org is null or parent_org <> new.organization_id then
      raise exception '別の組織の元投稿には紐づけられません';
    end if;
    select organization_id into parent_org from files where id = new.file_id;
    if parent_org is null or parent_org <> new.organization_id then
      raise exception '別の組織のファイルには紐づけられません';
    end if;

  elsif tg_table_name = 'social_channel_drafts' then
    select organization_id into parent_org from social_sources where id = new.social_source_id;
    if parent_org is null or parent_org <> new.organization_id then
      raise exception '別の組織の元投稿には紐づけられません';
    end if;

  elsif tg_table_name = 'social_publications' then
    select organization_id into parent_org from social_sources where id = new.social_source_id;
    if parent_org is null or parent_org <> new.organization_id then
      raise exception '別の組織の元投稿には紐づけられません';
    end if;

    -- 下書きが「同じ組織・同じ元投稿・同じ媒体」であることまで確かめる
    if new.social_channel_draft_id is not null then
      select organization_id, social_source_id, channel_key
        into draft_org, draft_source, draft_channel
        from social_channel_drafts where id = new.social_channel_draft_id;
      if draft_org is null then
        raise exception '下書きが見つかりません';
      end if;
      if draft_org <> new.organization_id then
        raise exception '別の組織の下書きは投稿履歴に紐づけられません';
      end if;
      if draft_source <> new.social_source_id then
        raise exception '別の元投稿の下書きは投稿履歴に紐づけられません';
      end if;
      if draft_channel <> new.channel_key then
        raise exception '媒体が一致しない下書きは投稿履歴に紐づけられません';
      end if;
    end if;
  end if;
  return new;
end;
$$;

-- INSERT で最初から承認済みにする抜け道を塞ぐ
create or replace function alco_social_enforce_draft_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('approved', 'queued', 'published') and not coalesce(can_approve(), false) then
    raise exception '承認済みの状態で作成することはできません';
  end if;
  -- 承認まわりの列は作成時に埋めさせない（承認は必ず所定の手続きを通す）
  new.approved_body := null;
  new.approval_draft_id := null;
  new.approved_by := null;
  new.approved_at := null;
  new.review_acknowledged_by := null;
  new.review_acknowledged_at := null;
  return new;
end;
$$;

-- 承認まわりの列は owner/manager しか動かせない。承認者・日時はサーバーが決める
create or replace function alco_social_enforce_approval()
returns trigger language plpgsql security definer set search_path = public as $$
declare approver boolean;
begin
  approver := coalesce(can_approve(), false);

  -- 識別のための列は後から変えられない。
  -- （承認済みの行の元投稿・媒体を差し替えると、承認の証跡が
  --   別の投稿・別の媒体に付け替えられたのと同じことになる）
  if new.organization_id is distinct from old.organization_id
     or new.social_source_id is distinct from old.social_source_id
     or new.channel_key is distinct from old.channel_key
     or new.created_by is distinct from old.created_by
  then
    raise exception '下書きの組織・元投稿・媒体・作成者は後から変えられません（新しい下書きを作ってください）';
  end if;

  -- 承認・却下・投稿済みへの遷移、**および承認済みからの引き戻し**、
  -- 承認まわりの列の操作は owner/manager のみ。
  -- 変更前・変更後の**どちらか**が承認系の状態なら承認権限を要る形にして、
  -- approved → editing / published → draft のような逆方向も塞ぐ。
  if (new.status is distinct from old.status
        and (new.status in ('approved', 'rejected', 'queued', 'published')
             or old.status in ('approved', 'rejected', 'queued', 'published')))
     or (new.approved_body is distinct from old.approved_body)
     or (new.approval_draft_id is distinct from old.approval_draft_id)
     or (new.approved_by is distinct from old.approved_by)
     or (new.approved_at is distinct from old.approved_at)
     or (new.review_acknowledged_by is distinct from old.review_acknowledged_by)
     or (new.review_acknowledged_at is distinct from old.review_acknowledged_at)
  then
    if not approver then
      raise exception '承認・却下・差し戻しには承認権限（owner / manager）が必要です';
    end if;
  end if;

  -- 承認証跡のIDは、承認・差し戻し以外で書き換えさせない
  if new.approval_draft_id is distinct from old.approval_draft_id then
    if not (
      -- 承認したとき（新しい証跡を結ぶ）
      (new.status = 'approved' and old.status is distinct from 'approved')
      -- 差し戻したとき（証跡との結びを外す）
      or (new.approval_draft_id is null
          and new.status in ('draft', 'editing', 'needs_review', 'not_generated'))
    ) then
      raise exception '承認の証跡は付け替えられません';
    end if;
  end if;

  -- 承認者・承認日時はクライアントの指定を信用しない
  if new.status = 'approved' and old.status is distinct from 'approved' then
    new.approved_by := auth.uid();
    new.approved_at := now();
  elsif new.status is distinct from old.status
        and new.status in ('draft', 'editing', 'needs_review', 'not_generated') then
    -- 差し戻し時は承認情報を消す
    new.approved_by := null;
    new.approved_at := null;
  else
    new.approved_by := old.approved_by;
    new.approved_at := old.approved_at;
  end if;

  -- 確認者・確認日時も同様
  if new.review_acknowledged_by is distinct from old.review_acknowledged_by
     or new.review_acknowledged_at is distinct from old.review_acknowledged_at then
    if new.review_acknowledged_by is not null or new.review_acknowledged_at is not null then
      new.review_acknowledged_by := auth.uid();
      new.review_acknowledged_at := now();
    end if;
  end if;

  -- センシティブ判定の理由は**追記のみ**。
  -- 空にするのはもちろん、別の内容へ差し替えることもできない。
  -- （古い要素がすべて残っているときだけ、新しい配列を受け入れる）
  if old.review_reasons is distinct from new.review_reasons then
    if not (coalesce(old.review_reasons, '{}') <@ coalesce(new.review_reasons, '{}')) then
      raise exception '確認が必要な理由は消したり書き換えたりできません（追記のみ）';
    end if;
  end if;

  return new;
end;
$$;

/*
 * 承認を1つのトランザクションで行う。
 *
 * 承認スナップショットの作成・本文の確定・承認状態の更新・監査ログを
 * 別々のDB操作で行うと、途中で失敗したときに
 * 「承認ドラフトだけ残る」「本文だけ承認済みになる」状態が起きうる。
 * 関数の中はひとつのトランザクションなので、全部成功か全部失敗になる。
 */
create or replace function alco_crosspost_approve(
  p_draft_id uuid,
  p_final_body text,
  p_acknowledge boolean default false
)
returns social_channel_drafts
language plpgsql security definer set search_path = public as $$
declare
  v_draft social_channel_drafts;
  v_org uuid;
  v_actor uuid;
  v_approval_id uuid;
  v_reasons text[];
begin
  if not coalesce(can_approve(), false) then
    raise exception '承認には承認権限（owner / manager）が必要です';
  end if;

  v_org := current_organization_id();
  v_actor := auth.uid();

  select * into v_draft from social_channel_drafts where id = p_draft_id for update;
  if v_draft.id is null then
    raise exception '下書きが見つかりません';
  end if;
  if v_draft.organization_id <> v_org then
    raise exception '他の組織の下書きは承認できません';
  end if;
  if v_draft.status in ('approved', 'published') then
    raise exception 'この下書きはすでに承認されています';
  end if;
  if v_draft.status in ('not_generated', 'error') then
    raise exception '先に下書きを作ってください';
  end if;
  if coalesce(length(btrim(p_final_body)), 0) = 0 then
    raise exception '本文が空です';
  end if;

  v_reasons := coalesce(v_draft.review_reasons, '{}');
  if array_length(v_reasons, 1) is not null and not p_acknowledge then
    raise exception '要確認の理由を確認してから承認してください';
  end if;

  -- 承認スナップショット（この内容で承認したという証跡）
  insert into generated_drafts (
    organization_id, draft_type, source_table, source_id, title, content,
    needs_human_review, warnings, status, reviewed_by, reviewed_at, applied_at, created_by
  ) values (
    v_org, 'crosspost_approval', 'social_channel_drafts', p_draft_id,
    v_draft.channel_key || ' の承認本文',
    jsonb_build_object(
      'channel_key', v_draft.channel_key,
      'body', p_final_body,
      'title', v_draft.title,
      'hashtags', to_jsonb(coalesce(v_draft.hashtags, '{}')),
      'cta', v_draft.cta,
      'link_guidance', v_draft.link_guidance,
      'photo_order', to_jsonb(coalesce(v_draft.photo_order, '{}')),
      'review_reasons', to_jsonb(v_reasons),
      'snapshot_at', now()
    ),
    false, v_reasons, 'approved', v_actor, now(), now(), v_actor
  ) returning id into v_approval_id;

  update social_channel_drafts set
    status = 'approved',
    approved_body = p_final_body,
    approval_draft_id = v_approval_id,
    review_acknowledged_by = case when array_length(v_reasons, 1) is not null then v_actor else review_acknowledged_by end,
    review_acknowledged_at = case when array_length(v_reasons, 1) is not null then now() else review_acknowledged_at end
  where id = p_draft_id
  returning * into v_draft;

  insert into audit_logs (organization_id, actor_id, action, table_name, record_id, after, note)
  values (
    v_org, v_actor, 'approve', 'social_channel_drafts', p_draft_id,
    to_jsonb(v_draft),
    case when array_length(v_reasons, 1) is not null
      then v_draft.channel_key || ' を承認（確認した理由: ' || array_to_string(v_reasons, ' / ') || '）'
      else v_draft.channel_key || ' を承認' end
  );

  return v_draft;
end;
$$;

/*
 * 投稿済みの登録を1つのトランザクションで行う。
 *
 * 履歴のINSERTだけ成功して下書きの状態更新が失敗すると、
 * unique制約で再登録できず、履歴はRLSで更新も削除もできないため復旧が難しい。
 * 関数の中はひとつのトランザクションなので、全部成功か全部失敗になる。
 */
create or replace function alco_crosspost_record_publication(
  p_draft_id uuid,
  p_posted_url text default null,
  p_posted_at timestamptz default null
)
returns social_publications
language plpgsql security definer set search_path = public as $$
declare
  v_draft social_channel_drafts;
  v_pub social_publications;
  v_org uuid;
  v_actor uuid;
begin
  if not coalesce(can_approve(), false) then
    raise exception '投稿済みの登録には承認権限（owner / manager）が必要です';
  end if;

  v_org := current_organization_id();
  v_actor := auth.uid();

  select * into v_draft from social_channel_drafts where id = p_draft_id for update;
  if v_draft.id is null then
    raise exception '下書きが見つかりません';
  end if;
  if v_draft.organization_id <> v_org then
    raise exception '他の組織の下書きは登録できません';
  end if;

  -- 誤操作の二重登録を先に弾く（1回目で published になるため、状態確認より先に見る）
  if exists (
    select 1 from social_publications
    where social_source_id = v_draft.social_source_id
      and channel_key = v_draft.channel_key
      and result = 'success'
  ) then
    raise exception 'この媒体はすでに投稿済みとして登録されています';
  end if;

  if v_draft.status not in ('approved', 'queued') then
    raise exception '承認していない下書きは投稿済みにできません';
  end if;
  if coalesce(length(btrim(v_draft.approved_body)), 0) = 0 then
    raise exception '承認した本文がありません';
  end if;

  insert into social_publications (
    organization_id, social_source_id, social_channel_draft_id, channel_key,
    final_body, posted_url, posted_at, result, publisher,
    approved_by, approved_at, posted_by, created_by
  ) values (
    v_org, v_draft.social_source_id, p_draft_id, v_draft.channel_key,
    v_draft.approved_body, nullif(btrim(coalesce(p_posted_url, '')), ''),
    coalesce(p_posted_at, now()), 'success', 'manual',
    v_draft.approved_by, v_draft.approved_at, v_actor, v_actor
  ) returning * into v_pub;

  update social_channel_drafts set status = 'published' where id = p_draft_id;

  insert into audit_logs (organization_id, actor_id, action, table_name, record_id, after, note)
  values (
    v_org, v_actor, 'insert', 'social_publications', v_pub.id,
    to_jsonb(v_pub), v_draft.channel_key || ' を投稿済みとして登録'
  );

  return v_pub;
end;
$$;

comment on function alco_crosspost_record_publication(uuid, text, timestamptz) is
  '投稿済みの登録を1トランザクションで行う（重複確認・履歴作成・下書きの状態更新・監査ログ）。0029';

revoke all on function alco_crosspost_record_publication(uuid, text, timestamptz) from public;
grant execute on function alco_crosspost_record_publication(uuid, text, timestamptz) to authenticated;

comment on function alco_crosspost_approve(uuid, text, boolean) is
  '媒体別の承認を1トランザクションで行う（スナップショット作成・本文確定・状態更新・監査ログ）。0029';

revoke all on function alco_crosspost_approve(uuid, text, boolean) from public;
grant execute on function alco_crosspost_approve(uuid, text, boolean) to authenticated;

-- ────────────── 4. ポリシーとトリガー ──────────────
--
-- 【重要】PostgreSQLの通常ポリシーは **OR 条件**で評価される。
-- alco_add_member_policy() は「組織メンバーに全CRUD」を許可する FOR ALL ポリシーなので、
-- あとから owner/manager 限定のポリシーを足しても**制限にならない**。
-- そのため、制限が要るテーブルでは alco_add_member_policy() を**使わず**、
-- SELECT / INSERT / UPDATE を用途ごとに明示する。

-- 制限の要らないテーブルは従来どおり（メンバーなら誰でも扱ってよい）
select alco_add_member_policy('social_sources');
select alco_add_member_policy('social_source_assets');

-- 制限が要るテーブルは自前でポリシーを張る
alter table social_channels enable row level security;
alter table social_style_profiles enable row level security;
alter table social_channel_drafts enable row level security;
alter table social_publications enable row level security;

-- 媒体マスタ: 閲覧はメンバー、変更は owner/manager
do $$ begin
  create policy social_channels_select on social_channels for select
    using (organization_id = current_organization_id());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy social_channels_insert on social_channels for insert
    with check (organization_id = current_organization_id() and can_approve());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy social_channels_update on social_channels for update
    using (organization_id = current_organization_id() and can_approve())
    with check (organization_id = current_organization_id() and can_approve());
exception when duplicate_object then null; end $$;
-- delete ポリシーは作らない（媒体は非表示にする運用）

-- スタイル設定: 閲覧はメンバー、追加・変更は owner/manager
do $$ begin
  create policy social_style_profiles_select on social_style_profiles for select
    using (organization_id = current_organization_id());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy social_style_profiles_insert on social_style_profiles for insert
    with check (organization_id = current_organization_id() and can_approve());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy social_style_profiles_update on social_style_profiles for update
    using (organization_id = current_organization_id() and can_approve())
    with check (organization_id = current_organization_id() and can_approve());
exception when duplicate_object then null; end $$;

-- 投稿履歴: 閲覧はメンバー、登録は owner/manager。**更新・削除はできない**（履歴の保全）
do $$ begin
  create policy social_publications_select on social_publications for select
    using (organization_id = current_organization_id());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy social_publications_insert on social_publications for insert
    with check (organization_id = current_organization_id() and can_approve());
exception when duplicate_object then null; end $$;

-- 媒体別の下書き:
--   閲覧・作成・編集はメンバー。ただし**作成時に承認済みの状態にはできない**
--   （承認まわりの列はトリガーでも消すが、ポリシーでも二重に塞ぐ）
--   承認・却下への遷移は UPDATE トリガーで owner/manager に限定
do $$ begin
  create policy social_channel_drafts_select on social_channel_drafts for select
    using (organization_id = current_organization_id());
exception when duplicate_object then null; end $$;
do $$ begin
  create policy social_channel_drafts_insert on social_channel_drafts for insert
    with check (
      organization_id = current_organization_id()
      and status in ('not_generated', 'draft', 'needs_review', 'editing', 'error')
      and approved_body is null
      and approved_at is null
      and approved_by is null
      and approval_draft_id is null
    );
exception when duplicate_object then null; end $$;
do $$ begin
  create policy social_channel_drafts_update on social_channel_drafts for update
    using (organization_id = current_organization_id())
    with check (organization_id = current_organization_id());
exception when duplicate_object then null; end $$;
-- delete ポリシーは作らない（却下はステータスで表す）

do $$
declare t text;
begin
  foreach t in array array[
    'social_sources','social_source_assets','social_channels',
    'social_style_profiles','social_channel_drafts','social_publications'
  ]
  loop
    execute format('drop trigger if exists trg_%s_updated_at on %s', t, t);
    execute format('create trigger trg_%s_updated_at before update on %s
                    for each row execute function set_updated_at()', t, t);
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array['social_source_assets','social_channel_drafts','social_publications']
  loop
    execute format('drop trigger if exists trg_%s_same_org on %s', t, t);
    execute format('create trigger trg_%s_same_org before insert or update on %s
                    for each row execute function alco_social_assert_same_org()', t, t);
  end loop;
end $$;

drop trigger if exists trg_social_channel_drafts_insert on social_channel_drafts;
create trigger trg_social_channel_drafts_insert
  before insert on social_channel_drafts
  for each row execute function alco_social_enforce_draft_insert();

drop trigger if exists trg_social_channel_drafts_approval on social_channel_drafts;
create trigger trg_social_channel_drafts_approval
  before update on social_channel_drafts
  for each row execute function alco_social_enforce_approval();

-- ────────────── 5. 初期データ ──────────────

-- 媒体8件（facebook_page は運用確認後に有効化する想定で false）
insert into social_channels
  (organization_id, channel_key, label, enabled, sort_order, min_chars, max_chars, max_hashtags, cta_policy, guidance)
select o.id, v.channel_key, v.label, v.enabled, v.sort_order,
       v.min_chars, v.max_chars, v.max_hashtags, v.cta_policy, v.guidance
from organizations o
cross join (values
  ('instagram','Instagram',true,10,600,1200,5,'CTAは1つ','写真中心。カルーセルは各ページの見出しも作る'),
  ('threads','Threads',true,20,300,500,3,'詳細はFacebookかWebへ誘導','一つの問い・気づき・葛藤に絞る'),
  ('line_official','LINE公式',true,30,250,500,0,'CTAは1つだけ','読者に関係する要点を先に。配信対象と目的を明示。承認なしで配信しない'),
  ('google_business','Googleビジネスプロフィール',true,40,150,700,0,'来店・問い合わせのいずれか1つ','地域・店舗・サービス・イベント中心。営業日時・価格・場所は確認できないものを書かない'),
  ('web','Web（お知らせ・ブログ）',true,50,800,3000,0,'関連ページへの導線','原文を削りすぎない。見出しと背景説明を足してよい。SEOより事実と読みやすさ'),
  ('x','X',true,60,100,280,2,'リンク1つ','一つの事実と一つの問い。長ければスレッド案にする。煽らない'),
  ('reels','Reels・Shorts台本',true,70,300,900,3,'最後に問いか案内','45〜60秒。冒頭3秒のフック。映像・写真の表示順も提案する'),
  ('facebook_page','Facebook（会社ページ）',false,80,400,1500,3,'CTAは1つ','個人の語り口を残しつつ、初見の人にも文脈が分かる書き出しにする')
) as v(channel_key,label,enabled,sort_order,min_chars,max_chars,max_hashtags,cta_policy,guidance)
where not exists (
  select 1 from social_channels c where c.organization_id = o.id and c.channel_key = v.channel_key
);

-- 沖浩志スタイル v1
insert into social_style_profiles
  (organization_id, name, version, structure_notes, keep_rules, avoid_rules, hard_rules, is_active)
select o.id, '沖浩志スタイル', 1,
  '① 【テーマ〜問い・意味 #連番】の見出し / ② その日の具体的な出来事 / ③ 頭数・重量・時間・場所などの一次情報 / ④ 現場で感じた迷い・違和感・反省 / ⑤ 地域・自然・経営への視点 / ⑥ 断定せず問いか今後の姿勢で終える',
  '一人称「僕」/ 現場の具体 / 数値 / 率直な感情 / 分からないことを分からないまま書く / 一次情報と推測の区別 / 地域との関係 / 人に会って得た情報 / 自然資本・里山・ジビエ・地域経営への接続',
  '過度な美談化 / 広告文化 / AI的な綺麗な結論 / 根拠のない断定 / 大量の絵文字とハッシュタグ / 元投稿にない感情・数値・人物・実績の追加 / 殺生や現場の葛藤を軽く扱う表現',
  '止め刺し・捕獲・ウリ坊・処理・廃棄に関する投稿では、沖本人の迷い・不快感・反省・割り切れなさを消さない。「命をいただく素晴らしい仕事」など、元原稿にない美化表現を追加しない。',
  true
from organizations o
where not exists (
  select 1 from social_style_profiles s
  where s.organization_id = o.id and s.name = '沖浩志スタイル' and s.version = 1
);

comment on table social_sources is 'FB投稿の一次原稿。横展開の起点（0029）';
comment on table social_channel_drafts is '媒体ごとの下書き。ai_body=直近のAI出力（再生成すると置き換わる。過去のAI出力は generated_drafts(crosspost_ai_output) に残る）/ edited_body=人の修正 / approved_body=承認時に固定した本文（不変）（0029）';
comment on function alco_social_enforce_approval() is '承認・却下・差し戻しの操作を owner/manager に限定し、承認者と日時をサーバー側で決める。識別列（組織・元投稿・媒体・作成者）は変更不可（0029）';
