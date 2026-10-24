-- 会計（finance.html）: 部門・口座・カード明細・領収書・勘定科目・出金の分類・閲覧専用キー（税理士）。追加のみ。
-- 前提: 20261021_bank_reconciliation.sql（銀行明細・入金消込）
-- ※ 本番未適用。適用は沖の承認が要る（RLS・権限の変更を含む）。
--
-- 部門: 館山ジビエセンター（gibier・通帳は市役所へ報告義務）／合同会社アルコ本体（arco）／必要なら追加。
--   口座・カード・請求書・取引先・領収書が部門を持ち、明細は「口座（カード）の部門」が既定で、1件ずつ別の部門に付け替えられる。
-- 役割
--   スタッフ（作業員）: スタッフキー。取込・分類・領収書の登録・消込ができる
--   管理者            : スタッフキー＋業務アプリの管理者コード。加えて閲覧専用キーの発行、勘定科目・部門の変更、取消
--   税理士            : 閲覧専用キー（x-finance-key）。すべて読める・出力できる。書けない
-- 新しい表はすべて RLS 有効・ポリシーなし・anon/authenticated の権限を剥奪し、キー確認つきの関数からだけ読み書きする。

-- ── 0. 部門 ──
create table if not exists public.departments (
  code text primary key check (code ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  short_name text,
  sort integer not null default 100,
  is_active boolean not null default true,
  report_to text,                                  -- 例: 館山市（通帳の報告義務）
  created_at timestamptz not null default now()
);
insert into public.departments (code, name, short_name, sort, report_to) values
  ('gibier', '館山ジビエセンター', 'ジビエ', 10, '館山市（通帳の報告義務）'),
  ('arco', '合同会社アルコ（本体）', 'アルコ', 20, null)
on conflict (code) do nothing;
-- 20261021 で足した部門列（customers / documents）に、部門表への参照を付ける
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'customers_department_fkey') then
    alter table public.customers add constraint customers_department_fkey foreign key (department) references public.departments(code);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'documents_department_fkey') then
    alter table public.documents add constraint documents_department_fkey foreign key (department) references public.departments(code);
  end if;
end $$;

-- ── 0b. 口座（通帳）とカードの持ち主 ──
create table if not exists public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  bank_name text not null,
  branch text,
  account_type text,                               -- 普通／当座
  account_no text not null,
  label text not null,                             -- 画面での呼び名（例: ジビエセンター口座）
  department text not null references public.departments(code),
  is_active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now(),
  unique (bank_name, account_no)
);
create table if not exists public.finance_cards (
  card_name text primary key,
  label text,
  department text not null references public.departments(code),
  is_active boolean not null default true,
  created_by text,
  created_at timestamptz not null default now()
);
alter table public.bank_transactions add column if not exists account_id uuid references public.bank_accounts(id);
alter table public.import_batches add column if not exists account_id uuid references public.bank_accounts(id);
create index if not exists bank_transactions_account_idx on public.bank_transactions (account_id, txn_date);

-- ── 1. 勘定科目 ──
create table if not exists public.account_titles (
  code text primary key,                         -- 例 expense.supplies（変えない）
  name text not null,                            -- 消耗品費（税理士が直せる）
  kind text not null check (kind in ('income','expense','asset','liability','other')),
  tax_rate integer not null default 10 check (tax_rate in (0, 8, 10)),
  sort integer not null default 100,
  is_active boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into public.account_titles (code, name, kind, tax_rate, sort) values
  ('income.sales_gibier','売上高（ジビエ）','income',8,10), ('income.sales_other','売上高（その他）','income',10,20), ('income.subsidy','補助金・助成金','income',0,30),
  ('income.interest','受取利息','income',0,40), ('income.misc','雑収入','income',10,50),
  ('expense.purchase','仕入高（個体買取・資材）','expense',8,60), ('expense.outsourcing','外注費','expense',10,70), ('expense.freight','荷造運賃','expense',10,80),
  ('expense.supplies','消耗品費','expense',10,90), ('expense.travel','旅費交通費','expense',10,100), ('expense.vehicle','車両費','expense',10,110),
  ('expense.utilities','水道光熱費','expense',10,120), ('expense.communication','通信費','expense',10,130), ('expense.rent','地代家賃','expense',10,140),
  ('expense.repair','修繕費','expense',10,150), ('expense.fees','支払手数料','expense',10,160), ('expense.taxes','租税公課','expense',0,170),
  ('expense.insurance','保険料','expense',0,180), ('expense.welfare','法定福利費','expense',0,190), ('expense.salary','給料手当','expense',0,200),
  ('expense.entertainment','接待交際費','expense',10,210), ('expense.meeting','会議費','expense',10,220), ('expense.advertising','広告宣伝費','expense',10,230),
  ('expense.misc','雑費','expense',10,240), ('other.owner','事業主貸／役員貸付','other',0,250), ('other.transfer','口座間振替','other',0,260),
  ('other.loan','借入金の返済','other',0,270), ('other.tax_payment','税金の納付','other',0,280)
on conflict (code) do nothing;

-- ── 2. 取込プロファイルは銀行とカードで共用（kind で区別）──
alter table public.bank_profiles add column if not exists kind text not null default 'bank' check (kind in ('bank','card'));

-- ── 3. カード明細（取込後は変更しない）──
create table if not exists public.card_transactions (
  id uuid primary key default gen_random_uuid(),
  txn_date date not null,
  description text not null default '',
  amount integer not null check (amount <> 0),    -- 利用は正、返金・取消は負
  card_name text not null references public.finance_cards(card_name),
  raw_hash text not null unique,                  -- カード名|日付|摘要|金額|同一行の出現順 の SHA-256
  import_batch_id uuid not null references public.import_batches(id),
  row_no integer,
  created_at timestamptz not null default now()
);
create index if not exists card_transactions_date_idx on public.card_transactions (txn_date);
create or replace trigger card_transactions_immutable before update or delete on public.card_transactions
  for each row execute function public.bank_transactions_immutable();

-- ── 4. 明細の分類（銀行の出金・ジビエ以外の入金・カード利用に勘定科目・部門を付ける。明細そのものは変えない）──
create table if not exists public.finance_classifications (
  kind text not null check (kind in ('bank','card')),
  txn_id uuid not null,
  category_code text references public.account_titles(code),
  memo text,
  department text references public.departments(code),   -- 口座・カードの部門と違うときだけ入れる
  classified_by text,
  classified_at timestamptz not null default now(),
  primary key (kind, txn_id)
);

-- ── 5. 領収書（台帳。本体は receipt_files）──
create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  receipt_date date,
  vendor text,
  amount integer check (amount is null or amount >= 0),
  tax_rate integer check (tax_rate is null or tax_rate in (0, 8, 10)),
  category_code text references public.account_titles(code),
  department text references public.departments(code),
  memo text,
  storage_path text,                              -- db:receipt_files/<id>（将来 Storage に移すときのために残す）
  file_name text, mime text, size_bytes integer,
  paid_by text check (paid_by in ('card','bank','cash','other')),
  bank_transaction_id uuid references public.bank_transactions(id),
  card_transaction_id uuid references public.card_transactions(id),
  status text not null default 'pending' check (status in ('pending','confirmed','rejected')),
  uploaded_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz, confirmed_by text
);
create index if not exists receipts_date_idx on public.receipts (receipt_date);
create index if not exists receipts_status_idx on public.receipts (status);
-- Supabase Storage は公開キー＋独自ヘッダ（x-staff-key）の RLS が効かない（Storage API はリクエストヘッダを request.headers に渡さない）ため、
-- 当面は本体を DB に置く。画面側で画像を縮小（長辺1600px・JPEG）して1枚 200〜400KB に抑える。件数が増えたら Edge Function で Storage へ移す。
create table if not exists public.receipt_files (
  receipt_id uuid primary key references public.receipts(id) on delete cascade,
  mime text not null,
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 3145728),   -- 3MB まで
  content bytea not null,
  sha256 text not null,
  created_at timestamptz not null default now()
);

