-- ============================================================
-- ALCO OS  0026: 捕獲者の追加情報（B案 / 2026-07-26 確定）
--
-- 収集方針（B案）:
--   LINEでは口座を扱わない。「登録済みの方はお名前だけでOK」「口座は安全のため
--   LINEで送らないでください。担当者からご連絡します」と案内する。
--   口座は職員が電話・対面で聞き取り、ALCO OS から**既存 hunters の口座欄**へ入力する。
--
-- このテーブルが持つのは口座**以外**の追加情報:
--   生年月日 / 住所 / 電話 / 活動エリア / 従事者証の有無
--   （既存 hunters にも address / phone / trap_area はあるが、
--     既存アプリが書き換えるため、ALCO OS が集めた値はここに分けて保持し、
--     どちらが新しいかを職員が見比べられるようにする）
--
-- 絶対ルール:
-- - hunters のスキーマは変更しない。hunter_id は FKなしの汎用参照
-- - 口座情報はこのテーブルに入れない（二重管理を作らない）
-- - anon キーからは触れない（alco_add_member_policy = 認証済み組織メンバーのみ）
-- ============================================================

create table if not exists hunter_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id),
  hunter_id uuid not null,                 -- 既存 hunters(id) への汎用参照（FKなし）
  birth_date date,
  postal_code text,
  address text,
  phone text,
  activity_area text,                      -- 活動エリア（狩猟する地区）
  has_worker_card boolean,                 -- 従事者証の有無
  worker_card_number text,                 -- 従事者証番号（任意）
  note text,
  /** 情報をどこから得たか（hearing=聞き取り / csv=一括取込 / line=本人申告） */
  source text not null default 'hearing',
  collected_by uuid references profiles(id),
  collected_at timestamptz,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hunter_profiles_source_check
    check (source in ('hearing', 'csv', 'line'))
);

-- 1捕獲者につき1行
create unique index if not exists idx_hunter_profiles_hunter
  on hunter_profiles (hunter_id);

create index if not exists idx_hunter_profiles_org
  on hunter_profiles (organization_id, updated_at desc);

select alco_add_member_policy('hunter_profiles');

do $$
begin
  execute 'drop trigger if exists trg_hunter_profiles_updated_at on hunter_profiles';
  execute 'create trigger trg_hunter_profiles_updated_at before update on hunter_profiles
           for each row execute function set_updated_at()';
end $$;

comment on table hunter_profiles is
  '捕獲者の追加情報（生年月日・住所・電話・活動エリア・従事者証）。口座は入れない（既存 hunters の欄を使う）。0026';
