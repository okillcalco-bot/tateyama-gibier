-- 産廃搬出 最終チェック表（出発前）をスマホから記録する（新規・追加のみ）
--
-- 2026-09-10制定／9-11改訂の「産廃搬出ルール」で、出発前に紙の最終チェック表を
-- 記入して社内保管することになった。紙は廃棄用ストッカーに常備するが、
-- 搬出担当者がその場でスマホから残せるように、清掃記録(HACCP)の下に同じ10項目の
-- 入力欄を置き、その記録をここに残す。1項目でもOKでなければ搬出しない、が原則。

begin;

create table if not exists waste_checklists (
  id              uuid primary key default gen_random_uuid(),
  checked_on      date not null,                          -- 搬出日
  departure_time  text,                                   -- 出発時刻（HH:MM）
  staff_name      text not null,                          -- 搬出担当者
  vehicle         text,                                   -- 車両
  items           jsonb not null,                         -- [{no,text,ok}] 10項目
  all_ok          boolean not null,                       -- 全項目OK（=搬出可）
  correction_note text,                                   -- 是正した場合の内容
  created_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

create index if not exists waste_checklists_date_idx on waste_checklists (checked_on desc) where deleted_at is null;

alter table waste_checklists enable row level security;
do $$
begin
  if not exists (select 1 from pg_policy where polname = 'allow_all' and polrelid = 'waste_checklists'::regclass) then
    create policy allow_all on waste_checklists for all using (true) with check (true);
  end if;
end $$;
grant select, insert, update, delete on waste_checklists to anon, authenticated;

commit;