-- ── 6. 会計の操作履歴 ──
create table if not exists public.finance_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null,                             -- card_import / classify / receipt_add / receipt_update / receipt_file / titles / viewer_key / account / card / department
  ref_id uuid,
  detail jsonb,
  created_by text,
  created_at timestamptz not null default now()
);

alter table public.departments enable row level security;
alter table public.bank_accounts enable row level security;
alter table public.finance_cards enable row level security;
alter table public.account_titles enable row level security;
alter table public.card_transactions enable row level security;
alter table public.finance_classifications enable row level security;
alter table public.receipts enable row level security;
alter table public.receipt_files enable row level security;
alter table public.finance_events enable row level security;
revoke all on public.departments, public.bank_accounts, public.finance_cards, public.account_titles, public.card_transactions,
              public.finance_classifications, public.receipts, public.receipt_files, public.finance_events from anon, authenticated;

-- ── 7. キー ──
-- 閲覧専用キー（税理士用）。app_secrets に bcrypt で持つ。発行・変更は管理者用回復コードが要る（スタッフキーだけでは発行できない）
create or replace function public.admin_set_finance_viewer_key(p_recovery_code text, p_new_key text)
returns boolean language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_hash text; v_fail int; v_ok boolean;
begin
  select hash into v_hash from app_secrets where key = 'recovery_code';
  v_ok := v_hash is not null and v_hash = extensions.crypt(coalesce(p_recovery_code,''), v_hash);
  if not v_ok then
    perform pg_advisory_xact_lock(hashtext('auth:recovery'));
    select count(*) into v_fail from auth_attempts where kind = 'recovery' and not ok and created_at > now() - interval '15 minutes';
    insert into auth_attempts (kind, ok) values ('recovery', false);
    if v_fail >= 5 then insert into security_events (event, detail) values ('recovery_locked', '15分に誤り多数'); end if;
    insert into security_events (event) values ('recovery_failed');
    return false;
  end if;
  insert into auth_attempts (kind, ok) values ('recovery', true);
  if length(coalesce(p_new_key,'')) < 16 then raise exception '閲覧専用キーは16文字以上にしてください'; end if;
  insert into app_secrets (key, hash) values ('finance_viewer_key', extensions.crypt(p_new_key, extensions.gen_salt('bf')))
    on conflict (key) do update set hash = excluded.hash, updated_at = now();
  -- ヘッダ照合用（本番の staff_key_header_ok と同じく sha256）
  insert into app_secrets (key, hash) values ('finance_viewer_key_sha256', encode(extensions.digest(p_new_key, 'sha256'), 'hex'))
    on conflict (key) do update set hash = excluded.hash, updated_at = now();
  insert into security_events (event, detail) values ('finance_viewer_key_set', '閲覧専用キーを発行・変更');
  insert into finance_events (kind, detail) values ('viewer_key', jsonb_build_object('action', 'set'));
  return true;
end $$;

