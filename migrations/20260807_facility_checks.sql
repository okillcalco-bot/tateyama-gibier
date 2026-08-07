-- 監査指摘への対応
--   「別紙２ジビエ処理作業チェック表内にて、不要なチェック項目(設備整備等)を削除し、
--     日、週、月ごとといったチェック表を再整備し、清掃履歴や衛生害虫駆除について
--     記入できるようにすること」
--   「日報はデータ管理、チェック内容に壁面、床面、排水桝を追加すること」
--
-- 既存の cleaning_logs は残す（今までの記録をそのまま参照できるようにするため）。
-- 追加のみ。

-- 日次・週次・月次の施設チェック
create table if not exists facility_check_logs (
  id uuid primary key default gen_random_uuid(),
  check_date date not null,
  cycle text not null,               -- '日' / '週' / '月'
  room text not null,                -- 放血室・処理室 など
  item text not null,                -- 壁面・床面・排水桝 など
  result text not null,              -- '可' / '要改善' / '未実施'
  value text,                        -- 庫内温度など数値の記録
  note text,                         -- 指摘事項
  staff_name text,
  created_at timestamptz default now()
);

create index if not exists facility_check_logs_date_idx on facility_check_logs (check_date desc, cycle);
create index if not exists facility_check_logs_room_idx on facility_check_logs (room, check_date desc);
-- 同じ日・同じ区分・同じ項目は1本にまとめる（打ち直しは上書き）
create unique index if not exists facility_check_logs_uniq
  on facility_check_logs (check_date, cycle, room, item);

alter table facility_check_logs enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='facility_check_logs' and policyname='allow_all') then
    create policy allow_all on facility_check_logs for all using (true) with check (true);
  end if;
end $$;

-- ねずみ・衛生害虫の駆除記録（年2回以上・記録の保存が必要）
create table if not exists pest_control_logs (
  id uuid primary key default gen_random_uuid(),
  done_on date not null,             -- 実施日
  method text,                       -- 方法（薬剤・粘着トラップ・業者施工 など）
  target text,                       -- 対象（ねずみ・ハエ・ゴキブリ など）
  area text,                         -- 実施場所
  vendor text,                       -- 実施業者（自社なら空欄）
  operator text,                     -- 実施者
  result text,                       -- 生息状況・結果
  measure text,                      -- 改善措置
  note text,
  created_at timestamptz default now()
);

create index if not exists pest_control_logs_date_idx on pest_control_logs (done_on desc);

alter table pest_control_logs enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='pest_control_logs' and policyname='allow_all') then
    create policy allow_all on pest_control_logs for all using (true) with check (true);
  end if;
end $$;
