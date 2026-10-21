-- 入金消込（銀行CSV取込 → 自動消込 → 未入金一覧・督促の記録）2026-10-21
-- 指示書「ジビエ基幹システム 入金消込機能 追加指示書」・docs/reconciliation/ を参照。
-- 追加のみ（既存の表・列・値は変えない）。**本番適用は沖の承認後**。
--
-- 方針
--   ・請求書は既存の documents（doc_type='請求書'）。入金と請求書の紐づけは既存の payments に列を足して使う（reconciliations 表は作らない）。
--   ・銀行明細は公開キー（anon）から読めないようにする（RLS 有効・ポリシーなし・権限剥奪）。読み書きはスタッフキー確認つきの関数だけ。
--   ・お金の整合（過入金・二重消込・明細の使い回し）は関数の中で行ロックをかけて検査し、1回の呼び出し＝1トランザクションで書く。
--   ・自動確定のルール判定は画面側の recon-core.js（単体テストあり）。DB は「自動」で書かれたものが手数料差を含まないことなど、お金の不変条件だけを守る。
--   ・期日超過・残額は保存せず、payments の合計と due_date から毎回計算する。

-- ── 銀行ごとのCSV列定義 ──
create table if not exists public.bank_profiles (
  id uuid primary key default gen_random_uuid(),
  bank_name text not null unique,
  encoding text not null default 'auto' check (encoding in ('auto','utf-8','shift_jis')),
  column_map jsonb not null,          -- 例 {"header_rows":1,"date":0,"description":2,"amount_in":3,"amount_out":4,"balance":5}
  date_format text not null default 'auto',
  created_at timestamptz not null default now()
);

-- ── 取込1回ごとの記録 ──
create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  file_name text,
  bank_profile_id uuid references public.bank_profiles(id),
  row_count integer not null,
  new_count integer not null,
  dup_count integer not null,
  imported_by text,
  imported_at timestamptz not null default now()
);

-- ── 銀行明細の生データ（取込後は変更しない）──
create table if not exists public.bank_transactions (
  id uuid primary key default gen_random_uuid(),
  txn_date date not null,
  description text not null default '',
  amount_in integer not null default 0 check (amount_in >= 0),
  amount_out integer not null default 0 check (amount_out >= 0),
  balance bigint,
  raw_hash text not null unique,      -- 日付|摘要|入金|出金|残高|同一行の出現順 の SHA-256。同じCSVを2回入れても増えない
  import_batch_id uuid not null references public.import_batches(id),
  row_no integer,
  created_at timestamptz not null default now()
);
create index if not exists bank_transactions_date_idx on public.bank_transactions (txn_date);

create or replace function public.bank_transactions_immutable() returns trigger
language plpgsql as $$
begin
  raise exception '銀行明細は取込後に変更・削除できません（消込の取消は payments 側で行う）';
end $$;
drop trigger if exists bank_transactions_immutable on public.bank_transactions;
create trigger bank_transactions_immutable before update or delete on public.bank_transactions
  for each row execute function public.bank_transactions_immutable();

-- ── 振込名義のゆらぎ（正規化した名義 → 取引先）──
create table if not exists public.customer_aliases (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  normalized_name text not null check (length(normalized_name) >= 2),
  source text not null default 'manual' check (source in ('initial','manual','confirm')),
  created_by text,
  created_at timestamptz not null default now(),
  unique (customer_id, normalized_name)
);
create index if not exists customer_aliases_name_idx on public.customer_aliases (normalized_name);

-- ── 督促を送った記録（1通＝letter_id、対象の請求書ごとに1行）──
create table if not exists public.dunning_logs (
  id uuid primary key default gen_random_uuid(),
  letter_id uuid not null,
  customer_id uuid references public.customers(id),
  document_id uuid not null references public.documents(id),
  round integer not null check (round >= 1),
  channel text not null check (channel in ('email','line','messenger','phone','other')),
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists dunning_logs_doc_idx on public.dunning_logs (document_id);

-- ── 消込の操作履歴（確定・取消・名義登録）──
create table if not exists public.recon_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('import','confirm','undo','alias')),
  bank_transaction_id uuid,
  document_ids uuid[],
  detail jsonb,
  created_by text,
  created_at timestamptz not null default now()
);