-- キーから役割を返す（staff / viewer）。どちらでもなければ例外。
-- 注: 例外で終わる呼び出しでは auth_attempts への記録も巻き戻る（本番の staff_key_ok を RPC から呼ぶ場合と同じ）。直接呼んだときだけ回数制限が効く
create or replace function public.finance_role(p_key text)
returns text language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_staff text; v_viewer text; v_fail int;
begin
  select hash into v_staff from app_secrets where key = 'staff_key';
  select hash into v_viewer from app_secrets where key = 'finance_viewer_key';
  if v_staff is not null and v_staff = extensions.crypt(coalesce(p_key,''), v_staff) then return 'staff'; end if;
  if v_viewer is not null and v_viewer = extensions.crypt(coalesce(p_key,''), v_viewer) then return 'viewer'; end if;
  perform pg_advisory_xact_lock(hashtext('auth:finance_key'));
  select count(*) into v_fail from auth_attempts where kind = 'finance_key' and not ok and created_at > now() - interval '5 minutes';
  insert into auth_attempts (kind, ok) values ('finance_key', false);
  if v_fail >= 10 then insert into security_events (event, detail) values ('finance_key_bruteforce', '5分に誤り多数'); raise exception 'しばらく待ってから試してください'; end if;
  raise exception 'キーが違います';
end $$;
create or replace function public.finance_viewer_header_ok()
returns boolean language plpgsql stable security definer set search_path = public, extensions as $$
declare v_key text; v_hash text;
begin
  begin
    v_key := (current_setting('request.headers', true))::jsonb ->> 'x-finance-key';
  exception when others then v_key := null; end;
  if v_key is null or v_key = '' then return false; end if;
  select hash into v_hash from app_secrets where key = 'finance_viewer_key_sha256';
  if v_hash is null then return false; end if;
  return encode(extensions.digest(v_key, 'sha256'), 'hex') = v_hash;
end $$;

-- 部門の確認（null は「全部門」）
create or replace function public._fin_dept_ok(p text) returns boolean language sql stable as $$
  select p is null or exists (select 1 from public.departments d where d.code = p)
$$;

-- ── 8. 読む（スタッフ・閲覧専用の両方。p_department が null なら全部門）──
create or replace function public.finance_setup(p_key text)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  return jsonb_build_object(
    'role', finance_role(p_key),
    'departments', coalesce((select jsonb_agg(to_jsonb(d) order by d.sort, d.code) from departments d), '[]'),
    'accounts', coalesce((select jsonb_agg(to_jsonb(a) order by a.department, a.label) from bank_accounts a), '[]'),
    'cards', coalesce((select jsonb_agg(to_jsonb(c) order by c.department, c.card_name) from finance_cards c), '[]'),
    'titles', coalesce((select jsonb_agg(to_jsonb(t) order by t.sort, t.code) from account_titles t), '[]'));
end $$;

create or replace function public.finance_titles(p_key text)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  perform finance_role(p_key);
  return coalesce((select jsonb_agg(to_jsonb(t) order by t.sort, t.code) from account_titles t), '[]');
end $$;

-- 未入金（請求書の部門＝documents.department、無ければ取引先の部門、無ければ gibier）
create or replace function public.staff_unpaid_list_any(p_key text, p_as_of date default null, p_department text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_day date := coalesce(p_as_of, (now() at time zone 'Asia/Tokyo')::date);
begin
  perform finance_role(p_key);
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
         and coalesce(d.total_amount,0) - coalesce(p.paid,0) > 0
         and (p_department is null or coalesce(d.department, c.department, 'gibier') = p_department)) s), '[]'::jsonb);
end $$;

-- ダッシュボード: 口座ごとの残高、月ごとの入出金、未入金（期日超過）、未処理の件数
create or replace function public.finance_overview(p_key text, p_department text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_day date := (now() at time zone 'Asia/Tokyo')::date; v_role text;
begin
  v_role := finance_role(p_key);
  if not _fin_dept_ok(p_department) then raise exception '部門がありません: %', p_department; end if;
  return jsonb_build_object(
    'role', v_role,
    'department', p_department,
    'accounts', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'label', a.label, 'bank_name', a.bank_name, 'department', a.department,
                  'latest', (select jsonb_build_object('date', b.txn_date, 'balance', b.balance) from bank_transactions b
                              where b.account_id = a.id and b.balance is not null order by b.txn_date desc, b.row_no desc, b.created_at desc limit 1))
                  order by a.department, a.label) from bank_accounts a where a.is_active and (p_department is null or a.department = p_department)), '[]'),
    'months', coalesce((select jsonb_agg(m order by m->>'month') from (
                select jsonb_build_object('month', to_char(b.txn_date, 'YYYY-MM'), 'amount_in', sum(b.amount_in), 'amount_out', sum(b.amount_out), 'count', count(*)) m
                  from bank_transactions b left join bank_accounts a on a.id = b.account_id
                  left join finance_classifications c on c.kind = 'bank' and c.txn_id = b.id
                 where b.txn_date >= (date_trunc('month', v_day) - interval '11 months')::date
                   and (p_department is null or coalesce(c.department, a.department, 'gibier') = p_department)
                 group by to_char(b.txn_date, 'YYYY-MM')) s), '[]'),
    'unpaid', (select jsonb_build_object('count', count(*), 'total', coalesce(sum((x->>'remain')::int),0),
                 'overdue_count', count(*) filter (where (x->>'days_overdue')::int > 0),
                 'overdue_total', coalesce(sum((x->>'remain')::int) filter (where (x->>'days_overdue')::int > 0),0))
               from jsonb_array_elements(staff_unpaid_list_any(p_key, v_day, p_department)) x),
    'pending', jsonb_build_object(
      'bank_in_unmatched', (select count(*) from bank_transactions b left join bank_accounts a on a.id = b.account_id
                              left join finance_classifications c on c.kind = 'bank' and c.txn_id = b.id
                              where b.amount_in > 0 and c.category_code is null
                              and not exists (select 1 from payments p where p.bank_transaction_id = b.id)
                              and (p_department is null or coalesce(c.department, a.department, 'gibier') = p_department)),
      'bank_out_unclassified', (select count(*) from bank_transactions b left join bank_accounts a on a.id = b.account_id
                              left join finance_classifications c on c.kind = 'bank' and c.txn_id = b.id
                              where b.amount_out > 0 and c.category_code is null
                              and (p_department is null or coalesce(c.department, a.department, 'gibier') = p_department)),
      'card_unclassified', (select count(*) from card_transactions t join finance_cards k on k.card_name = t.card_name
                              left join finance_classifications c on c.kind = 'card' and c.txn_id = t.id
                              where c.category_code is null and (p_department is null or coalesce(c.department, k.department) = p_department)),
      'receipts_pending', (select count(*) from receipts r where r.status = 'pending' and (p_department is null or coalesce(r.department, 'gibier') = p_department))),
    'last_import', (select jsonb_build_object('file_name', i.file_name, 'imported_at', i.imported_at, 'new_count', i.new_count, 'account', a.label)
                      from import_batches i left join bank_accounts a on a.id = i.account_id order by i.imported_at desc limit 1)
  );
