-- ============================================================
-- ALCO OS  0005: CRM（顧客・紹介・案件）モジュール
-- BNI / 同友会 / YEG / 行政 / 企業 / 飲食店 / 自然共生候補企業
-- ============================================================

-- 連絡先（人・会社の両方）
create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  contact_type text not null default 'person',   -- person / company / government
  name text not null,
  company_name text,
  title text,                                    -- 役職
  email text,
  phone text,
  address text,
  channel text,                                  -- BNI / 同友会 / YEG / 行政 / 紹介 / 飲食店 / その他
  referred_by_id uuid references contacts(id),   -- 紹介者
  tags text[],
  note text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- 面談・接触履歴（BNI 1to1 含む）
create table if not exists interactions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  contact_id uuid not null references contacts(id) on delete cascade,
  interaction_type text not null default 'meeting', -- meeting / 1to1 / call / email / event
  happened_at timestamptz not null,
  summary text,
  next_action text,
  next_action_due date,
  source_memo_id uuid references voice_memos(id),
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 案件（売上・協業・紹介につながる商談）
create table if not exists deals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  contact_id uuid references contacts(id),
  name text not null,
  deal_type text,                          -- gibier_sales / nature_consulting / grant_support / roka / other
  status text not null default 'lead',     -- lead / proposal / negotiation / won / lost / on_hold
  expected_amount numeric,
  probability integer,                     -- 0-100
  expected_close date,
  related_site_id uuid references sites(id),
  related_grant_project_id uuid references grant_projects(id),
  note text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- 紹介実績（BNIリファーラル等）
create table if not exists referrals (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  from_contact_id uuid references contacts(id),  -- 紹介してくれた人
  to_contact_id uuid references contacts(id),    -- 紹介された先
  direction text not null default 'received',    -- received / given
  referred_on date,
  outcome text,                                  -- 成約 / 商談中 / 見送り
  deal_id uuid references deals(id),
  note text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['contacts','interactions','deals','referrals']
  loop
    perform alco_add_member_policy(t);
    execute format('drop trigger if exists trg_%s_updated_at on %s', t, t);
    execute format('create trigger trg_%s_updated_at before update on %s
                    for each row execute function set_updated_at()', t, t);
  end loop;
end $$;

create index if not exists idx_interactions_contact on interactions (contact_id, happened_at desc);
create index if not exists idx_deals_org_status on deals (organization_id, status);

-- 前モジュールの汎用参照を確定
do $$ begin
  alter table voice_memos
    add constraint fk_voice_memos_contact foreign key (related_contact_id) references contacts(id);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table voice_memos
    add constraint fk_voice_memos_grant foreign key (related_grant_id) references grant_projects(id);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table sites
    add constraint fk_sites_client_contact foreign key (client_contact_id) references contacts(id);
exception when duplicate_object then null; end $$;