-- ── 既存の表への列追加 ──
alter table public.payments add column if not exists bank_transaction_id uuid references public.bank_transactions(id);
alter table public.payments add column if not exists fee_amount integer not null default 0 check (fee_amount >= 0);
alter table public.payments add column if not exists match_method text check (match_method in ('auto','manual'));
alter table public.payments add column if not exists match_rule text;
alter table public.payments add column if not exists confidence numeric(3,2) check (confidence between 0 and 1);
alter table public.payments add column if not exists matched_at timestamptz;
alter table public.payments add column if not exists matched_by text;
create unique index if not exists payments_txn_doc_uidx on public.payments (bank_transaction_id, document_id) where bank_transaction_id is not null;

alter table public.customers add column if not exists department text check (department in ('gibier','arco'));
alter table public.documents add column if not exists department text check (department in ('gibier','arco'));

-- ── 公開キーから読めないようにする（RLS 有効・ポリシーなし）──
alter table public.bank_profiles enable row level security;
alter table public.import_batches enable row level security;
alter table public.bank_transactions enable row level security;
alter table public.customer_aliases enable row level security;
alter table public.dunning_logs enable row level security;
alter table public.recon_events enable row level security;
revoke all on public.bank_profiles, public.import_batches, public.bank_transactions,
              public.customer_aliases, public.dunning_logs, public.recon_events from anon, authenticated;