end $$;

-- 銀行明細（期間・部門）。消込済みなら充てた請求書、分類があれば科目、領収書が紐づいていればその id
create or replace function public.finance_bank_list(p_key text, p_from date, p_to date, p_department text default null, p_account uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  perform finance_role(p_key);
  if not _fin_dept_ok(p_department) then raise exception '部門がありません: %', p_department; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', b.id, 'txn_date', b.txn_date, 'description', b.description, 'amount_in', b.amount_in, 'amount_out', b.amount_out, 'balance', b.balance,
      'account_id', b.account_id, 'account_label', a.label, 'account_department', a.department,
      'department', coalesce(c.department, a.department, 'gibier'), 'department_override', c.department,
      'category_code', c.category_code, 'memo', c.memo, 'classified_by', c.classified_by,
      'matched_docs', coalesce((select jsonb_agg(jsonb_build_object('doc_number', d.doc_number, 'customer_name', coalesce(cu.name, d.partner_name), 'amount', p.amount, 'fee', p.fee_amount, 'method', p.match_method))
                                  from payments p join documents d on d.id = p.document_id left join customers cu on cu.id = d.customer_id where p.bank_transaction_id = b.id), '[]'),
      'receipt_id', (select r.id from receipts r where r.bank_transaction_id = b.id and r.status <> 'rejected' limit 1))
      order by b.txn_date, b.row_no, b.created_at)
    from bank_transactions b left join bank_accounts a on a.id = b.account_id
    left join finance_classifications c on c.kind = 'bank' and c.txn_id = b.id
    where b.txn_date between p_from and p_to
      and (p_account is null or b.account_id = p_account)
      and (p_department is null or coalesce(c.department, a.department, 'gibier') = p_department)), '[]');
end $$;

-- カード明細（期間・部門）
create or replace function public.finance_card_list(p_key text, p_from date, p_to date, p_department text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  perform finance_role(p_key);
  if not _fin_dept_ok(p_department) then raise exception '部門がありません: %', p_department; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', t.id, 'txn_date', t.txn_date, 'description', t.description, 'amount', t.amount, 'card_name', t.card_name, 'card_label', k.label,
      'department', coalesce(c.department, k.department), 'department_override', c.department,
      'category_code', c.category_code, 'memo', c.memo, 'classified_by', c.classified_by,
      'receipt_id', (select r.id from receipts r where r.card_transaction_id = t.id and r.status <> 'rejected' limit 1))
      order by t.txn_date, t.row_no, t.created_at)
    from card_transactions t join finance_cards k on k.card_name = t.card_name
    left join finance_classifications c on c.kind = 'card' and c.txn_id = t.id
    where t.txn_date between p_from and p_to
      and (p_department is null or coalesce(c.department, k.department) = p_department)), '[]');
end $$;

