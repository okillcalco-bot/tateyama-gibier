-- ============================================================================
-- シーモルト連携: 注文取込の補助表・MCP用関数・「要確認」の書込みガード
-- 状態: 【案・本番未適用】 2026-10-02 作成。本番適用は本人の承認後（docs/03-approval.md）
-- ============================================================================
--
-- 方針
--   * 受注の正本は既存の orders / order_items のまま。この案は既存IDを参照する補助表だけを足す。
--   * 補助表は PostgREST に公開されていない専用スキーマ order_link に置く（anon/authenticated から見えない）。
--   * MCPサーバーは専用ロール seamalt_mcp で接続し、order_link.api_* の5関数だけを実行できる。
--     表への直接の SELECT/INSERT/UPDATE 権限は持たない（service_role も使わない）。
--   * 「要確認」は orders.status に新しい値を足さず、order_link.external_refs.review_state で持つ。
--     既存表のトリガーで、要確認の注文が 確認済/発送済/納品完了・出荷・引当・帳票 に進む書込みを DB 側で拒否する。
--   * 取込の登録（ヘッダー・明細・外部参照・明細補助・監査）は api_import_commit の1回の呼出し＝1トランザクション。
--
-- SECURITY DEFINER を使う理由（レビュー用）
--   order_link.* の表は anon にも seamalt_mcp にも直接の権限を与えない。関数の中でだけ読み書きさせ、
--   関数の先頭で「検証済みの主体（principals）・スコープ・組織」を確認する。search_path は全関数で固定。
--   実行権限は PUBLIC から剥がし、api_* は seamalt_mcp だけ、public.order_link_* は下記の理由で anon にも付ける。
--
-- 前提: 本番の orders / order_items / customers / shipments / documents / document_orders /
--       inventory_allocations / price_master / staff_key_header_ok() が 2026-10-02 時点の定義であること。

begin;

create schema if not exists order_link;
revoke all on schema order_link from public;

-- MCPサーバー専用ロール。ログイン可否とパスワードはこのファイルでは設定しない（本人が安全な画面で設定する）
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'seamalt_mcp') then
    create role seamalt_mcp nologin noinherit;
  end if;
end $$;
grant usage on schema order_link to seamalt_mcp;

-- ── 主体（MCPの利用者）────────────────────────────────────────────────
-- issuer + subject は認可サーバーが発行したトークンの iss / sub。本文中の user_id は使わない。
create table order_link.principals (
  id            uuid primary key default gen_random_uuid(),
  issuer        text not null check (length(issuer) between 8 and 300),
  subject       text not null check (length(subject) between 1 and 200),
  display_name  text not null check (length(display_name) between 1 and 80),
  staff_name    text check (length(staff_name) <= 80),             -- 既存の担当者名（staff.name）への対応
  org_key       text not null default 'tateyama-gibier',
  scopes        text[] not null default array['orders:read']::text[]
                check (scopes <@ array['orders:read','orders:import']::text[]),
  customer_ids  uuid[],                                            -- null = このDBの全顧客。指定すると読取りをその顧客に限定
  revoked_at    timestamptz,
  created_at    timestamptz not null default now(),
  unique (issuer, subject)
);

-- ── 出典（メール本文・添付）────────────────────────────────────────────
-- 本文や添付そのものは保存しない。識別子・ファイル名・SHA-256・ページ・受信時刻・参照リンクだけ。
create table order_link.sources (
  id             uuid primary key default gen_random_uuid(),
  provider       text not null check (provider in ('gmail','outlook','imap','upload','other')),
  account        text not null check (length(account) between 1 and 254),
  message_id     text not null check (length(message_id) between 1 and 300),
  thread_id      text check (length(thread_id) <= 300),
  attachment_id  text not null default '' check (length(attachment_id) <= 300),   -- '' = 本文
  filename       text check (length(filename) <= 255),
  sha256         text check (sha256 ~ '^[0-9a-f]{64}$'),
  pages          int[],
  received_at    timestamptz,
  link           text check (link ~ '^https://' and length(link) <= 1000),
  created_by     uuid references order_link.principals(id),
  created_at     timestamptz not null default now(),
  unique (provider, account, message_id, attachment_id)
);
create index sources_sha256_idx on order_link.sources (sha256) where sha256 is not null;

