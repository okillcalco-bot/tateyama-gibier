-- 打刻の押し忘れを本人が直せるようにする。誰がいつ何を直したかを残す
-- 既存テーブルは変更しない（追加のみ）

create table if not exists attendance_edits (
  id uuid primary key default gen_random_uuid(),
  attendance_id uuid,              -- 直した勤怠レコード
  staff_id uuid,
  staff_name text,
  work_date date not null,         -- どの日の記録を直したか
  -- 直す前
  before_in text,
  before_out text,
  before_break integer,
  -- 直した後
  after_in text,
  after_out text,
  after_break integer,
  reason text,                     -- 理由（押し忘れ・時刻ちがい など）
  edited_by text,                  -- '本人' / '管理者'
  editor_name text,                -- 直した人の名前
  created_at timestamptz default now()
);

create index if not exists attendance_edits_work_date_idx on attendance_edits (work_date desc);
create index if not exists attendance_edits_staff_idx on attendance_edits (staff_id, work_date desc);

alter table attendance_edits enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='attendance_edits' and policyname='allow_all') then
    create policy allow_all on attendance_edits for all using (true) with check (true);
  end if;
end $$;