-- ── 内部: 請求書の入金状態を payments から計算し直す（billing_status は表示用の写し）──
create or replace function public._recon_refresh_status(p_doc uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v_total int; v_paid int;
begin
  select total_amount into v_total from documents where id = p_doc;
  select coalesce(sum(amount + coalesce(fee_amount,0)),0) into v_paid from payments where document_id = p_doc;
  update documents set billing_status = case when v_paid <= 0 then '未入金'
                                             when v_paid >= coalesce(v_total,0) then '入金済'
                                             else '一部入金' end
   where id = p_doc;
end $$;
revoke all on function public._recon_refresh_status(uuid) from public, anon, authenticated;

-- 日付として読めなければ null（2026-02-30 などで関数全体を落とさず、その行を「読めない行」として返すため）
create or replace function public._recon_safe_date(p text) returns date
language plpgsql immutable as $$
begin
  if p is null or p !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return p::date;
exception when others then return null;
end $$;

-- ── 1. 銀行CSV取込（プレビュー／確定）──
-- p_rows: [{row_no, txn_date:'YYYY-MM-DD', description, amount_in, amount_out, balance}]（画面のCSVパーサが銀行の列定義で解釈したもの）
-- 1行でも解釈できない行があれば何も入れない（fail-closed）。重複は raw_hash で数え、確定時は増やさない。
create or replace function public.staff_bank_import(p_staff_key text, p_bank_name text, p_file_name text, p_rows jsonb, p_commit boolean, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_prof uuid; v_bad jsonb; v_total int; v_dup int; v_batch uuid; v_new int;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception '明細がありません'; end if;
  select id into v_prof from bank_profiles where bank_name = p_bank_name;

  -- 解釈できない行（日付・金額の形、入出金の両方0）を全部数える
  select coalesce(jsonb_agg(r->'row_no'), '[]'::jsonb) into v_bad
    from jsonb_array_elements(p_rows) r
   where _recon_safe_date(r->>'txn_date') is null
      or coalesce(r->>'amount_in','0') !~ '^\d{1,9}$' or coalesce(r->>'amount_out','0') !~ '^\d{1,9}$'
      or (r->>'balance' is not null and r->>'balance' !~ '^-?\d{1,15}$')
      or (coalesce(r->>'amount_in','0') ~ '^0+$' and coalesce(r->>'amount_out','0') ~ '^0+$');
  if jsonb_array_length(v_bad) > 0 then
    return jsonb_build_object('ok', false, 'invalid_rows', v_bad, 'row_count', jsonb_array_length(p_rows));
  end if;

  drop table if exists _rows;
  create temp table _rows on commit drop as
  select (r->>'row_no')::int row_no, (r->>'txn_date')::date txn_date, btrim(coalesce(r->>'description','')) description,
         coalesce((r->>'amount_in')::int,0) amount_in, coalesce((r->>'amount_out')::int,0) amount_out,
         (r->>'balance')::bigint balance
    from jsonb_array_elements(p_rows) r;
  alter table _rows add column raw_hash text;
  update _rows t set raw_hash = h.hash from (
    select row_no, encode(digest(concat_ws('|', txn_date, description, amount_in, amount_out, coalesce(balance::text,''),
             row_number() over (partition by txn_date, description, amount_in, amount_out, balance order by row_no) - 1), 'sha256'), 'hex') hash
      from _rows) h where h.row_no = t.row_no;

  select count(*) into v_total from _rows;
  select count(*) into v_dup from _rows t where exists (select 1 from bank_transactions b where b.raw_hash = t.raw_hash);
  if not p_commit then
    return jsonb_build_object('ok', true, 'preview', true, 'row_count', v_total, 'new_count', v_total - v_dup, 'dup_count', v_dup);
  end if;

  insert into import_batches (file_name, bank_profile_id, row_count, new_count, dup_count, imported_by)
  values (p_file_name, v_prof, v_total, 0, v_dup, p_by) returning id into v_batch;
  insert into bank_transactions (txn_date, description, amount_in, amount_out, balance, raw_hash, import_batch_id, row_no)
  select txn_date, description, amount_in, amount_out, balance, raw_hash, v_batch, row_no from _rows
  on conflict (raw_hash) do nothing;
  get diagnostics v_new = row_count;
  update import_batches set new_count = v_new, dup_count = v_total - v_new where id = v_batch;
  insert into recon_events (kind, detail, created_by) values ('import', jsonb_build_object('batch', v_batch, 'rows', v_total, 'new', v_new), p_by);
  return jsonb_build_object('ok', true, 'preview', false, 'batch_id', v_batch, 'row_count', v_total, 'new_count', v_new, 'dup_count', v_total - v_new);
end $$;

-- ── 2. 消込に使うデータ（未消込の入金明細・未入金の請求書・名義）──
create or replace function public.staff_recon_snapshot(p_staff_key text)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare v jsonb;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  with paid as (select document_id, sum(amount + coalesce(fee_amount,0)) paid from payments group by document_id),
  inv as (
    select d.id, d.doc_number, d.customer_id, d.partner_name, d.issue_date, d.due_date, d.total_amount,
           coalesce(p.paid,0) paid, coalesce(d.department, c.department, 'gibier') department
      from documents d left join paid p on p.document_id = d.id left join customers c on c.id = d.customer_id
     where d.doc_type = '請求書' and d.status = '発行済' and coalesce(d.total_amount,0) - coalesce(p.paid,0) > 0),
  used as (select bank_transaction_id id, sum(amount) amt from payments where bank_transaction_id is not null group by 1),
  txn as (
    select b.id, b.txn_date, b.description, b.amount_in from bank_transactions b left join used u on u.id = b.id
     where b.amount_in > 0 and u.id is null)
  select jsonb_build_object(
    'invoices', coalesce((select jsonb_agg(to_jsonb(inv) order by inv.issue_date, inv.doc_number) from inv), '[]'),
    'customers', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'kana', c.kana, 'aliases', coalesce(c.search_aliases, '{}')))
                             from customers c where c.id in (select customer_id from inv)), '[]'),
    'aliases', coalesce((select jsonb_agg(jsonb_build_object('customer_id', a.customer_id, 'name', a.normalized_name)) from customer_aliases a), '[]'),
    'txns', coalesce((select jsonb_agg(to_jsonb(txn) order by txn.txn_date, txn.id) from txn), '[]'),
    'fee_tolerance', coalesce((select (value #>> '{}')::int from app_settings where key = 'recon_fee_tolerance'), 1000)
  ) into v;
  return v;
end $$;

-- ── 3. 消込の確定（自動・手動とも）──
-- p_allocs: [{document_id, amount, fee}]。入金額＝Σamount（入金の全額をどこかに充てる）。amount+fee ≦ 各請求書の残額。
-- 自動（auto）は手数料差を含められない。手動で確定したときは、その振込名義を名義表に登録する（次回から自動に昇格）。
create or replace function public.staff_recon_confirm(p_staff_key text, p_txn uuid, p_allocs jsonb, p_method text, p_rule text,
                                                      p_confidence numeric, p_alias text default null, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare t record; a record; v_remain int; v_sum int := 0; v_tol int; v_docs uuid[] := '{}'; v_cust uuid[]; v_alias text;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if p_method not in ('auto','manual') then raise exception 'method は auto か manual'; end if;
  select * into t from bank_transactions where id = p_txn for update;
  if not found then raise exception '入金明細が見つかりません'; end if;
  if t.amount_in <= 0 then raise exception '出金明細は消込の対象外です'; end if;
  if exists (select 1 from payments where bank_transaction_id = p_txn) then
    return jsonb_build_object('ok', false, 'reason', 'この入金明細はすでに消込済みです');
  end if;
  v_tol := coalesce((select (value #>> '{}')::int from app_settings where key = 'recon_fee_tolerance'), 1000);
  if jsonb_typeof(p_allocs) <> 'array' or jsonb_array_length(p_allocs) = 0 then raise exception '充てる請求書がありません'; end if;

  for a in select (x->>'document_id')::uuid doc, (x->>'amount')::int amt, coalesce((x->>'fee')::int,0) fee
             from jsonb_array_elements(p_allocs) x order by (x->>'document_id') loop
    if a.amt <= 0 or a.fee < 0 then raise exception '金額が正しくありません'; end if;
    if a.fee > 0 and p_method = 'auto' then raise exception '手数料差を含む消込は自動確定できません'; end if;
    if a.fee > v_tol then raise exception '手数料差 % 円は許容範囲（% 円）を超えています', a.fee, v_tol; end if;
    perform 1 from documents where id = a.doc and doc_type = '請求書' and status = '発行済' for update;
    if not found then raise exception '発行済の請求書ではありません'; end if;
    select coalesce(d.total_amount,0) - coalesce((select sum(amount + coalesce(fee_amount,0)) from payments where document_id = a.doc),0)
      into v_remain from documents d where d.id = a.doc;
    if a.amt + a.fee > v_remain then raise exception '残額を超えて充てることはできません（過入金・二重消込の防止）'; end if;
    insert into payments (document_id, paid_date, amount, method, note, bank_transaction_id, fee_amount, match_method, match_rule, confidence, matched_at, matched_by)
    values (a.doc, t.txn_date, a.amt, '振込', '銀行明細 ' || t.txn_date, p_txn, a.fee, p_method, p_rule, p_confidence, now(), p_by);
    v_sum := v_sum + a.amt; v_docs := v_docs || a.doc;
  end loop;
  if v_sum <> t.amount_in then raise exception '入金額 % 円と充てた額 % 円が一致しません', t.amount_in, v_sum; end if;
  perform _recon_refresh_status(d) from unnest(v_docs) d;

  if p_method = 'manual' and p_alias is not null and length(p_alias) >= 2 then
    select array_agg(distinct customer_id) into v_cust from documents where id = any(v_docs) and customer_id is not null;
    if coalesce(array_length(v_cust,1),0) = 1 then
      insert into customer_aliases (customer_id, normalized_name, source, created_by) values (v_cust[1], p_alias, 'confirm', p_by)
      on conflict (customer_id, normalized_name) do nothing;
      v_alias := p_alias;
    end if;
  end if;
  insert into recon_events (kind, bank_transaction_id, document_ids, detail, created_by)
  values ('confirm', p_txn, v_docs, jsonb_build_object('method', p_method, 'rule', p_rule, 'confidence', p_confidence, 'allocs', p_allocs, 'alias', v_alias), p_by);
  return jsonb_build_object('ok', true, 'documents', to_jsonb(v_docs), 'alias', v_alias);
end $$;

-- ── 4. 消込の取消（payments の行を消して、請求書の状態を計算し直す）──
create or replace function public.staff_recon_undo(p_staff_key text, p_txn uuid, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_docs uuid[]; v_rows jsonb;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  select array_agg(document_id), jsonb_agg(jsonb_build_object('document_id', document_id, 'amount', amount, 'fee', fee_amount, 'method', match_method))
    into v_docs, v_rows from payments where bank_transaction_id = p_txn;
  if v_docs is null then return jsonb_build_object('ok', false, 'reason', 'この入金明細は消込されていません'); end if;
  delete from payments where bank_transaction_id = p_txn;
  perform _recon_refresh_status(d) from unnest(v_docs) d;
  insert into recon_events (kind, bank_transaction_id, document_ids, detail, created_by) values ('undo', p_txn, v_docs, jsonb_build_object('removed', v_rows), p_by);
  return jsonb_build_object('ok', true, 'documents', to_jsonb(v_docs));
end $$;

-- ── 5. 未入金一覧（基準日時点。期日超過・経過日数は保存せず毎回計算）──
create or replace function public.staff_unpaid_list(p_staff_key text, p_as_of date default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_day date := coalesce(p_as_of, (now() at time zone 'Asia/Tokyo')::date);
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  return coalesce((
    select jsonb_agg(x order by x->>'customer_code', x->>'issue_date', x->>'doc_number') from (
      select jsonb_build_object(
        'document_id', d.id, 'doc_number', d.doc_number, 'customer_id', d.customer_id, 'customer_code', c.code,
        'customer_name', coalesce(c.name, d.partner_name), 'email', c.email, 'issue_date', d.issue_date, 'due_date', d.due_date,
        'total', d.total_amount, 'paid', coalesce(p.paid,0), 'remain', d.total_amount - coalesce(p.paid,0),
        'days_overdue', case when d.due_date < v_day then v_day - d.due_date else 0 end,
        'department', coalesce(d.department, c.department, 'gibier'),
        'dunning_count', (select count(distinct letter_id) from dunning_logs g where g.document_id = d.id),
        'last_dunned_at', (select max(created_at) from dunning_logs g where g.document_id = d.id)) x
        from documents d left join customers c on c.id = d.customer_id
        left join (select document_id, sum(amount + coalesce(fee_amount,0)) paid from payments
                    where paid_date <= v_day group by document_id) p on p.document_id = d.id
       where d.doc_type = '請求書' and d.status = '発行済' and d.issue_date <= v_day
         and coalesce(d.total_amount,0) - coalesce(p.paid,0) > 0) s), '[]'::jsonb);
end $$;

-- ── 6. 督促を送った記録（1通＝取引先ごとに未入金請求書をまとめる）──
create or replace function public.staff_dunning_record(p_staff_key text, p_customer uuid, p_docs uuid[], p_channel text, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_letter uuid := gen_random_uuid(); v_round int;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if coalesce(array_length(p_docs,1),0) = 0 then raise exception '請求書がありません'; end if;
  if exists (select 1 from documents where id = any(p_docs) and customer_id is distinct from p_customer) then
    raise exception '別の取引先の請求書が混ざっています';
  end if;
  select coalesce(max(round),0) + 1 into v_round from dunning_logs where document_id = any(p_docs);
  insert into dunning_logs (letter_id, customer_id, document_id, round, channel, created_by)
  select v_letter, p_customer, d, v_round, p_channel, p_by from unnest(p_docs) d;
  return jsonb_build_object('ok', true, 'letter_id', v_letter, 'round', v_round);
end $$;

-- ── 7. 振込名義の手動登録・削除 ──
create or replace function public.staff_alias_set(p_staff_key text, p_customer uuid, p_name text, p_remove boolean default false, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if p_remove then
    delete from customer_aliases where customer_id = p_customer and normalized_name = p_name;
  else
    insert into customer_aliases (customer_id, normalized_name, source, created_by) values (p_customer, p_name, 'manual', p_by)
    on conflict (customer_id, normalized_name) do nothing;
  end if;
  insert into recon_events (kind, detail, created_by) values ('alias', jsonb_build_object('customer', p_customer, 'name', p_name, 'remove', p_remove), p_by);
  return jsonb_build_object('ok', true);
end $$;

-- ── 8. 税理士向け月次（その月に消込した入金・月末時点の未入金・部門別集計）──
create or replace function public.staff_recon_month(p_staff_key text, p_month text)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_from date; v_to date;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if p_month !~ '^\d{4}-\d{2}$' then raise exception '月は YYYY-MM'; end if;
  v_from := (p_month || '-01')::date; v_to := (v_from + interval '1 month - 1 day')::date;
  return jsonb_build_object(
    'month', p_month,
    'paid', coalesce((select jsonb_agg(jsonb_build_object(
              'doc_number', d.doc_number, 'customer_code', c.code, 'customer_name', coalesce(c.name, d.partner_name),
              'department', coalesce(d.department, c.department, 'gibier'), 'invoice_total', d.total_amount,
              'paid_date', p.paid_date, 'amount', p.amount, 'fee', p.fee_amount, 'method', p.match_method,
              'bank_date', b.txn_date, 'bank_amount', b.amount_in) order by p.paid_date, d.doc_number)
            from payments p join documents d on d.id = p.document_id left join customers c on c.id = d.customer_id
            left join bank_transactions b on b.id = p.bank_transaction_id
           where p.paid_date between v_from and v_to), '[]'),
    'unpaid', staff_unpaid_list(p_staff_key, v_to),
    'summary', coalesce((select jsonb_agg(s order by s->>'department') from (
              select jsonb_build_object('department', dep,
                       'sales', coalesce(sum(sales),0), 'received', coalesce(sum(received),0), 'fee', coalesce(sum(fee),0)) s, dep
                from (select coalesce(d.department, c.department, 'gibier') dep, d.total_amount sales, 0 received, 0 fee
                        from documents d left join customers c on c.id = d.customer_id
                       where d.doc_type = '請求書' and d.status = '発行済' and d.issue_date between v_from and v_to
                      union all
                      select coalesce(d.department, c.department, 'gibier'), 0, p.amount, p.fee_amount
                        from payments p join documents d on d.id = p.document_id left join customers c on c.id = d.customer_id
                       where p.paid_date between v_from and v_to) u group by dep) z), '[]'));
end $$;

revoke all on function public.staff_bank_import(text,text,text,jsonb,boolean,text), public.staff_recon_snapshot(text),
  public.staff_recon_confirm(text,uuid,jsonb,text,text,numeric,text,text), public.staff_recon_undo(text,uuid,text),
  public.staff_unpaid_list(text,date), public.staff_dunning_record(text,uuid,uuid[],text,text),
  public.staff_alias_set(text,uuid,text,boolean,text), public.staff_recon_month(text,text) from public;
grant execute on function public.staff_bank_import(text,text,text,jsonb,boolean,text), public.staff_recon_snapshot(text),
  public.staff_recon_confirm(text,uuid,jsonb,text,text,numeric,text,text), public.staff_recon_undo(text,uuid,text),
  public.staff_unpaid_list(text,date), public.staff_dunning_record(text,uuid,uuid[],text,text),
  public.staff_alias_set(text,uuid,text,boolean,text), public.staff_recon_month(text,text) to anon, authenticated;