-- ── 取込候補（登録前の作業用。第二の受注台帳にしない）──────────────────
create table order_link.candidates (
  id                 uuid primary key default gen_random_uuid(),
  principal_id       uuid not null references order_link.principals(id),
  org_key            text not null,
  channel            text not null,
  issuer_account     text not null,
  external_order_id  text,
  source_key         text,
  version            int not null default 1 check (version >= 1),
  digest             text not null check (digest ~ '^[0-9a-f]{64}$'),
  content_digest     text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  payload            jsonb not null,           -- 正規化済みの内容（原文の該当箇所を含む。メール全文は持たない）
  checks             jsonb not null,           -- 照合結果（顧客候補・商品・重複・未確認・警告）
  state              text not null check (state in ('previewed','blocked','committed','superseded')),
  committed_order_id uuid references public.orders(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (external_order_id is not null or source_key is not null)
);
-- 同じ業務注文の「開いている候補」は1つだけ（並行 preview でも増えない）
create unique index candidates_open_ext_uq on order_link.candidates (org_key, channel, issuer_account, external_order_id)
  where external_order_id is not null and state in ('previewed','blocked');
create unique index candidates_open_src_uq on order_link.candidates (org_key, source_key)
  where external_order_id is null and state in ('previewed','blocked');

create table order_link.candidate_sources (
  candidate_id uuid not null references order_link.candidates(id),
  source_id    uuid not null references order_link.sources(id),
  role         text not null check (role in ('order','change','cancel','forward','reply')),
  primary key (candidate_id, source_id)
);

-- ── 外部注文参照（既存 orders への対応）────────────────────────────────
create table order_link.external_refs (
  id                 uuid primary key default gen_random_uuid(),
  org_key            text not null,
  channel            text not null,
  issuer_account     text not null,
  external_order_id  text,                                        -- PDF等に記載の注文番号（内部 order_code・Message-ID と別物）
  source_key         text,                                        -- 番号が無い注文だけ: 確認済み出典の識別子
  order_id           uuid not null references public.orders(id) on delete restrict,
  content_digest     text not null check (content_digest ~ '^[0-9a-f]{64}$'),
  revision           int not null default 1,
  review_state       text not null check (review_state in ('needs_review','confirmed')),
  link_kind          text not null default 'created' check (link_kind in ('created','linked_existing')),
  candidate_id       uuid references order_link.candidates(id),
  created_by         uuid references order_link.principals(id),
  created_at         timestamptz not null default now(),
  reviewed_at        timestamptz,
  reviewed_by        text,
  check (external_order_id is not null or source_key is not null)
);
create unique index external_refs_ext_uq on order_link.external_refs (org_key, channel, issuer_account, external_order_id)
  where external_order_id is not null;
create unique index external_refs_src_uq on order_link.external_refs (org_key, source_key)
  where external_order_id is null;
create unique index external_refs_order_uq on order_link.external_refs (order_id);

create table order_link.ref_sources (
  ref_id    uuid not null references order_link.external_refs(id),
  source_id uuid not null references order_link.sources(id),
  role      text not null,
  primary key (ref_id, source_id)
);

-- ── 明細補助（order_items 1行に1行。原文数量・単位・温度帯・希望条件・確認状態）──────
create table order_link.item_ext (
  order_item_id  uuid primary key references public.order_items(id) on delete restrict,
  ref_id         uuid not null references order_link.external_refs(id),
  line_no        int not null check (line_no between 1 and 200),
  raw_text       text not null check (length(raw_text) between 1 and 500),
  product_text   text not null check (length(product_text) between 1 and 200),
  raw_qty_text   text not null check (length(raw_qty_text) between 1 and 100),
  qty            numeric not null check (qty > 0 and qty <= 100000),
  unit           text not null check (unit in ('kg','g','本','頭','パック','個','枚','ブロック','羽')),
  normalized_kg  numeric check (normalized_kg > 0),              -- g / kg のときだけ。本・頭は null（重量を捏造しない）
  temp_zone      text not null check (temp_zone in ('fresh','chilled','frozen','unknown')),
  temp_text      text check (length(temp_text) <= 100),
  wish_text      text check (length(wish_text) <= 500),
  review_items   text[] not null default '{}',
  confirm_state  text not null check (confirm_state in ('needs_review','confirmed')),
  unique (ref_id, line_no)
);

-- ── 確定した商品対応表（名称の類似だけで置換しない。人が確認したものだけ）──────
create table order_link.product_aliases (
  id              uuid primary key default gen_random_uuid(),
  org_key         text not null,
  issuer_account  text not null,          -- '*' = 全取引先
  product_text    text not null,
  species         text not null,
  part_name       text not null,
  grade           text,
  confirmed_by    uuid references order_link.principals(id),
  confirmed_at    timestamptz not null default now(),
  unique (org_key, issuer_account, product_text)
);

-- ── 実行履歴（監査）。メール全文・秘密値・トークンは入れない ─────────────────
create table order_link.runs (
  id                uuid primary key default gen_random_uuid(),
  request_id        text check (length(request_id) <= 100),
  principal_id      uuid references order_link.principals(id),
  actor             text,                                   -- 人の操作（受発注画面での確認）のときの担当者名
  tool              text not null,
  idempotency_key   text,
  candidate_id      uuid references order_link.candidates(id),
  candidate_version int,
  digest            text,
  outcome           text not null check (outcome in ('created','already_exists','needs_review','conflict','forbidden','failed','read','confirmed')),
  order_id          uuid references public.orders(id),
  user_request      text check (length(user_request) <= 300),  -- 誰の依頼で何をしたか（会話側の要約）
  detail            jsonb not null default '{}',                -- 最小限（件数・理由コード・SQLSTATE）
  created_at        timestamptz not null default now()
);
create unique index runs_commit_key_uq on order_link.runs (principal_id, idempotency_key)
  where tool = 'order_import_commit' and idempotency_key is not null and outcome <> 'failed' and outcome <> 'forbidden';
create index runs_candidate_idx on order_link.runs (candidate_id);
create index runs_order_idx on order_link.runs (order_id);

-- 補助表はすべて RLS 有効・ポリシーなし（関数経由以外は誰も触れない）
alter table order_link.principals        enable row level security;
alter table order_link.sources           enable row level security;
alter table order_link.candidates        enable row level security;
alter table order_link.candidate_sources enable row level security;
alter table order_link.external_refs     enable row level security;
alter table order_link.ref_sources       enable row level security;
alter table order_link.item_ext          enable row level security;
alter table order_link.product_aliases   enable row level security;
alter table order_link.runs              enable row level security;
revoke all on all tables in schema order_link from public, anon, authenticated, seamalt_mcp;

-- 連携の一時停止スイッチ（切戻し用。true の間は新しい書込みを拒否し、読取りは続ける）
create table order_link.settings (key text primary key, value jsonb not null, updated_at timestamptz not null default now());
alter table order_link.settings enable row level security;
revoke all on order_link.settings from public, anon, authenticated, seamalt_mcp;
insert into order_link.settings(key, value) values ('writes_paused', 'false'::jsonb), ('org_key', '"tateyama-gibier"'::jsonb);

-- ============================================================================
-- 共通の下請け関数（実行権限は付けない。api_* の中からだけ使う）
-- ============================================================================

create or replace function order_link.fail(p_code text, p_reason text, p_extra jsonb default '{}')
returns void language plpgsql as $$
begin
  -- p_code: TS401 未認証 / TS403 権限なし / TS409 競合 / TS422 入力不正
  raise exception using errcode = p_code, message = p_reason, detail = p_extra::text;
end $$;

create or replace function order_link.sha256_hex(p jsonb) returns text
language sql immutable as $$ select encode(extensions.digest(convert_to(p::text, 'UTF8'), 'sha256'), 'hex') $$;

create or replace function order_link.like_escape(p text) returns text
language sql immutable as $$ select replace(replace(replace(p, '\', '\\'), '%', '\%'), '_', '\_') $$;

-- 文字の正規化（全角英数・空白・括弧内の補足を外して比較する）
create or replace function order_link.norm(p text) returns text
language sql immutable as $$
  select lower(regexp_replace(translate(coalesce(p, ''),
    'ＡＢＣＤＥＦＧＨＩＪＫＬＭＮＯＰＱＲＳＴＵＶＷＸＹＺａｂｃｄｅｆｇｈｉｊｋｌｍｎｏｐｑｒｓｔｕｖｗｘｙｚ０１２３４５６７８９（）　',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789() '), '\s+', '', 'g'))
$$;
create or replace function order_link.base_part(p text) returns text
language sql immutable as $$ select regexp_replace(coalesce(p, ''), '（.*?）|\(.*?\)', '', 'g') $$;

create or replace function order_link.setting(p_key text) returns jsonb
language sql stable security definer set search_path = order_link, pg_temp as $$
  select value from order_link.settings where key = p_key
$$;

-- 検証済みの主体を取り出す。p_ctx はサーバーがトークン検証後に組み立てる（引数の user_id は信用しない）
create or replace function order_link.principal_for(p_ctx jsonb, p_scope text)
returns order_link.principals
language plpgsql stable security definer set search_path = order_link, public, pg_temp as $$
declare v order_link.principals; v_org text := order_link.setting('org_key') #>> '{}';
begin
  if p_ctx is null or coalesce(p_ctx->>'issuer', '') = '' or coalesce(p_ctx->>'subject', '') = '' then
    perform order_link.fail('TS401', 'unauthenticated');
  end if;
  select * into v from order_link.principals where issuer = p_ctx->>'issuer' and subject = p_ctx->>'subject';
  if not found then perform order_link.fail('TS403', 'principal_not_registered'); end if;
  if v.revoked_at is not null then perform order_link.fail('TS403', 'principal_revoked'); end if;
  if v.org_key <> v_org or coalesce(p_ctx->>'org', '') <> v_org then perform order_link.fail('TS403', 'organization_mismatch'); end if;
  if not (p_scope = any (v.scopes)) then perform order_link.fail('TS403', 'insufficient_scope'); end if;
  -- トークン自体にスコープが載る認可サーバーでは、トークン側にも要求スコープが必要
  if jsonb_typeof(p_ctx->'token_scopes') = 'array' and not ((p_ctx->'token_scopes') ? p_scope) then
    perform order_link.fail('TS403', 'insufficient_scope');
  end if;
  return v;
end $$;

-- 引数の組織指定（任意）。指定があればこのDBの組織と一致すること
create or replace function order_link.check_org_arg(p_args jsonb) returns void
language plpgsql stable security definer set search_path = order_link, pg_temp as $$
begin
  if p_args ? 'organization' and (p_args->>'organization') is distinct from (order_link.setting('org_key') #>> '{}') then
    perform order_link.fail('TS403', 'organization_mismatch');
  end if;
end $$;

create or replace function order_link.can_see_order(p order_link.principals, p_order_id uuid) returns boolean
language sql stable security definer set search_path = order_link, public, pg_temp as $$
  select p.customer_ids is null or exists (select 1 from public.orders o where o.id = p_order_id and o.customer_id = any (p.customer_ids))
$$;

-- 1注文の要約（検索・照合・取得で共通）。出荷・請求・取消の状態を並べて返す
create or replace function order_link.order_brief(p_order_id uuid) returns jsonb
language sql stable security definer set search_path = order_link, public, pg_temp as $$
  select jsonb_build_object(
    'order_id', o.id, 'order_code', o.order_code, 'customer_id', o.customer_id, 'customer_name', o.customer_name,
    'order_date', o.order_date, 'delivery_date', o.delivery_date, 'status', o.status, 'channel', o.channel,
    'total_amount', o.total_amount, 'created_at', o.created_at,
    'external', (select jsonb_build_object('external_order_id', r.external_order_id, 'channel', r.channel,
                    'issuer_account', r.issuer_account, 'review_state', r.review_state, 'revision', r.revision, 'link_kind', r.link_kind)
                 from order_link.external_refs r where r.order_id = o.id),
    'shipments', (select jsonb_build_object('count', count(*), 'statuses', coalesce(jsonb_agg(distinct s.status), '[]'),
                    'last_shipment_date', max(s.shipment_date)) from public.shipments s where s.order_id = o.id),
    'invoice', (select jsonb_build_object('issued', count(*) > 0,
                    'doc_numbers', coalesce(jsonb_agg(distinct d.doc_number), '[]'),
                    'billing_statuses', coalesce(jsonb_agg(distinct d.billing_status) filter (where d.billing_status is not null), '[]'))
                from public.documents d
               where d.doc_type = '請求書' and coalesce(d.status, '') <> '下書き'
                 and (d.order_id = o.id or exists (select 1 from public.document_orders x where x.document_id = d.id and x.order_id = o.id))),
    'items', (select coalesce(jsonb_agg(jsonb_build_object('species', i.species, 'part_name', i.part_name, 'product_name', i.product_name,
                    'requested_kg', i.requested_kg, 'weight_kg', i.weight_kg,
                    'qty', e.qty, 'unit', e.unit, 'raw_qty_text', e.raw_qty_text, 'temp_zone', e.temp_zone) order by i.created_at, i.id), '[]')
              from public.order_items i left join order_link.item_ext e on e.order_item_id = i.id where i.order_id = o.id)
  ) from public.orders o where o.id = p_order_id
$$;

-- ============================================================================
-- MCP ツール: orders_search（読取）
-- ============================================================================
create or replace function order_link.api_orders_search(p_ctx jsonb, p_args jsonb)
returns jsonb language plpgsql volatile security definer set search_path = order_link, public, pg_temp as $$
declare
  v_p order_link.principals;
  v_limit int := least(greatest(coalesce((p_args->>'limit')::int, 50), 1), 100);
  v_ext text := nullif(btrim(p_args->>'external_order_id'), '');
  v_code text := nullif(btrim(p_args->>'order_code'), '');
  v_oid uuid := nullif(p_args->>'order_id', '')::uuid;
  v_cid uuid := nullif(p_args->>'customer_id', '')::uuid;
  v_cq text := nullif(btrim(p_args->>'customer_query'), '');
  v_pq text := nullif(btrim(p_args->>'product_query'), '');
  v_from date := nullif(p_args->>'date_from', '')::date;
  v_to date := nullif(p_args->>'date_to', '')::date;
  v_df text := coalesce(p_args->>'date_field', 'order_date');
  v_status text[];
  v_cur_ts timestamptz; v_cur_id uuid; v_cur text := nullif(p_args->>'cursor', '');
  v_total bigint; v_rows jsonb; v_next text; v_n int;
begin
  v_p := order_link.principal_for(p_ctx, 'orders:read');
  perform order_link.check_org_arg(p_args);
  if v_df not in ('order_date','delivery_date','created_at') then perform order_link.fail('TS422', 'invalid_date_field'); end if;
  if v_from is not null and v_to is not null and v_to < v_from then perform order_link.fail('TS422', 'date_range_inverted'); end if;
  if jsonb_typeof(p_args->'status') = 'array' then
    select array_agg(x) into v_status from jsonb_array_elements_text(p_args->'status') x;
    if exists (select 1 from unnest(v_status) s where s not in ('受注','確認済','発送済','納品完了','キャンセル','受付')) then
      perform order_link.fail('TS422', 'invalid_status');
    end if;
  end if;
  if v_cur is not null then
    begin
      v_cur_ts := split_part(convert_from(decode(v_cur, 'base64'), 'UTF8'), '|', 1)::timestamptz;
      v_cur_id := split_part(convert_from(decode(v_cur, 'base64'), 'UTF8'), '|', 2)::uuid;
    exception when others then perform order_link.fail('TS422', 'invalid_cursor'); end;
  end if;

  create temp table if not exists _ol_hits (id uuid, created_at timestamptz, basis text[]) on commit drop;
  truncate _ol_hits;
  insert into _ol_hits
  select o.id, o.created_at,
         array_remove(array[
           case when v_ext is not null then 'external_order_id' end,
           case when v_code is not null then 'order_code' end,
           case when v_oid is not null then 'order_id' end,
           case when v_cid is not null then 'customer_id' end,
           case when v_cq is not null then 'customer_query' end,
           case when v_pq is not null then 'product_query' end,
           case when v_from is not null or v_to is not null then v_df end,
           case when v_status is not null then 'status' end], null)
    from public.orders o
   where (v_ext is null or exists (select 1 from order_link.external_refs r where r.order_id = o.id and r.external_order_id = v_ext))
     and (v_code is null or o.order_code = v_code)
     and (v_oid is null or o.id = v_oid)
     and (v_cid is null or o.customer_id = v_cid)
     and (v_cq is null or o.customer_name ilike '%' || order_link.like_escape(v_cq) || '%'
          or exists (select 1 from public.customers c where c.id = o.customer_id
                      and (c.name ilike '%' || order_link.like_escape(v_cq) || '%'
                        or coalesce(c.company1, '') ilike '%' || order_link.like_escape(v_cq) || '%'
                        or coalesce(array_to_string(c.search_aliases, ' '), '') ilike '%' || order_link.like_escape(v_cq) || '%')))
     and (v_pq is null or exists (select 1 from public.order_items i where i.order_id = o.id
                      and (i.part_name ilike '%' || order_link.like_escape(v_pq) || '%'
                        or coalesce(i.product_name, '') ilike '%' || order_link.like_escape(v_pq) || '%'
                        or coalesce(i.species, '') ilike '%' || order_link.like_escape(v_pq) || '%')))
     and (v_from is null or (case v_df when 'delivery_date' then o.delivery_date
                                       when 'created_at' then (o.created_at at time zone 'Asia/Tokyo')::date
                                       else o.order_date end) >= v_from)
     and (v_to is null or (case v_df when 'delivery_date' then o.delivery_date
                                     when 'created_at' then (o.created_at at time zone 'Asia/Tokyo')::date
                                     else o.order_date end) <= v_to)
     and (v_status is null or o.status = any (v_status))
     and (v_p.customer_ids is null or o.customer_id = any (v_p.customer_ids));

  select count(*) into v_total from _ol_hits;
  select coalesce(jsonb_agg(order_link.order_brief(h.id) || jsonb_build_object('match_basis', to_jsonb(h.basis)) order by h.created_at desc, h.id desc), '[]'),
         count(*)
    into v_rows, v_n
    from (select * from _ol_hits
           where v_cur is null or (created_at, id) < (v_cur_ts, v_cur_id)
           order by created_at desc, id desc limit v_limit) h;
  if v_n = v_limit then
    select encode(convert_to(h.created_at::text || '|' || h.id::text, 'UTF8'), 'base64') into v_next
      from (select * from _ol_hits where v_cur is null or (created_at, id) < (v_cur_ts, v_cur_id)
             order by created_at desc, id desc offset v_limit - 1 limit 1) h
     where exists (select 1 from _ol_hits x where (x.created_at, x.id) < (h.created_at, h.id));
  end if;
  return jsonb_build_object('outcome', 'read', 'total_count', v_total, 'returned', v_n,
    'next_cursor', v_next, 'complete', v_next is null, 'orders', v_rows,
    'note', '検索は orders（正本）全件が対象。next_cursor がある間は続きがある（complete=false）');
exception
  when sqlstate 'TS401' then return jsonb_build_object('outcome', 'forbidden', 'reason', 'unauthenticated');
  when sqlstate 'TS403' then return jsonb_build_object('outcome', 'forbidden', 'reason', sqlerrm);
  when sqlstate 'TS422' then return jsonb_build_object('outcome', 'failed', 'reason', 'validation_error', 'detail', sqlerrm);
end $$;

-- ============================================================================
-- MCP ツール: orders_get（読取）
-- ============================================================================
create or replace function order_link.api_orders_get(p_ctx jsonb, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = order_link, public, pg_temp as $$
declare
  v_p order_link.principals; v_id uuid; o public.orders; v_ref order_link.external_refs;
begin
  v_p := order_link.principal_for(p_ctx, 'orders:read');
  perform order_link.check_org_arg(p_args);
  if p_args ? 'order_id' then v_id := (p_args->>'order_id')::uuid;
  elsif p_args ? 'order_code' then select id into v_id from public.orders where order_code = p_args->>'order_code';
  else perform order_link.fail('TS422', 'order_id_or_order_code_required'); end if;
  select * into o from public.orders where id = v_id;
  if not found then return jsonb_build_object('outcome', 'failed', 'reason', 'not_found'); end if;
  if not order_link.can_see_order(v_p, o.id) then perform order_link.fail('TS403', 'order_out_of_scope'); end if;
  select * into v_ref from order_link.external_refs where order_id = o.id;
  return jsonb_build_object(
    'outcome', 'read',
    'order', order_link.order_brief(o.id) - 'items',
    'delivery', jsonb_build_object('postal', o.delivery_postal, 'address', o.delivery_address, 'building', o.delivery_building,
                                   'name', o.delivery_name, 'phone', o.delivery_phone, 'time_zone', o.delivery_time_zone, 'carrier', o.carrier),
    'memo', o.memo, 'notes', o.notes,
    'items', (select coalesce(jsonb_agg(jsonb_build_object(
                'order_item_id', i.id, 'species', i.species, 'part_name', i.part_name, 'product_name', i.product_name,
                'grade', i.grade_snapshot, 'requested_kg', i.requested_kg, 'allocated_kg', i.allocated_kg, 'weight_kg', i.weight_kg,
                'unit_price', i.unit_price, 'amount', coalesce(i.amount, i.subtotal),
                'source_line', case when e.order_item_id is null then null else jsonb_build_object(
                   'line_no', e.line_no, 'raw_text', e.raw_text, 'product_text', e.product_text, 'raw_qty_text', e.raw_qty_text,
                   'qty', e.qty, 'unit', e.unit, 'normalized_kg', e.normalized_kg, 'temp_zone', e.temp_zone, 'temp_text', e.temp_text,
                   'wish_text', e.wish_text, 'review_items', to_jsonb(e.review_items), 'confirm_state', e.confirm_state) end)
              order by e.line_no nulls last, i.created_at, i.id), '[]')
              from public.order_items i left join order_link.item_ext e on e.order_item_id = i.id where i.order_id = o.id),
    'review', case when v_ref.id is null then null else jsonb_build_object(
                'state', v_ref.review_state, 'revision', v_ref.revision, 'reviewed_at', v_ref.reviewed_at,
                'unresolved', (select coalesce(jsonb_agg(jsonb_build_object('line_no', e.line_no, 'items', to_jsonb(e.review_items)) order by e.line_no), '[]')
                                 from order_link.item_ext e where e.ref_id = v_ref.id and e.confirm_state = 'needs_review')) end,
    'sources', (select coalesce(jsonb_agg(jsonb_build_object('source_id', s.id, 'provider', s.provider, 'account', s.account,
                   'message_id', s.message_id, 'thread_id', s.thread_id, 'attachment_id', nullif(s.attachment_id, ''),
                   'filename', s.filename, 'sha256', s.sha256, 'pages', to_jsonb(s.pages), 'received_at', s.received_at,
                   'link', s.link, 'role', rs.role) order by s.received_at), '[]')
                from order_link.ref_sources rs join order_link.sources s on s.id = rs.source_id where rs.ref_id = v_ref.id),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('tool', r.tool, 'outcome', r.outcome, 'at', r.created_at,
                   'by', coalesce(pr.display_name, r.actor), 'user_request', r.user_request) order by r.created_at), '[]')
                from order_link.runs r left join order_link.principals pr on pr.id = r.principal_id
               where r.order_id = o.id and r.outcome <> 'read'),
    'shipments_detail', (select coalesce(jsonb_agg(jsonb_build_object('shipment_date', s.shipment_date, 'status', s.status,
                   'carrier', s.carrier, 'freight', s.freight) order by s.shipment_date), '[]') from public.shipments s where s.order_id = o.id),
    'documents', (select coalesce(jsonb_agg(jsonb_build_object('doc_type', d.doc_type, 'doc_number', d.doc_number, 'status', d.status,
                   'billing_status', d.billing_status, 'issue_date', d.issue_date) order by d.issue_date), '[]')
                  from public.documents d
                 where d.order_id = o.id or exists (select 1 from public.document_orders x where x.document_id = d.id and x.order_id = o.id)),
    'allocations', (select jsonb_build_object('count', count(*), 'kg', coalesce(sum(a.weight_kg), 0))
                    from public.inventory_allocations a join public.order_items i on i.id = a.order_item_id where i.order_id = o.id),
    'version', md5(coalesce(o.updated_at::text, '') || '|' || coalesce(v_ref.revision::text, '') || '|' || coalesce(v_ref.review_state, '')),
    'verified_at', now()
  );
exception
  when sqlstate 'TS401' then return jsonb_build_object('outcome', 'forbidden', 'reason', 'unauthenticated');
  when sqlstate 'TS403' then return jsonb_build_object('outcome', 'forbidden', 'reason', sqlerrm);
  when sqlstate 'TS422' or invalid_text_representation then return jsonb_build_object('outcome', 'failed', 'reason', 'validation_error', 'detail', sqlerrm);
end $$;

-- ============================================================================
-- 取込: 内容の正規化と照合（preview の中身。書込みはしない）
-- ============================================================================
-- 戻り値: { payload（正規化済み）, checks（顧客・商品・重複・止める理由・確認事項・警告）, identity }
create or replace function order_link.evaluate(v_p order_link.principals, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = order_link, public, pg_temp as $$
declare
  v_org text := order_link.setting('org_key') #>> '{}';
  v_issuer text := lower(btrim(p_args->>'issuer_account'));
  v_channel text := p_args->>'channel';
  v_ext_status text := p_args->>'external_order_id_status';
  v_ext text := nullif(btrim(p_args->>'external_order_id'), '');
  v_res jsonb := coalesce(p_args->'resolutions', '{}');
  v_blockers jsonb := '[]'; v_review jsonb := '[]'; v_warn jsonb := '[]';
  v_items jsonb := '[]'; it jsonb; v_line jsonb; v_lr jsonb;
  v_unit text; v_qty numeric; v_kg numeric; v_species text; v_part text; v_grade text; v_match text; v_ritems text[];
  v_cust jsonb; v_cust_id uuid; v_cust_cands jsonb; v_store text; v_n int;
  v_src jsonb; v_first_order_src jsonb; v_source_key text;
  v_ref order_link.external_refs; v_dups jsonb := '[]'; v_content jsonb; v_content_digest text;
  v_ref_date date; v_parts text[]; v_tz text;
  v_known_species text[] := array(select distinct species from public.price_master);
begin
  -- 外部注文ID: PDF に番号があるのに読めないものは登録に進めない。番号が無い注文は捏造しない
  if v_ext_status = 'present' and v_ext is null then
    v_blockers := v_blockers || jsonb_build_object('code', 'external_order_id_missing', 'message', '外部注文IDが「あり」なのに値がありません');
  elsif v_ext_status = 'unreadable' then
    v_blockers := v_blockers || jsonb_build_object('code', 'external_order_id_unreadable', 'message', '注文書の注文番号が読めません。原本を確認してください');
    v_ext := null;
  elsif v_ext_status = 'absent' then
    v_ext := null;
  end if;

  -- 出典: 番号が無い注文は「確認済み出典（注文として指定された最初の出典）＋書類内の順番」を識別子にする
  for v_src in select * from jsonb_array_elements(p_args->'sources') loop
    if coalesce(v_src->>'role', 'order') = 'order' and v_first_order_src is null then v_first_order_src := v_src; end if;
  end loop;
  if v_first_order_src is null then
    v_blockers := v_blockers || jsonb_build_object('code', 'no_order_source', 'message', '注文そのものの出典（role=order）がありません');
  end if;
  if nullif(p_args->>'source_key_override', '') is not null then
    v_source_key := p_args->>'source_key_override';   -- commit 時の再照合: 候補に保存した識別子をそのまま使う
  elsif v_ext is null and v_ext_status = 'absent' and v_first_order_src is not null then
    v_source_key := concat_ws(':', v_first_order_src->>'provider', lower(v_first_order_src->>'account'), v_first_order_src->>'message_id',
                              coalesce(v_first_order_src->>'attachment_id', ''), '#' || coalesce(p_args->>'source_order_index', '1'));
  end if;
  if coalesce(p_args->>'intent', 'new') <> 'new' then
    v_blockers := v_blockers || jsonb_build_object('code', 'change_or_cancel_detected',
      'message', '変更・取消の依頼です。初期版は自動で反映しません。元の注文と出荷・請求の状態を示して確認してください');
  end if;

  -- 顧客の照合（店舗名・法人名・請求先・納品先・仲介元を分けて扱う。仲介元のメールを顧客のメールにしない）
  v_store := btrim(coalesce(p_args#>>'{customer,store_name}', ''));
  if v_res ? 'customer_id' then
    select jsonb_build_object('customer_id', c.id, 'code', c.code, 'name', c.name, 'price_rank', c.price_rank) into v_cust
      from public.customers c where c.id = (v_res->>'customer_id')::uuid and c.is_active is not false;
    if v_cust is null then
      v_blockers := v_blockers || jsonb_build_object('code', 'customer_not_found', 'message', '指定された顧客IDが顧客台帳にありません');
    else
      v_cust := v_cust || jsonb_build_object('match', 'confirmed_by_user');
    end if;
  else
    select coalesce(jsonb_agg(jsonb_build_object('customer_id', c.id, 'code', c.code, 'name', c.name, 'company1', c.company1,
             'basis', case when c.name = v_store then 'name_exact'
                           when order_link.norm(c.name) = order_link.norm(v_store) then 'name_normalized'
                           when order_link.norm(v_store) = any (select order_link.norm(a) from unnest(coalesce(c.search_aliases, '{}')) a) then 'alias'
                           else 'company' end)), '[]'), count(*)
      into v_cust_cands, v_n
      from public.customers c
     where c.is_active is not false and v_store <> ''
       and (order_link.norm(c.name) = order_link.norm(v_store)
            or order_link.norm(v_store) = any (select order_link.norm(a) from unnest(coalesce(c.search_aliases, '{}')) a)
            or (nullif(btrim(coalesce(p_args#>>'{customer,corporate_name}', '')), '') is not null
                and order_link.norm(c.company1) = order_link.norm(p_args#>>'{customer,corporate_name}')));
    if v_n = 1 then
      v_cust := (v_cust_cands->0) || jsonb_build_object('match', 'unique');
      select jsonb_set(v_cust, '{price_rank}', to_jsonb(c.price_rank)) into v_cust from public.customers c where c.id = (v_cust->>'customer_id')::uuid;
    else
      v_blockers := v_blockers || jsonb_build_object('code', case when v_n = 0 then 'customer_not_found' else 'customer_ambiguous' end,
        'message', case when v_n = 0 then '顧客台帳に一致する店舗がありません。既存の画面で顧客登録するか、正しい顧客を指定してください'
                        else '同名・類似の顧客が複数あります。どの店舗か確認してください' end,
        'candidates', v_cust_cands);
    end if;
  end if;
  v_cust_id := (v_cust->>'customer_id')::uuid;
  if nullif(btrim(coalesce(p_args#>>'{customer,broker}', '')), '') is not null
     and (p_args#>>'{customer,broker}') not in ('トレタテ', 'ノブレスオブリージュ') then
    v_review := v_review || jsonb_build_object('code', 'broker_unknown', 'message', '仲介元が既知（トレタテ・ノブレスオブリージュ）以外です。請求先を確認してください');
  end if;

  -- 明細
  for it in select * from jsonb_array_elements(p_args->'items') order by (value->>'line_no')::int loop
    v_unit := it->>'unit'; v_qty := (it->>'qty')::numeric; v_ritems := '{}';
    v_kg := case v_unit when 'kg' then v_qty when 'g' then round(v_qty / 1000.0, 6) else null end;
    v_lr := (select x from jsonb_array_elements(coalesce(v_res->'items', '[]')) x where (x->>'line_no')::int = (it->>'line_no')::int limit 1);
    v_species := coalesce(v_lr->>'species', it->>'species');
    v_part := coalesce(v_lr->>'part_name', it->>'part_name');
    v_grade := coalesce(v_lr->>'grade', it->>'grade');
    v_match := null;
    -- 確定済みの対応表
    if v_lr is null then
      select a.species, a.part_name, coalesce(v_grade, a.grade), 'confirmed_alias' into v_species, v_part, v_grade, v_match
        from order_link.product_aliases a
       where a.org_key = v_org and a.issuer_account in (v_issuer, '*') and a.product_text = order_link.norm(it->>'product_text')
       order by (a.issuer_account = '*') limit 1;
      if v_match is null then
        v_species := it->>'species'; v_part := it->>'part_name'; v_grade := it->>'grade';
      end if;
    end if;
    if v_match is null then
      if v_species is null or v_part is null or not (v_species = any (v_known_species))
         or not exists (select 1 from public.price_master pm where pm.species = v_species
                         and (pm.part_name = v_part or order_link.base_part(pm.part_name) = v_part)) then
        v_match := 'unresolved';
      elsif v_lr is not null and coalesce((v_lr->>'confirmed')::boolean, false) then
        v_match := 'confirmed_by_user';
      elsif order_link.norm(it->>'product_text') in (
                order_link.norm(v_part), order_link.norm(order_link.base_part(v_part)),
                order_link.norm(v_species || v_part), order_link.norm(v_species || order_link.base_part(v_part)),
                order_link.norm(replace(replace(v_species, 'イノシシ', '猪'), 'シカ', '鹿') || v_part),
                order_link.norm(replace(replace(v_species, 'イノシシ', '猪'), 'シカ', '鹿') || order_link.base_part(v_part))) then
        v_match := 'exact';
      else
        v_match := 'proposed';   -- 名称が違う（例: 「肩」→カタ）。人が確認するまで登録しない
      end if;
    end if;
    -- 正式な部位名（価格マスタの表記）に揃える
    if v_match <> 'unresolved' then
      select pm.part_name into v_part from public.price_master pm
       where pm.species = v_species and (pm.part_name = v_part or order_link.base_part(pm.part_name) = v_part)
       order by (pm.part_name = v_part) desc limit 1;
      if v_grade is not null and not exists (select 1 from public.price_master pm where pm.species = v_species and pm.part_name = v_part and pm.grade = v_grade) then
        v_blockers := v_blockers || jsonb_build_object('code', 'grade_unknown', 'line_no', (it->>'line_no')::int,
          'message', format('等級「%s」は価格マスタの %s %s にありません', v_grade, v_species, v_part));
      end if;
    end if;
    if v_match = 'unresolved' then
      v_blockers := v_blockers || jsonb_build_object('code', 'product_unresolved', 'line_no', (it->>'line_no')::int,
        'message', format('「%s」を価格マスタの種・部位に対応づけられません', it->>'product_text'));
    elsif v_match = 'proposed' then
      v_blockers := v_blockers || jsonb_build_object('code', 'product_mapping_unconfirmed', 'line_no', (it->>'line_no')::int,
        'message', format('「%s」→ %s %s の対応を確認してください', it->>'product_text', v_species, v_part));
    end if;
    if v_grade is null and v_match <> 'unresolved' then
      v_warn := v_warn || jsonb_build_object('code', 'grade_unspecified', 'line_no', (it->>'line_no')::int, 'message', '等級の指定なし（出荷時に決まる）');
    end if;
    -- 温度帯: 記載なしから冷凍を推定しない。「フレッシュ」が冷蔵か等は確認する
    v_tz := coalesce(v_lr->>'temp_zone', it->>'temp_zone');
    if v_tz = 'unknown' then v_ritems := array_append(v_ritems, 'temp_zone_unknown'); end if;
    if v_tz = 'fresh' then v_ritems := array_append(v_ritems, 'fresh_meaning_unconfirmed'); end if;
    if v_unit = '頭' then v_ritems := array_append(v_ritems, 'whole_carcass_count'); end if;
    if v_kg is null then
      v_warn := v_warn || jsonb_build_object('code', 'weight_undetermined', 'line_no', (it->>'line_no')::int,
        'message', format('%s%s の注文。重量・金額は出荷時の実重量で決まる（kg・円は入れない）', it->>'qty', v_unit));
    end if;
    v_items := v_items || jsonb_build_object(
      'line_no', (it->>'line_no')::int, 'raw_text', it->>'raw_text', 'product_text', it->>'product_text',
      'raw_qty_text', it->>'raw_qty_text', 'qty', v_qty, 'unit', v_unit, 'normalized_kg', v_kg,
      'species', v_species, 'part_name', v_part, 'grade', v_grade, 'product_match', v_match,
      'remember_alias', coalesce((v_lr->>'remember_alias')::boolean, false) and v_match = 'confirmed_by_user',
      'temp_zone', v_tz, 'temp_text', it->>'temp_text', 'wish_text', it->>'wish_text',
      'review_items', to_jsonb(v_ritems));
    if array_length(v_ritems, 1) > 0 then
      v_review := v_review || jsonb_build_object('code', 'line_needs_review', 'line_no', (it->>'line_no')::int, 'items', to_jsonb(v_ritems));
    end if;
  end loop;

  if nullif(p_args#>>'{delivery,requested_date}', '') is null then
    v_warn := v_warn || jsonb_build_object('code', 'delivery_date_blank', 'message', '納品希望日の記載なし（null で保存。日付を補わない）');
  end if;

  -- 業務内容のダイジェスト（出典・メールの違いを含めない。同じ注文の再送・転送は同じ値になる）
  v_content := jsonb_build_object('customer_id', v_cust_id,
    'requested_date', nullif(p_args#>>'{delivery,requested_date}', ''), 'requested_text', p_args#>>'{delivery,requested_text}',
    'items', (select jsonb_agg(jsonb_build_object('line_no', x->'line_no', 'species', x->'species', 'part_name', x->'part_name',
                'grade', x->'grade', 'qty', x->'qty', 'unit', x->'unit', 'temp_zone', x->'temp_zone') order by (x->>'line_no')::int)
              from jsonb_array_elements(v_items) x));
  v_content_digest := order_link.sha256_hex(v_content);

  -- 重複 2段目: 組織＋経路＋発行元＋外部注文ID（番号が無ければ確認済み出典）
  select * into v_ref from order_link.external_refs r
   where r.org_key = v_org
     and ((v_ext is not null and r.channel = v_channel and r.issuer_account = v_issuer and r.external_order_id = v_ext)
       or (v_ext is null and v_source_key is not null and r.external_order_id is null and r.source_key = v_source_key));

  -- 重複 3段目: 外部IDの無い既存の手入力・直接出荷・BASE 等（自動で結合せず確認に回す）
  if v_ref.id is null and v_cust_id is not null then
    v_ref_date := coalesce(nullif(p_args->>'order_date', '')::date, ((p_args->>'received_at')::timestamptz at time zone 'Asia/Tokyo')::date);
    v_parts := array(select x->>'part_name' from jsonb_array_elements(v_items) x where x->>'part_name' is not null);
    select coalesce(jsonb_agg(order_link.order_brief(o.id) || jsonb_build_object('match_basis',
             jsonb_build_array('same_customer', 'date_within_14_days') ||
             case when exists (select 1 from public.order_items i where i.order_id = o.id and order_link.base_part(i.part_name) = any (select order_link.base_part(p) from unnest(v_parts) p))
                  then '["same_part"]'::jsonb else '[]'::jsonb end) order by o.created_at desc), '[]')
      into v_dups
      from public.orders o
     where o.customer_id = v_cust_id
       and coalesce(o.order_date, (o.created_at at time zone 'Asia/Tokyo')::date) between v_ref_date - 14 and v_ref_date + 14
       and exists (select 1 from public.order_items i where i.order_id = o.id
                    and order_link.base_part(i.part_name) = any (select order_link.base_part(p) from unnest(v_parts) p))
       -- 同じ経路・発行元で「別の外部ID」と確定している注文は別注文
       and not exists (select 1 from order_link.external_refs r where r.order_id = o.id and r.channel = v_channel
                        and r.issuer_account = v_issuer and r.external_order_id is not null and r.external_order_id <> coalesce(v_ext, ''));
    if jsonb_array_length(v_dups) > 0 then
      if v_res ? 'duplicate_of' then
        if not exists (select 1 from jsonb_array_elements(v_dups) d where d->>'order_id' = v_res->>'duplicate_of') then
          v_blockers := v_blockers || jsonb_build_object('code', 'duplicate_of_not_in_candidates', 'message', '指定の既存注文は照合候補にありません');
        end if;
      elsif exists (select 1 from jsonb_array_elements(v_dups) d
                     where not coalesce((v_res->'not_duplicate_of') ? (d->>'order_id'), false)) then
        v_blockers := v_blockers || jsonb_build_object('code', 'possible_duplicate',
          'message', '同じ顧客・近い日付・同じ部位の既存注文があります。同じ注文か別の注文か確認してください（自動で結合しません）');
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'identity', jsonb_build_object('org_key', v_org, 'channel', v_channel, 'issuer_account', v_issuer,
                                   'external_order_id', v_ext, 'source_key', v_source_key),
    'payload', jsonb_build_object(
       'organization', v_org, 'channel', v_channel, 'issuer_account', v_issuer,
       'external_order_id', v_ext, 'external_order_id_status', v_ext_status, 'source_key', v_source_key,
       'intent', coalesce(p_args->>'intent', 'new'),
       'order_date', nullif(p_args->>'order_date', ''), 'received_at', p_args->>'received_at',
       'customer_input', p_args->'customer', 'customer', v_cust,
       'delivery', coalesce(p_args->'delivery', '{}'), 'notes_text', p_args->>'notes_text',
       'items', v_items, 'resolutions', v_res),
    'content', v_content, 'content_digest', v_content_digest,
    'existing_ref', case when v_ref.id is null then null else jsonb_build_object('ref_id', v_ref.id, 'order_id', v_ref.order_id,
                       'content_digest', v_ref.content_digest, 'review_state', v_ref.review_state) end,
    'checks', jsonb_build_object('blockers', v_blockers, 'review_items', v_review, 'warnings', v_warn,
                                 'customer_candidates', coalesce(v_cust_cands, '[]'), 'possible_duplicates', v_dups));
end $$;

-- 出典を登録（同じメール・添付は再利用）。同じファイル（SHA-256）が別のメールにもあれば知らせる
create or replace function order_link.upsert_sources(v_p order_link.principals, p_sources jsonb)
returns jsonb language plpgsql security definer set search_path = order_link, public, pg_temp as $$
declare s jsonb; v_id uuid; v_out jsonb := '[]'; v_same jsonb;
begin
  for s in select * from jsonb_array_elements(p_sources) loop
    insert into order_link.sources(provider, account, message_id, thread_id, attachment_id, filename, sha256, pages, received_at, link, created_by)
    values (s->>'provider', lower(s->>'account'), s->>'message_id', s->>'thread_id', coalesce(s->>'attachment_id', ''), s->>'filename',
            lower(s->>'sha256'), case when jsonb_typeof(s->'pages') = 'array' then array(select (x)::int from jsonb_array_elements_text(s->'pages') x) end,
            nullif(s->>'received_at', '')::timestamptz, s->>'link', v_p.id)
    on conflict (provider, account, message_id, attachment_id) do update
      set sha256 = coalesce(order_link.sources.sha256, excluded.sha256)
    returning id into v_id;
    select coalesce(jsonb_agg(jsonb_build_object('source_id', x.id, 'message_id', x.message_id, 'filename', x.filename)), '[]') into v_same
      from order_link.sources x where x.sha256 = lower(s->>'sha256') and x.id <> v_id;
    v_out := v_out || jsonb_build_object('source_id', v_id, 'role', coalesce(s->>'role', 'order'), 'same_file_elsewhere', v_same);
  end loop;
  return v_out;
end $$;

-- ============================================================================
-- MCP ツール: order_import_preview（取込候補の保存と検証。orders/order_items は変更しない）
-- ============================================================================
create or replace function order_link.api_import_preview(p_ctx jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = order_link, public, pg_temp as $$
declare
  v_p order_link.principals; v_ev jsonb; v_payload jsonb; v_digest text; v_checks jsonb; v_srcs jsonb;
  v_c order_link.candidates; v_state text; v_outcome text; v_id jsonb; v_existing jsonb; s jsonb; v_reused boolean := false;
begin
  v_p := order_link.principal_for(p_ctx, 'orders:import');
  perform order_link.check_org_arg(p_args);
  if (order_link.setting('writes_paused'))::boolean then perform order_link.fail('TS403', 'writes_paused'); end if;

  v_ev := order_link.evaluate(v_p, p_args);
  v_payload := v_ev->'payload'; v_checks := v_ev->'checks'; v_id := v_ev->'identity';
  v_existing := nullif(v_ev->'existing_ref', 'null'::jsonb);
  v_digest := order_link.sha256_hex(v_payload);
  v_srcs := order_link.upsert_sources(v_p, p_args->'sources');

  -- 既に登録済みの注文と同じ（2段目）: 同じ内容なら no-op、出典だけ結び付ける。内容が違えば変更候補
  if v_existing is not null then
    if v_existing->>'content_digest' = v_ev->>'content_digest' then
      for s in select * from jsonb_array_elements(v_srcs) loop
        insert into order_link.ref_sources(ref_id, source_id, role) values ((v_existing->>'ref_id')::uuid, (s->>'source_id')::uuid, s->>'role')
        on conflict do nothing;
      end loop;
      insert into order_link.runs(request_id, principal_id, tool, outcome, order_id, user_request, detail)
      values (p_ctx->>'request_id', v_p.id, 'order_import_preview', 'already_exists', (v_existing->>'order_id')::uuid,
              left(p_args->>'user_request', 300), jsonb_build_object('reason', 'same_external_order_same_content'));
      return jsonb_build_object('outcome', 'already_exists', 'stage', 'already_registered', 'registered_now', false,
        'order', order_link.order_brief((v_existing->>'order_id')::uuid),
        'message', '同じ外部注文が同じ内容で登録済みです（再送・転送）。新しい注文は作りません。出典だけ結び付けました',
        'sources', v_srcs, 'warnings', v_checks->'warnings');
    end if;
    v_checks := jsonb_set(v_checks, '{blockers}', (v_checks->'blockers') || jsonb_build_object('code', 'changed_version',
      'message', '同じ外部注文IDの注文が別の内容で登録済みです（変更候補）。上書きしません。差分と原本を確認してください',
      'existing_order', order_link.order_brief((v_existing->>'order_id')::uuid)));
  end if;

  -- 既存の候補を改訂する（candidate_id 指定時は版を必ず照合）
  if p_args ? 'candidate_id' then
    select * into v_c from order_link.candidates where id = (p_args->>'candidate_id')::uuid for update;
    if not found then perform order_link.fail('TS422', 'candidate_not_found'); end if;
    if v_c.principal_id <> v_p.id then perform order_link.fail('TS403', 'candidate_owned_by_other'); end if;
    if v_c.version <> coalesce((p_args->>'expected_version')::int, -1) then
      return jsonb_build_object('outcome', 'conflict', 'reason', 'stale_candidate_version', 'candidate_id', v_c.id, 'version', v_c.version,
                                'message', '候補が別の操作で更新されています。最新版を取り直してください');
    end if;
    if v_c.state = 'committed' then
      return jsonb_build_object('outcome', 'already_exists', 'candidate_id', v_c.id, 'order', order_link.order_brief(v_c.committed_order_id));
    end if;
    if (v_c.external_order_id is distinct from v_id->>'external_order_id') or (v_c.source_key is distinct from v_id->>'source_key')
       or v_c.channel <> v_id->>'channel' or v_c.issuer_account <> v_id->>'issuer_account' then
      return jsonb_build_object('outcome', 'conflict', 'reason', 'identity_changed', 'candidate_id', v_c.id,
                                'message', '外部注文ID・経路・発行元が候補と違います。別の注文として新しい候補にしてください');
    end if;
  else
    -- 同じ業務注文の開いている候補があれば再利用（1段目: 同じメール・添付の再処理で候補を増やさない）
    select * into v_c from order_link.candidates c
     where c.org_key = v_id->>'org_key' and c.state in ('previewed','blocked')
       and ((v_id->>'external_order_id' is not null and c.channel = v_id->>'channel' and c.issuer_account = v_id->>'issuer_account'
             and c.external_order_id = v_id->>'external_order_id')
         or (v_id->>'external_order_id' is null and c.external_order_id is null and c.source_key = v_id->>'source_key'))
     for update;
    if found and v_c.principal_id <> v_p.id then perform order_link.fail('TS403', 'candidate_owned_by_other'); end if;
  end if;

  v_state := case when jsonb_array_length(v_checks->'blockers') > 0 then 'blocked' else 'previewed' end;
  if v_c.id is null then
    begin
      insert into order_link.candidates(principal_id, org_key, channel, issuer_account, external_order_id, source_key, digest, content_digest, payload, checks, state)
      values (v_p.id, v_id->>'org_key', v_id->>'channel', v_id->>'issuer_account', v_id->>'external_order_id', v_id->>'source_key',
              v_digest, v_ev->>'content_digest', v_payload, v_checks, v_state)
      returning * into v_c;
    exception when unique_violation then
      -- 並行 preview: 先に入った候補を返す（増やさない）
      return jsonb_build_object('outcome', 'conflict', 'reason', 'concurrent_preview', 'message', '同じ注文の候補が同時に作られました。もう一度 preview してください');
    end;
  elsif v_c.digest = v_digest then
    v_reused := true;
    update order_link.candidates set checks = v_checks, state = v_state, updated_at = now() where id = v_c.id returning * into v_c;
  else
    update order_link.candidates set version = version + 1, digest = v_digest, content_digest = v_ev->>'content_digest',
           payload = v_payload, checks = v_checks, state = v_state, updated_at = now()
     where id = v_c.id returning * into v_c;
  end if;
  for s in select * from jsonb_array_elements(v_srcs) loop
    insert into order_link.candidate_sources(candidate_id, source_id, role) values (v_c.id, (s->>'source_id')::uuid, s->>'role') on conflict do nothing;
  end loop;

  v_outcome := case when v_existing is not null then 'conflict' when v_state = 'blocked' then 'needs_review' else 'created' end;
  insert into order_link.runs(request_id, principal_id, tool, candidate_id, candidate_version, digest, outcome, user_request, detail)
  values (p_ctx->>'request_id', v_p.id, 'order_import_preview', v_c.id, v_c.version, v_c.digest, v_outcome, left(p_args->>'user_request', 300),
          jsonb_build_object('blockers', (select coalesce(jsonb_agg(b->>'code'), '[]') from jsonb_array_elements(v_checks->'blockers') b),
                             'items', jsonb_array_length(v_payload->'items')));

  return jsonb_build_object(
    'outcome', v_outcome, 'stage', 'candidate_saved', 'registered', false,
    'candidate_id', v_c.id, 'version', v_c.version, 'digest', v_c.digest, 'reused', v_reused,
    'commit_ready', v_state = 'previewed',
    'external_order_id', v_c.external_order_id,
    'customer', v_payload->'customer',
    'items', v_payload->'items',
    'blockers', v_checks->'blockers', 'review_items', v_checks->'review_items', 'warnings', v_checks->'warnings',
    'customer_candidates', v_checks->'customer_candidates', 'possible_duplicates', v_checks->'possible_duplicates',
    'sources', v_srcs,
    'will_be_saved_as', case when v_state = 'previewed' then jsonb_build_object(
        'orders', jsonb_build_object('status', '受注', 'channel', 'メール', 'customer_id', v_payload#>'{customer,customer_id}',
                                     'delivery_date', v_payload#>'{delivery,requested_date}', 'total_amount', null),
        'review_state', case when jsonb_array_length(v_checks->'review_items') > 0 then 'needs_review' else 'confirmed' end,
        'not_done', jsonb_build_array('在庫の確保', '納期・価格の確約', '出荷指示', '請求書の発行')) end,
    'message', case when v_state = 'previewed' then '取込候補を保存しました（受注正本には未登録）。内容をユーザーに確認してから commit してください'
                    else '取込候補を保存しましたが、登録の前に確認が必要です（blockers）' end);
exception
  when sqlstate 'TS401' then return jsonb_build_object('outcome', 'forbidden', 'reason', 'unauthenticated');
  when sqlstate 'TS403' then return jsonb_build_object('outcome', 'forbidden', 'reason', sqlerrm);
  when sqlstate 'TS422' or invalid_text_representation or invalid_datetime_format or datetime_field_overflow or check_violation
    then return jsonb_build_object('outcome', 'failed', 'reason', 'validation_error', 'detail', sqlerrm);
end $$;

-- ============================================================================
-- MCP ツール: order_import_commit（登録。ヘッダー・明細・外部参照・明細補助・監査を1トランザクションで）
-- ============================================================================
create or replace function order_link.api_import_commit(p_ctx jsonb, p_args jsonb)
returns jsonb language plpgsql security definer set search_path = order_link, public, pg_temp as $$
declare
  v_p order_link.principals; v_c order_link.candidates; v_run order_link.runs; v_ev jsonb; v_pl jsonb;
  v_key text := p_args->>'idempotency_key'; v_ver int := (p_args->>'candidate_version')::int; v_dig text := p_args->>'digest';
  v_cand uuid := (p_args->>'candidate_id')::uuid;
  v_order_id uuid; v_code text; v_ref_id uuid; it jsonb; v_item_id uuid; v_review boolean; v_cust public.customers;
  v_notes text; v_memo text; v_dup uuid; v_state text; v_sqlstate text; v_constraint text;
begin
  v_p := order_link.principal_for(p_ctx, 'orders:import');
  perform order_link.check_org_arg(p_args);
  if (order_link.setting('writes_paused'))::boolean then perform order_link.fail('TS403', 'writes_paused'); end if;
  if v_key is null or v_key !~ '^[A-Za-z0-9._:-]{8,128}$' then perform order_link.fail('TS422', 'invalid_idempotency_key'); end if;
  if coalesce((p_args->>'confirmed_by_user')::boolean, false) is not true then perform order_link.fail('TS422', 'user_confirmation_required'); end if;

  -- 同じ冪等キーの再送: 同じ候補・版・ダイジェストなら前回の結果、違えば conflict
  select * into v_run from order_link.runs where principal_id = v_p.id and idempotency_key = v_key and tool = 'order_import_commit'
     and outcome not in ('failed', 'forbidden');
  if found then
    if v_run.candidate_id = v_cand and v_run.candidate_version = v_ver and v_run.digest = v_dig then
      return jsonb_build_object('outcome', case when v_run.outcome in ('created', 'already_exists') then 'already_exists' else v_run.outcome end,
        'replayed', true, 'previous_outcome', v_run.outcome, 'registered', false,
        'order', case when v_run.order_id is null then null else order_link.order_brief(v_run.order_id) end, 'candidate_id', v_cand);
    end if;
    return jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused_with_different_content',
                              'message', '同じ冪等キーで別の内容が送られました。上書きしません');
  end if;

  select * into v_c from order_link.candidates where id = v_cand for update;
  if not found then perform order_link.fail('TS422', 'candidate_not_found'); end if;
  if v_c.principal_id <> v_p.id then perform order_link.fail('TS403', 'candidate_owned_by_other'); end if;
  if v_c.state = 'committed' then
    return jsonb_build_object('outcome', 'already_exists', 'candidate_id', v_c.id, 'order', order_link.order_brief(v_c.committed_order_id),
                              'message', 'この候補は登録済みです。新しい注文は作りません');
  end if;
  if v_c.version <> v_ver or v_c.digest <> v_dig then
    return jsonb_build_object('outcome', 'conflict', 'reason', 'stale_candidate_version', 'candidate_id', v_c.id,
                              'current_version', v_c.version, 'message', '候補の版または内容が変わっています。preview を取り直してください');
  end if;

  -- 登録直前に照合をやり直す（preview 後に他経路で登録・変更された可能性）
  v_ev := order_link.evaluate(v_p, (v_c.payload - 'customer' - 'items') || jsonb_build_object(
            'customer', v_c.payload->'customer_input', 'resolutions', v_c.payload->'resolutions',
            'sources', (select jsonb_agg(jsonb_build_object('provider', s.provider, 'account', s.account, 'message_id', s.message_id,
                          'attachment_id', s.attachment_id, 'role', cs.role) order by cs.role = 'order' desc, s.received_at)
                        from order_link.candidate_sources cs join order_link.sources s on s.id = cs.source_id where cs.candidate_id = v_c.id),
            'source_key_override', v_c.source_key,
            'items', (select jsonb_agg(x - 'species' - 'part_name' - 'grade' - 'product_match' - 'normalized_kg' - 'review_items' - 'remember_alias'
                         || jsonb_build_object('species', x->'species', 'part_name', x->'part_name', 'grade', x->'grade'))
                      from jsonb_array_elements(v_c.payload->'items') x)));
  if jsonb_typeof(v_ev->'existing_ref') = 'object' then
    if v_ev#>>'{existing_ref,content_digest}' = v_c.content_digest then
      return jsonb_build_object('outcome', 'already_exists', 'order', order_link.order_brief((v_ev#>>'{existing_ref,order_id}')::uuid),
                                'message', '同じ外部注文が既に登録されています（別の取込で登録済み）');
    end if;
    return jsonb_build_object('outcome', 'conflict', 'reason', 'changed_version', 'order', order_link.order_brief((v_ev#>>'{existing_ref,order_id}')::uuid),
                              'message', '同じ外部注文IDで内容の違う注文が登録済みです。上書きしません');
  end if;
  if jsonb_array_length(v_ev#>'{checks,blockers}') > 0 or v_ev->>'content_digest' <> v_c.content_digest then
    update order_link.candidates set state = 'blocked', checks = v_ev->'checks', updated_at = now() where id = v_c.id;
    insert into order_link.runs(request_id, principal_id, tool, idempotency_key, candidate_id, candidate_version, digest, outcome, user_request, detail)
    values (p_ctx->>'request_id', v_p.id, 'order_import_commit', v_key, v_c.id, v_c.version, v_c.digest, 'needs_review', left(p_args->>'user_request', 300),
            jsonb_build_object('blockers', (select coalesce(jsonb_agg(b->>'code'), '[]') from jsonb_array_elements(v_ev#>'{checks,blockers}') b)));
    return jsonb_build_object('outcome', 'needs_review', 'registered', false, 'candidate_id', v_c.id,
                              'blockers', v_ev#>'{checks,blockers}', 'message', '確認が済んでいない項目があるため登録していません');
  end if;

  v_pl := v_c.payload;
  v_dup := nullif(v_pl#>>'{resolutions,duplicate_of}', '')::uuid;
  v_review := exists (select 1 from jsonb_array_elements(v_pl->'items') x where jsonb_array_length(x->'review_items') > 0)
              or exists (select 1 from jsonb_array_elements(v_ev#>'{checks,review_items}') r where r->>'code' <> 'line_needs_review');

  begin  -- ここから全部が1つの単位。どこかで失敗したら注文本体も含めて残さない
    if v_dup is not null then
      -- 既存の手入力等と同じ注文だとユーザーが確認した: orders には触れず、外部参照だけ結び付ける
      v_order_id := v_dup;
      insert into order_link.external_refs(org_key, channel, issuer_account, external_order_id, source_key, order_id, content_digest,
                                           review_state, link_kind, candidate_id, created_by)
      values (v_c.org_key, v_c.channel, v_c.issuer_account, v_c.external_order_id, v_c.source_key, v_order_id, v_c.content_digest,
              'confirmed', 'linked_existing', v_c.id, v_p.id)
      returning id into v_ref_id;
      v_state := 'already_exists';
    else
      select * into v_cust from public.customers where id = (v_pl#>>'{customer,customer_id}')::uuid and is_active is not false;
      if not found then perform order_link.fail('TS422', 'customer_not_found'); end if;
      v_memo := case when v_pl#>>'{customer_input,broker}' in ('トレタテ', 'ノブレスオブリージュ') then v_pl#>>'{customer_input,broker}' end;
      v_notes := left(concat_ws(' / ', '【シーモルト取込】' || coalesce('外部注文ID ' || v_c.external_order_id, '注文番号なし'),
                                case when v_pl#>>'{delivery,requested_text}' is not null then '希望: ' || (v_pl#>>'{delivery,requested_text}') end,
                                case when v_pl->>'notes_text' is not null then '備考: ' || (v_pl->>'notes_text') end,
                                case when v_review then '要確認: 受発注管理の詳細で未確認項目を確認してください' end), 1000);
      loop
        v_code := 'ORD-' || to_char(now() at time zone 'Asia/Tokyo', 'YYYYMMDD') || '-' || upper(substr(md5(gen_random_uuid()::text), 1, 6));
        exit when not exists (select 1 from public.orders where order_code = v_code);
      end loop;
      insert into public.orders(order_code, customer_id, customer_name, order_date, delivery_date, status, total_amount, notes,
                                delivery_postal, delivery_address, delivery_building, delivery_name, delivery_phone, price_rank, memo, channel)
      values (v_code, v_cust.id, v_cust.name,
              coalesce(nullif(v_pl->>'order_date', '')::date, ((v_pl->>'received_at')::timestamptz at time zone 'Asia/Tokyo')::date),
              nullif(v_pl#>>'{delivery,requested_date}', '')::date, '受注', null, v_notes,
              left(v_pl#>>'{delivery,postal}', 10), left(v_pl#>>'{delivery,address}', 300), left(v_pl#>>'{delivery,building}', 200),
              left(v_pl#>>'{delivery,name}', 100), left(v_pl#>>'{delivery,phone}', 30), coalesce(v_cust.price_rank, 'standard'), v_memo, 'メール')
      returning id into v_order_id;
      insert into order_link.external_refs(org_key, channel, issuer_account, external_order_id, source_key, order_id, content_digest,
                                           review_state, candidate_id, created_by)
      values (v_c.org_key, v_c.channel, v_c.issuer_account, v_c.external_order_id, v_c.source_key, v_order_id, v_c.content_digest,
              case when v_review then 'needs_review' else 'confirmed' end, v_c.id, v_p.id)
      returning id into v_ref_id;
      for it in select * from jsonb_array_elements(v_pl->'items') order by (value->>'line_no')::int loop
        -- 本・頭など重量の決まらない注文は requested_kg・重量・金額を入れない（0 も入れない）
        insert into public.order_items(order_id, part_name, species, product_name, grade_snapshot, requested_kg, price_source)
        values (v_order_id, it->>'part_name', it->>'species', left(it->>'product_text', 200), it->>'grade',
                nullif(it->>'normalized_kg', '')::numeric, 'unpriced_import')
        returning id into v_item_id;
        insert into order_link.item_ext(order_item_id, ref_id, line_no, raw_text, product_text, raw_qty_text, qty, unit, normalized_kg,
                                        temp_zone, temp_text, wish_text, review_items, confirm_state)
        values (v_item_id, v_ref_id, (it->>'line_no')::int, it->>'raw_text', it->>'product_text', it->>'raw_qty_text', (it->>'qty')::numeric,
                it->>'unit', nullif(it->>'normalized_kg', '')::numeric, it->>'temp_zone', it->>'temp_text', it->>'wish_text',
                array(select jsonb_array_elements_text(it->'review_items')),
                case when jsonb_array_length(it->'review_items') > 0 then 'needs_review' else 'confirmed' end);
        if coalesce((it->>'remember_alias')::boolean, false) then
          insert into order_link.product_aliases(org_key, issuer_account, product_text, species, part_name, grade, confirmed_by)
          values (v_c.org_key, v_c.issuer_account, order_link.norm(it->>'product_text'), it->>'species', it->>'part_name', it->>'grade', v_p.id)
          on conflict (org_key, issuer_account, product_text) do nothing;
        end if;
      end loop;
      v_state := 'created';
    end if;
    insert into order_link.ref_sources(ref_id, source_id, role)
    select v_ref_id, cs.source_id, cs.role from order_link.candidate_sources cs where cs.candidate_id = v_c.id;
    update order_link.candidates set state = 'committed', committed_order_id = v_order_id, updated_at = now() where id = v_c.id;
    insert into order_link.runs(request_id, principal_id, tool, idempotency_key, candidate_id, candidate_version, digest, outcome, order_id, user_request, detail)
    values (p_ctx->>'request_id', v_p.id, 'order_import_commit', v_key, v_c.id, v_c.version, v_c.digest, v_state, v_order_id,
            left(p_args->>'user_request', 300), jsonb_build_object('items', jsonb_array_length(v_pl->'items'), 'review', v_review));
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      -- 並行 commit。先に確定した側を取り直して比較する
      select * into v_run from order_link.runs where principal_id = v_p.id and idempotency_key = v_key and tool = 'order_import_commit'
         and outcome not in ('failed', 'forbidden');
      if found then
        if v_run.candidate_id = v_cand and v_run.candidate_version = v_ver and v_run.digest = v_dig then
          return jsonb_build_object('outcome', 'already_exists', 'replayed', true, 'order', order_link.order_brief(v_run.order_id));
        end if;
        return jsonb_build_object('outcome', 'conflict', 'reason', 'idempotency_key_reused_with_different_content');
      end if;
      select r.order_id into v_order_id from order_link.external_refs r
       where r.org_key = v_c.org_key
         and ((v_c.external_order_id is not null and r.channel = v_c.channel and r.issuer_account = v_c.issuer_account and r.external_order_id = v_c.external_order_id)
           or (v_c.external_order_id is null and r.external_order_id is null and r.source_key = v_c.source_key));
      return jsonb_build_object('outcome', 'conflict', 'reason', 'concurrent_registration', 'constraint', v_constraint,
                                'order', case when v_order_id is null then null else order_link.order_brief(v_order_id) end,
                                'message', '同じ注文が同時に登録されました。既存の注文を確認してください（重複は作っていません）');
    when others then
      get stacked diagnostics v_sqlstate = returned_sqlstate, v_constraint = constraint_name;
      if v_sqlstate in ('TS401', 'TS403') then raise; end if;
      -- 全体を巻き戻したうえで、失敗だけを記録する（本文や個人情報は記録しない）
      insert into order_link.runs(request_id, principal_id, tool, idempotency_key, candidate_id, candidate_version, digest, outcome, detail)
      values (p_ctx->>'request_id', v_p.id, 'order_import_commit', v_key, v_c.id, v_c.version, v_c.digest, 'failed',
              jsonb_build_object('sqlstate', v_sqlstate, 'constraint', v_constraint));
      return jsonb_build_object('outcome', 'failed', 'registered', false, 'reason', 'write_failed_rolled_back', 'sqlstate', v_sqlstate,
                                'message', '登録に失敗したため、注文・明細・外部参照・履歴のどれも保存していません');
  end;

  return jsonb_build_object('outcome', v_state, 'registered', v_state = 'created', 'linked_existing', v_state = 'already_exists',
    'candidate_id', v_c.id, 'order', order_link.order_brief(v_order_id),
    'review_state', (select review_state from order_link.external_refs where id = v_ref_id),
    'not_done', jsonb_build_array('在庫の確保', '納期・価格の確約', '出荷指示', '請求書の発行'),
    'message', case when v_state = 'created' then '受注正本（orders/order_items）に「受注」として登録しました。orders_get で再取得して一致を確認してください'
                    else '既存の注文に外部注文IDを結び付けました（新しい注文は作っていません）' end);
exception
  when sqlstate 'TS401' then return jsonb_build_object('outcome', 'forbidden', 'reason', 'unauthenticated');
  when sqlstate 'TS403' then return jsonb_build_object('outcome', 'forbidden', 'reason', sqlerrm);
  when sqlstate 'TS422' or invalid_text_representation then return jsonb_build_object('outcome', 'failed', 'reason', 'validation_error', 'detail', sqlerrm);
end $$;

-- ============================================================================
-- MCP ツール: order_import_status（読取。応答を失ったときの照合先）
-- ============================================================================
create or replace function order_link.api_import_status(p_ctx jsonb, p_args jsonb)
returns jsonb language plpgsql stable security definer set search_path = order_link, public, pg_temp as $$
declare v_p order_link.principals; v_c order_link.candidates; v_cid uuid;
begin
  v_p := order_link.principal_for(p_ctx, 'orders:import');
  perform order_link.check_org_arg(p_args);
  if p_args ? 'candidate_id' then v_cid := (p_args->>'candidate_id')::uuid;
  elsif p_args ? 'idempotency_key' then
    select candidate_id into v_cid from order_link.runs where principal_id = v_p.id and idempotency_key = p_args->>'idempotency_key'
     order by created_at desc limit 1;
    if v_cid is null then
      return jsonb_build_object('outcome', 'read', 'found', false, 'message', 'この冪等キーの実行記録はありません（未実行）');
    end if;
  else perform order_link.fail('TS422', 'candidate_id_or_idempotency_key_required'); end if;
  select * into v_c from order_link.candidates where id = v_cid;
  if not found then return jsonb_build_object('outcome', 'read', 'found', false); end if;
  if v_c.principal_id <> v_p.id then perform order_link.fail('TS403', 'candidate_owned_by_other'); end if;
  return jsonb_build_object('outcome', 'read', 'found', true, 'candidate_id', v_c.id, 'version', v_c.version, 'digest', v_c.digest,
    'state', v_c.state, 'external_order_id', v_c.external_order_id,
    'order', case when v_c.committed_order_id is null then null else order_link.order_brief(v_c.committed_order_id) end,
    'runs', (select coalesce(jsonb_agg(jsonb_build_object('tool', r.tool, 'outcome', r.outcome, 'idempotency_key', r.idempotency_key,
               'candidate_version', r.candidate_version, 'at', r.created_at, 'detail', r.detail) order by r.created_at), '[]')
             from order_link.runs r where r.candidate_id = v_c.id),
    'verified_at', now());
exception
  when sqlstate 'TS401' then return jsonb_build_object('outcome', 'forbidden', 'reason', 'unauthenticated');
  when sqlstate 'TS403' then return jsonb_build_object('outcome', 'forbidden', 'reason', sqlerrm);
  when sqlstate 'TS422' or invalid_text_representation then return jsonb_build_object('outcome', 'failed', 'reason', 'validation_error', 'detail', sqlerrm);
end $$;

-- ============================================================================
-- 既存業務への「要確認」ガード（DB 側。画面を隠すだけにしない）
-- ============================================================================
create or replace function order_link.order_under_review(p_order_id uuid) returns text
language sql stable security definer set search_path = order_link, public, pg_temp as $$
  select o.order_code from order_link.external_refs r join public.orders o on o.id = r.order_id
   where r.order_id = p_order_id and r.review_state = 'needs_review'
$$;

create or replace function order_link.guard_review() returns trigger
language plpgsql security definer set search_path = order_link, public, pg_temp as $$
declare v_order uuid; v_code text;
begin
  if TG_TABLE_NAME = 'orders' then
    if new.status is not distinct from old.status or new.status not in ('確認済','発送済','納品完了') then return new; end if;
    v_order := new.id;
  elsif TG_TABLE_NAME = 'order_items' then
    if new.inventory_id is null or new.inventory_id is not distinct from old.inventory_id then return new; end if;
    v_order := new.order_id;
  elsif TG_TABLE_NAME = 'inventory_allocations' then
    select order_id into v_order from public.order_items where id = new.order_item_id;
  else
    v_order := new.order_id;   -- shipments / documents / document_orders
  end if;
  if v_order is null then return new; end if;
  v_code := order_link.order_under_review(v_order);
  if v_code is not null then
    raise exception using errcode = 'P0001',
      message = format('注文 %s はシーモルト取込の「要確認」です。受発注管理の注文詳細で未確認項目を確認してから進めてください', v_code);
  end if;
  return new;
end $$;

create trigger order_link_guard_status before update of status on public.orders for each row execute function order_link.guard_review();
create trigger order_link_guard_item_inventory before update of inventory_id on public.order_items for each row execute function order_link.guard_review();
create trigger order_link_guard_alloc before insert on public.inventory_allocations for each row execute function order_link.guard_review();
create trigger order_link_guard_shipment before insert or update of order_id on public.shipments for each row execute function order_link.guard_review();
create trigger order_link_guard_document before insert or update of order_id on public.documents for each row execute function order_link.guard_review();
create trigger order_link_guard_document_orders before insert on public.document_orders for each row execute function order_link.guard_review();

-- ============================================================================
-- 既存画面向けの関数
-- ============================================================================
-- 一覧・出荷画面のバッジ用。返すのは注文IDごとの確認状態・未確認項目コード・外部注文IDだけ（個人情報・原文は返さない）。
-- 出荷画面はスタッフキー無しの端末でも使う（2026-08-12 オーナー判断）ため anon にも実行を許す。
create or replace function public.order_link_review_states(p_order_ids uuid[])
returns table(order_id uuid, review_state text, external_order_id text, unresolved text[])
language plpgsql stable security definer set search_path = order_link, public, pg_temp as $$
begin
  if coalesce(array_length(p_order_ids, 1), 0) > 1000 then raise exception 'too many ids'; end if;
  return query
  select r.order_id, r.review_state, r.external_order_id,
         array(select distinct u from order_link.item_ext e, unnest(e.review_items) u where e.ref_id = r.id and e.confirm_state = 'needs_review')
    from order_link.external_refs r where r.order_id = any (p_order_ids);
end $$;

-- 注文詳細の「シーモルト取込」欄。出典・原文を含むのでスタッフキー（ヘッダ）必須
create or replace function public.order_link_order_detail(p_order_id uuid)
returns jsonb language plpgsql stable security definer set search_path = order_link, public, pg_temp as $$
declare v_ref order_link.external_refs;
begin
  if not staff_key_header_ok() then raise exception 'スタッフキーが必要です'; end if;
  select * into v_ref from order_link.external_refs where order_id = p_order_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'external_order_id', v_ref.external_order_id, 'channel', v_ref.channel, 'issuer_account', v_ref.issuer_account,
    'review_state', v_ref.review_state, 'revision', v_ref.revision, 'link_kind', v_ref.link_kind,
    'reviewed_at', v_ref.reviewed_at, 'reviewed_by', v_ref.reviewed_by,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('order_item_id', e.order_item_id, 'line_no', e.line_no, 'raw_text', e.raw_text,
               'product_text', e.product_text, 'raw_qty_text', e.raw_qty_text, 'qty', e.qty, 'unit', e.unit, 'normalized_kg', e.normalized_kg,
               'temp_zone', e.temp_zone, 'temp_text', e.temp_text, 'wish_text', e.wish_text, 'review_items', to_jsonb(e.review_items),
               'confirm_state', e.confirm_state) order by e.line_no), '[]') from order_link.item_ext e where e.ref_id = v_ref.id),
    'sources', (select coalesce(jsonb_agg(jsonb_build_object('provider', s.provider, 'account', s.account, 'filename', s.filename,
               'pages', to_jsonb(s.pages), 'received_at', s.received_at, 'link', s.link, 'role', rs.role) order by s.received_at), '[]')
               from order_link.ref_sources rs join order_link.sources s on s.id = rs.source_id where rs.ref_id = v_ref.id),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('tool', r.tool, 'outcome', r.outcome, 'at', r.created_at,
               'by', coalesce(p.display_name, r.actor), 'user_request', r.user_request) order by r.created_at), '[]')
               from order_link.runs r left join order_link.principals p on p.id = r.principal_id where r.order_id = p_order_id));
end $$;

-- 受発注画面で人が未確認項目を確認する（温度帯の確定など）。全部確認できたときだけ「確認済み」にする
create or replace function public.order_link_confirm_review(p_order_id uuid, p_expected_revision int, p_resolutions jsonb, p_by text)
returns jsonb language plpgsql security definer set search_path = order_link, public, pg_temp as $$
declare v_ref order_link.external_refs; e order_link.item_ext; r jsonb; v_left int;
begin
  if not staff_key_header_ok() then raise exception 'スタッフキーが必要です'; end if;
  if coalesce(btrim(p_by), '') = '' or length(p_by) > 80 then raise exception '確認した担当者名を入れてください'; end if;
  select * into v_ref from order_link.external_refs where order_id = p_order_id for update;
  if not found then raise exception 'シーモルト取込の注文ではありません'; end if;
  if v_ref.revision <> p_expected_revision then raise exception '別の操作で更新されています。開き直してください'; end if;
  for e in select * from order_link.item_ext where ref_id = v_ref.id and confirm_state = 'needs_review' loop
    r := (select x from jsonb_array_elements(coalesce(p_resolutions, '[]')) x where (x->>'order_item_id')::uuid = e.order_item_id limit 1);
    continue when r is null or coalesce((r->>'confirmed')::boolean, false) is not true;
    if ('temp_zone_unknown' = any (e.review_items) or 'fresh_meaning_unconfirmed' = any (e.review_items))
       and coalesce(r->>'temp_zone', '') not in ('chilled', 'frozen') then
      raise exception '明細%: 温度帯（冷蔵／冷凍）を選んでください', e.line_no;
    end if;
    update order_link.item_ext set confirm_state = 'confirmed', temp_zone = coalesce(nullif(r->>'temp_zone', ''), temp_zone)
     where order_item_id = e.order_item_id;
  end loop;
  select count(*) into v_left from order_link.item_ext where ref_id = v_ref.id and confirm_state = 'needs_review';
  update order_link.external_refs set revision = revision + 1,
         review_state = case when v_left = 0 then 'confirmed' else review_state end,
         reviewed_at = case when v_left = 0 then now() else reviewed_at end,
         reviewed_by = case when v_left = 0 then btrim(p_by) else reviewed_by end
   where id = v_ref.id returning * into v_ref;
  insert into order_link.runs(tool, actor, outcome, order_id, detail)
  values ('staff_confirm_review', btrim(p_by), 'confirmed', p_order_id, jsonb_build_object('remaining', v_left));
  return jsonb_build_object('review_state', v_ref.review_state, 'revision', v_ref.revision, 'remaining', v_left);
end $$;

-- ============================================================================
-- 実行権限（PUBLIC から剥がしてから必要な相手にだけ付ける）
-- ============================================================================
revoke all on all functions in schema order_link from public;
revoke all on function public.order_link_review_states(uuid[]) from public;
revoke all on function public.order_link_order_detail(uuid) from public;
revoke all on function public.order_link_confirm_review(uuid, int, jsonb, text) from public;

grant execute on function order_link.api_orders_search(jsonb, jsonb) to seamalt_mcp;
grant execute on function order_link.api_orders_get(jsonb, jsonb) to seamalt_mcp;
grant execute on function order_link.api_import_preview(jsonb, jsonb) to seamalt_mcp;
grant execute on function order_link.api_import_commit(jsonb, jsonb) to seamalt_mcp;
grant execute on function order_link.api_import_status(jsonb, jsonb) to seamalt_mcp;

grant execute on function public.order_link_review_states(uuid[]) to anon, authenticated;
grant execute on function public.order_link_order_detail(uuid) to anon, authenticated;        -- 中でスタッフキー必須
grant execute on function public.order_link_confirm_review(uuid, int, jsonb, text) to anon, authenticated;  -- 中でスタッフキー必須

commit;