-- 領収書の一覧（期間・状態・部門）
create or replace function public.finance_receipts_list(p_key text, p_from date default null, p_to date default null, p_status text default null, p_department text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  perform finance_role(p_key);
  if not _fin_dept_ok(p_department) then raise exception '部門がありません: %', p_department; end if;
  return coalesce((select jsonb_agg(to_jsonb(r) order by r.receipt_date desc nulls first, r.created_at desc) from receipts r
    where (p_from is null or r.receipt_date >= p_from) and (p_to is null or r.receipt_date <= p_to) and (p_status is null or r.status = p_status)
      and (p_department is null or coalesce(r.department, 'gibier') = p_department)), '[]');
end $$;

-- 領収書のファイル本体を出す（スタッフ・閲覧専用の両方）。{mime, base64, size_bytes}
create or replace function public.finance_receipt_file(p_key text, p_receipt uuid)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare f receipt_files%rowtype;
begin
  perform finance_role(p_key);
  select * into f from receipt_files where receipt_id = p_receipt;
  if not found then return jsonb_build_object('ok', false, 'reason', 'ファイルがありません'); end if;
  return jsonb_build_object('ok', true, 'mime', f.mime, 'size_bytes', f.size_bytes, 'base64', encode(f.content, 'base64'));
end $$;

-- 月次（仕訳・集計の材料をまとめて返す。計算は画面側の finance-core.js）
create or replace function public.finance_month(p_key text, p_month text, p_department text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_from date; v_to date;
begin
  perform finance_role(p_key);
  if p_month !~ '^\d{4}-\d{2}$' then raise exception '月は YYYY-MM'; end if;
  if not _fin_dept_ok(p_department) then raise exception '部門がありません: %', p_department; end if;
  v_from := (p_month || '-01')::date; v_to := (v_from + interval '1 month - 1 day')::date;
  return jsonb_build_object('month', p_month, 'department', p_department,
    'bank', finance_bank_list(p_key, v_from, v_to, p_department, null),
    'card', finance_card_list(p_key, v_from, v_to, p_department),
    'receipts', finance_receipts_list(p_key, v_from, v_to, null, p_department),
    'titles', finance_titles(p_key),
    'invoices', coalesce((select jsonb_agg(jsonb_build_object('doc_number', d.doc_number, 'customer_name', coalesce(c.name, d.partner_name), 'issue_date', d.issue_date, 'due_date', d.due_date,
                  'total', d.total_amount, 'tax', d.tax_amount, 'department', coalesce(d.department, c.department, 'gibier')) order by d.issue_date, d.doc_number)
                  from documents d left join customers c on c.id = d.customer_id
                 where d.doc_type = '請求書' and d.status = '発行済' and d.issue_date between v_from and v_to
                   and (p_department is null or coalesce(d.department, c.department, 'gibier') = p_department)), '[]'));
end $$;

-- ── 9. 書く（スタッフキーのみ）──
-- 部門の追加・名前の変更（code は変えない）
create or replace function public.staff_department_set(p_staff_key text, p_rows jsonb, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare n int := 0;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  insert into departments (code, name, short_name, sort, is_active, report_to)
  select x->>'code', x->>'name', x->>'short_name', coalesce((x->>'sort')::int, 100), coalesce((x->>'is_active')::boolean, true), x->>'report_to'
    from jsonb_array_elements(p_rows) x
   where coalesce(x->>'code','') ~ '^[a-z][a-z0-9_]*$' and coalesce(btrim(x->>'name'),'') <> ''
  on conflict (code) do update set name = excluded.name, short_name = excluded.short_name, sort = excluded.sort, is_active = excluded.is_active, report_to = excluded.report_to;
  get diagnostics n = row_count;
  insert into finance_events (kind, detail, created_by) values ('department', jsonb_build_object('rows', n), p_by);
  return jsonb_build_object('ok', true, 'count', n);
end $$;

-- 口座の登録（銀行名＋口座番号で1件。部門と呼び名を直せる）。返り値 {ok, id}
create or replace function public.staff_account_set(p_staff_key text, p_account jsonb, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_id uuid; v_dept text := p_account->>'department';
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if coalesce(btrim(p_account->>'bank_name'),'') = '' or coalesce(btrim(p_account->>'account_no'),'') = '' then raise exception '銀行名と口座番号は必要です'; end if;
  if coalesce(btrim(p_account->>'label'),'') = '' then raise exception '口座の呼び名を入れてください'; end if;
  if not exists (select 1 from departments where code = v_dept and is_active) then raise exception '部門を選んでください'; end if;
  insert into bank_accounts (bank_name, branch, account_type, account_no, label, department, is_active, created_by)
  values (btrim(p_account->>'bank_name'), nullif(btrim(p_account->>'branch'),''), nullif(btrim(p_account->>'account_type'),''), btrim(p_account->>'account_no'),
          btrim(p_account->>'label'), v_dept, coalesce((p_account->>'is_active')::boolean, true), p_by)
  on conflict (bank_name, account_no) do update set branch = excluded.branch, account_type = excluded.account_type, label = excluded.label,
    department = excluded.department, is_active = excluded.is_active
  returning id into v_id;
  insert into finance_events (kind, ref_id, detail, created_by) values ('account', v_id, p_account - 'account_no', p_by);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- カードの登録（カード名で1件。部門と呼び名）
create or replace function public.staff_card_set(p_staff_key text, p_card_name text, p_department text, p_label text default null, p_is_active boolean default true, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if coalesce(btrim(p_card_name),'') = '' then raise exception 'カード名がありません'; end if;
  if not exists (select 1 from departments where code = p_department and is_active) then raise exception '部門を選んでください'; end if;
  insert into finance_cards (card_name, label, department, is_active, created_by) values (btrim(p_card_name), nullif(btrim(p_label),''), p_department, coalesce(p_is_active, true), p_by)
  on conflict (card_name) do update set label = excluded.label, department = excluded.department, is_active = excluded.is_active;
  insert into finance_events (kind, detail, created_by) values ('card', jsonb_build_object('card', btrim(p_card_name), 'department', p_department), p_by);
  return jsonb_build_object('ok', true);
end $$;

-- 通帳の取込（口座を指定。プレビュー → 確定、重複は増えない、読めない行が1つでもあれば入れない）
-- 同じ内容でも口座が違えば別の明細（raw_hash に口座を含める）
create or replace function public.staff_bank_import(p_staff_key text, p_account uuid, p_file_name text, p_rows jsonb, p_commit boolean, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_acc bank_accounts%rowtype; v_prof uuid; v_bad jsonb; v_rows jsonb; v_total int; v_dup int; v_batch uuid; v_new int;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  select * into v_acc from bank_accounts where id = p_account;
  if not found then raise exception '口座を選んでください（設定で登録できます）'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception '明細がありません'; end if;
  select id into v_prof from bank_profiles where bank_name = v_acc.bank_name and kind = 'bank';
  select coalesce(jsonb_agg(r->'row_no'), '[]'::jsonb) into v_bad
    from jsonb_array_elements(p_rows) r
   where _recon_safe_date(r->>'txn_date') is null
      or coalesce(r->>'amount_in','0') !~ '^\d{1,9}$' or coalesce(r->>'amount_out','0') !~ '^\d{1,9}$'
      or (r->>'balance' is not null and r->>'balance' !~ '^-?\d{1,15}$')
      or (coalesce(r->>'amount_in','0') ~ '^0+$' and coalesce(r->>'amount_out','0') ~ '^0+$');
  if jsonb_array_length(v_bad) > 0 then
    return jsonb_build_object('ok', false, 'invalid_rows', v_bad, 'row_count', jsonb_array_length(p_rows));
  end if;
  -- 行を解釈し raw_hash（口座|日付|摘要|入金|出金|残高|同一行の出現順）を付ける。一時表は使わない（変数に持つ）
  select jsonb_agg(to_jsonb(h)) into v_rows from (
    select row_no, txn_date, description, amount_in, amount_out, balance,
           encode(digest(concat_ws('|', p_account, txn_date, description, amount_in, amount_out, coalesce(balance::text,''),
             row_number() over (partition by txn_date, description, amount_in, amount_out, balance order by row_no) - 1), 'sha256'), 'hex') raw_hash
      from (select (r->>'row_no')::int row_no, (r->>'txn_date')::date txn_date, btrim(coalesce(r->>'description','')) description,
                   coalesce((r->>'amount_in')::int,0) amount_in, coalesce((r->>'amount_out')::int,0) amount_out, (r->>'balance')::bigint balance
              from jsonb_array_elements(p_rows) r) s) h;
  v_total := jsonb_array_length(v_rows);
  select count(*) into v_dup from jsonb_array_elements(v_rows) x where exists (select 1 from bank_transactions b where b.raw_hash = x->>'raw_hash');
  if not p_commit then
    return jsonb_build_object('ok', true, 'preview', true, 'row_count', v_total, 'new_count', v_total - v_dup, 'dup_count', v_dup, 'account', v_acc.label);
  end if;
  insert into import_batches (file_name, bank_profile_id, account_id, row_count, new_count, dup_count, imported_by)
  values (p_file_name, v_prof, p_account, v_total, 0, v_dup, p_by) returning id into v_batch;
  insert into bank_transactions (txn_date, description, amount_in, amount_out, balance, raw_hash, import_batch_id, row_no, account_id)
  select (x->>'txn_date')::date, x->>'description', (x->>'amount_in')::int, (x->>'amount_out')::int, (x->>'balance')::bigint, x->>'raw_hash', v_batch, (x->>'row_no')::int, p_account
    from jsonb_array_elements(v_rows) x
  on conflict (raw_hash) do nothing;
  get diagnostics v_new = row_count;
  update import_batches set new_count = v_new, dup_count = v_total - v_new where id = v_batch;
  insert into recon_events (kind, detail, created_by) values ('import', jsonb_build_object('batch', v_batch, 'account', p_account, 'rows', v_total, 'new', v_new), p_by);
  return jsonb_build_object('ok', true, 'preview', false, 'batch_id', v_batch, 'row_count', v_total, 'new_count', v_new, 'dup_count', v_total - v_new, 'account', v_acc.label);
end $$;

-- カード明細の取込（カードは finance_cards に登録済みであること。未登録なら p_department を渡せばその場で登録）
create or replace function public.staff_card_import(p_staff_key text, p_card_name text, p_file_name text, p_rows jsonb, p_commit boolean, p_by text default null, p_department text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_prof uuid; v_bad jsonb; v_rows jsonb; v_total int; v_dup int; v_batch uuid; v_new int; v_card text := btrim(coalesce(p_card_name,''));
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if v_card = '' then raise exception 'カード名がありません'; end if;
  if not exists (select 1 from finance_cards where card_name = v_card) then
    if p_department is null then raise exception 'このカードの部門を選んでください（はじめての取込）'; end if;
    perform staff_card_set(p_staff_key, v_card, p_department, null, true, p_by);
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception '明細がありません'; end if;
  select id into v_prof from bank_profiles where bank_name = v_card and kind = 'card';
  select coalesce(jsonb_agg(r->'row_no'), '[]'::jsonb) into v_bad
    from jsonb_array_elements(p_rows) r
   where _recon_safe_date(r->>'txn_date') is null or coalesce(r->>'amount','') !~ '^-?\d{1,9}$' or coalesce(r->>'amount','0') ~ '^-?0+$';
  if jsonb_array_length(v_bad) > 0 then
    return jsonb_build_object('ok', false, 'invalid_rows', v_bad, 'row_count', jsonb_array_length(p_rows));
  end if;
  -- 行を解釈し raw_hash（カード名|日付|摘要|金額|同一行の出現順）を付ける。一時表は使わない（変数に持つ）
  select jsonb_agg(to_jsonb(h)) into v_rows from (
    select row_no, txn_date, description, amount,
           encode(digest(concat_ws('|', v_card, txn_date, description, amount,
             row_number() over (partition by txn_date, description, amount order by row_no) - 1), 'sha256'), 'hex') raw_hash
      from (select (r->>'row_no')::int row_no, (r->>'txn_date')::date txn_date, btrim(coalesce(r->>'description','')) description, (r->>'amount')::int amount
              from jsonb_array_elements(p_rows) r) s) h;
  v_total := jsonb_array_length(v_rows);
  select count(*) into v_dup from jsonb_array_elements(v_rows) x where exists (select 1 from card_transactions c where c.raw_hash = x->>'raw_hash');
  if not p_commit then
    return jsonb_build_object('ok', true, 'preview', true, 'row_count', v_total, 'new_count', v_total - v_dup, 'dup_count', v_dup);
  end if;
  insert into import_batches (file_name, bank_profile_id, row_count, new_count, dup_count, imported_by)
  values (p_file_name, v_prof, v_total, 0, v_dup, p_by) returning id into v_batch;
  insert into card_transactions (txn_date, description, amount, card_name, raw_hash, import_batch_id, row_no)
  select (x->>'txn_date')::date, x->>'description', (x->>'amount')::int, v_card, x->>'raw_hash', v_batch, (x->>'row_no')::int
    from jsonb_array_elements(v_rows) x
  on conflict (raw_hash) do nothing;
  get diagnostics v_new = row_count;
  update import_batches set new_count = v_new, dup_count = v_total - v_new where id = v_batch;
  insert into finance_events (kind, ref_id, detail, created_by) values ('card_import', v_batch, jsonb_build_object('card', v_card, 'rows', v_total, 'new', v_new), p_by);
  return jsonb_build_object('ok', true, 'preview', false, 'batch_id', v_batch, 'row_count', v_total, 'new_count', v_new, 'dup_count', v_total - v_new);
end $$;

-- 明細に勘定科目・メモ・部門を付ける（null で外す）。明細そのものは変えない
create or replace function public.staff_classify(p_staff_key text, p_kind text, p_txn uuid, p_category text, p_memo text default null, p_department text default null, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if p_kind not in ('bank','card') then raise exception 'kind は bank か card'; end if;
  if p_kind = 'bank' and not exists (select 1 from bank_transactions where id = p_txn) then raise exception '銀行明細が見つかりません'; end if;
  if p_kind = 'card' and not exists (select 1 from card_transactions where id = p_txn) then raise exception 'カード明細が見つかりません'; end if;
  if p_category is not null and not exists (select 1 from account_titles where code = p_category and is_active) then raise exception '勘定科目がありません: %', p_category; end if;
  if p_department is not null and not exists (select 1 from departments where code = p_department) then raise exception '部門がありません: %', p_department; end if;
  if p_category is null and coalesce(btrim(p_memo),'') = '' and p_department is null then
    delete from finance_classifications where kind = p_kind and txn_id = p_txn;
  else
    insert into finance_classifications (kind, txn_id, category_code, memo, department, classified_by)
    values (p_kind, p_txn, p_category, nullif(btrim(p_memo),''), p_department, p_by)
    on conflict (kind, txn_id) do update set category_code = excluded.category_code, memo = excluded.memo, department = excluded.department,
      classified_by = excluded.classified_by, classified_at = now();
  end if;
  insert into finance_events (kind, ref_id, detail, created_by) values ('classify', p_txn, jsonb_build_object('kind', p_kind, 'category', p_category, 'department', p_department), p_by);
  return jsonb_build_object('ok', true);
end $$;

-- 領収書の登録（本体は staff_receipt_file_put で後から入れる）。返り値 {ok, id}
create or replace function public.staff_receipt_add(p_staff_key text, p_receipt jsonb, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_id uuid; v_cat text := p_receipt->>'category_code'; v_dept text := p_receipt->>'department';
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if coalesce(p_receipt->>'file_name','') = '' and coalesce(p_receipt->>'vendor','') = '' then raise exception 'ファイルか店名のどちらかは必要です'; end if;
  if v_cat is not null and not exists (select 1 from account_titles where code = v_cat and is_active) then raise exception '勘定科目がありません: %', v_cat; end if;
  if v_dept is not null and not exists (select 1 from departments where code = v_dept) then raise exception '部門がありません: %', v_dept; end if;
  insert into receipts (receipt_date, vendor, amount, tax_rate, category_code, department, memo, file_name, mime, size_bytes, paid_by,
                        bank_transaction_id, card_transaction_id, uploaded_by)
  values (_recon_safe_date(p_receipt->>'receipt_date'), nullif(btrim(p_receipt->>'vendor'),''), (p_receipt->>'amount')::int, (p_receipt->>'tax_rate')::int, v_cat, v_dept,
          nullif(btrim(p_receipt->>'memo'),''), p_receipt->>'file_name', p_receipt->>'mime', (p_receipt->>'size_bytes')::int,
          p_receipt->>'paid_by', (p_receipt->>'bank_transaction_id')::uuid, (p_receipt->>'card_transaction_id')::uuid, p_by)
  returning id into v_id;
  insert into finance_events (kind, ref_id, detail, created_by) values ('receipt_add', v_id, p_receipt, p_by);
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

-- 領収書の更新（内容の訂正・明細との紐づけ・確認/却下）。渡した項目だけ変える
create or replace function public.staff_receipt_update(p_staff_key text, p_id uuid, p_patch jsonb, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare r receipts%rowtype; v_cat text; v_dept text;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  select * into r from receipts where id = p_id for update;
  if not found then raise exception '領収書が見つかりません'; end if;
  if p_patch ? 'category_code' then
    v_cat := p_patch->>'category_code';
    if v_cat is not null and not exists (select 1 from account_titles where code = v_cat and is_active) then raise exception '勘定科目がありません: %', v_cat; end if;
    r.category_code := v_cat;
  end if;
  if p_patch ? 'department' then
    v_dept := p_patch->>'department';
    if v_dept is not null and not exists (select 1 from departments where code = v_dept) then raise exception '部門がありません: %', v_dept; end if;
    r.department := v_dept;
  end if;
  if p_patch ? 'receipt_date' then r.receipt_date := _recon_safe_date(p_patch->>'receipt_date'); end if;
  if p_patch ? 'vendor' then r.vendor := nullif(btrim(p_patch->>'vendor'),''); end if;
  if p_patch ? 'amount' then r.amount := (p_patch->>'amount')::int; end if;
  if p_patch ? 'tax_rate' then r.tax_rate := (p_patch->>'tax_rate')::int; end if;
  if p_patch ? 'memo' then r.memo := nullif(btrim(p_patch->>'memo'),''); end if;
  if p_patch ? 'paid_by' then r.paid_by := p_patch->>'paid_by'; end if;
  if p_patch ? 'bank_transaction_id' then r.bank_transaction_id := (p_patch->>'bank_transaction_id')::uuid; end if;
  if p_patch ? 'card_transaction_id' then r.card_transaction_id := (p_patch->>'card_transaction_id')::uuid; end if;
  if p_patch ? 'status' then
    if p_patch->>'status' not in ('pending','confirmed','rejected') then raise exception '状態が正しくありません'; end if;
    r.status := p_patch->>'status';
    if r.status = 'confirmed' then r.confirmed_at := now(); r.confirmed_by := p_by; end if;
  end if;
  r.updated_at := now();
  update receipts set receipt_date = r.receipt_date, vendor = r.vendor, amount = r.amount, tax_rate = r.tax_rate, category_code = r.category_code, department = r.department, memo = r.memo,
    paid_by = r.paid_by, bank_transaction_id = r.bank_transaction_id, card_transaction_id = r.card_transaction_id, status = r.status,
    updated_at = r.updated_at, confirmed_at = r.confirmed_at, confirmed_by = r.confirmed_by where id = p_id;
  insert into finance_events (kind, ref_id, detail, created_by) values ('receipt_update', p_id, p_patch, p_by);
  return jsonb_build_object('ok', true);
end $$;

-- 領収書のファイルを入れる（base64）。同じ領収書に2回入れたら差し替え
create or replace function public.staff_receipt_file_put(p_staff_key text, p_receipt uuid, p_mime text, p_base64 text, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare v_bytes bytea;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  if not exists (select 1 from receipts where id = p_receipt) then raise exception '領収書が見つかりません'; end if;
  if p_mime not in ('image/jpeg','image/png','image/webp','application/pdf') then raise exception 'このファイルの種類は受け付けません: %', p_mime; end if;
  v_bytes := decode(p_base64, 'base64');
  if length(v_bytes) = 0 then raise exception 'ファイルが空です'; end if;
  if length(v_bytes) > 3145728 then raise exception 'ファイルが大きすぎます（3MBまで）: % bytes', length(v_bytes); end if;
  insert into receipt_files (receipt_id, mime, size_bytes, content, sha256) values (p_receipt, p_mime, length(v_bytes), v_bytes, encode(digest(v_bytes, 'sha256'), 'hex'))
    on conflict (receipt_id) do update set mime = excluded.mime, size_bytes = excluded.size_bytes, content = excluded.content, sha256 = excluded.sha256, created_at = now();
  update receipts set mime = p_mime, size_bytes = length(v_bytes), storage_path = 'db:receipt_files/' || p_receipt, updated_at = now() where id = p_receipt;
  insert into finance_events (kind, ref_id, detail, created_by) values ('receipt_file', p_receipt, jsonb_build_object('mime', p_mime, 'size', length(v_bytes)), p_by);
  return jsonb_build_object('ok', true, 'size_bytes', length(v_bytes));
end $$;

-- 勘定科目の名前・税率・並び・有効を直す（code は変えない。新しい code の追加もここ）
create or replace function public.staff_titles_set(p_staff_key text, p_rows jsonb, p_by text default null)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare n int := 0;
begin
  if not staff_key_ok(p_staff_key) then raise exception 'スタッフキーが違います'; end if;
  insert into account_titles (code, name, kind, tax_rate, sort, is_active, updated_by)
  select x->>'code', x->>'name', x->>'kind', coalesce((x->>'tax_rate')::int, 10), coalesce((x->>'sort')::int, 100), coalesce((x->>'is_active')::boolean, true), p_by
    from jsonb_array_elements(p_rows) x
   where coalesce(x->>'code','') ~ '^[a-z_]+\.[a-z0-9_]+$' and coalesce(btrim(x->>'name'),'') <> ''
  on conflict (code) do update set name = excluded.name, kind = excluded.kind, tax_rate = excluded.tax_rate, sort = excluded.sort,
    is_active = excluded.is_active, updated_at = now(), updated_by = excluded.updated_by;
  get diagnostics n = row_count;
  insert into finance_events (kind, detail, created_by) values ('titles', jsonb_build_object('rows', n), p_by);
  return jsonb_build_object('ok', true, 'count', n);
end $$;

revoke all on function public.admin_set_finance_viewer_key(text,text), public.finance_role(text), public.finance_viewer_header_ok(),
  public.finance_setup(text), public.finance_titles(text), public.finance_overview(text,text), public.staff_unpaid_list_any(text,date,text),
  public.finance_bank_list(text,date,date,text,uuid), public.finance_card_list(text,date,date,text), public.finance_receipts_list(text,date,date,text,text),
  public.finance_receipt_file(text,uuid), public.finance_month(text,text,text),
  public.staff_department_set(text,jsonb,text), public.staff_account_set(text,jsonb,text), public.staff_card_set(text,text,text,text,boolean,text),
  public.staff_bank_import(text,uuid,text,jsonb,boolean,text), public.staff_card_import(text,text,text,jsonb,boolean,text,text),
  public.staff_classify(text,text,uuid,text,text,text,text), public.staff_receipt_add(text,jsonb,text), public.staff_receipt_update(text,uuid,jsonb,text),
  public.staff_receipt_file_put(text,uuid,text,text,text), public.staff_titles_set(text,jsonb,text) from public;
grant execute on function public.admin_set_finance_viewer_key(text,text), public.finance_role(text), public.finance_viewer_header_ok(),
  public.finance_setup(text), public.finance_titles(text), public.finance_overview(text,text), public.staff_unpaid_list_any(text,date,text),
  public.finance_bank_list(text,date,date,text,uuid), public.finance_card_list(text,date,date,text), public.finance_receipts_list(text,date,date,text,text),
  public.finance_receipt_file(text,uuid), public.finance_month(text,text,text),
  public.staff_department_set(text,jsonb,text), public.staff_account_set(text,jsonb,text), public.staff_card_set(text,text,text,text,boolean,text),
  public.staff_bank_import(text,uuid,text,jsonb,boolean,text), public.staff_card_import(text,text,text,jsonb,boolean,text,text),
  public.staff_classify(text,text,uuid,text,text,text,text), public.staff_receipt_add(text,jsonb,text), public.staff_receipt_update(text,uuid,jsonb,text),
  public.staff_receipt_file_put(text,uuid,text,text,text), public.staff_titles_set(text,jsonb,text) to anon, authenticated;
