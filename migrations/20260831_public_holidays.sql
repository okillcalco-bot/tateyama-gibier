-- 祝祭日を持つ（追加のみ）
--
-- 月給制のスタッフは「所定の曜日は定時で出勤」として勤怠を入れる。
--   沖浩志   毎日 8:30-17:30（休憩60分）
--   田口和利 水・土日・祝祭日以外 8:30-17:30（休憩60分）
-- 田口の条件に祝祭日が入るので、どこかに祝日の一覧が要る。
-- コードに日付を埋めると毎年直すことになるので、表で持つ。
--
-- ここに入れているのは令和8年度（2026-04-01 〜 2027-03-31）ぶん。
-- 内閣府の「国民の祝日」に基づく。振替休日も1行として入れる。
-- 年度が変わる前に次の年度を足すこと。

begin;

create table if not exists public_holidays (
  holiday_date date primary key,
  name         text not null,
  note         text,
  created_at   timestamptz not null default now()
);

alter table public_holidays enable row level security;
do $$
begin
  if not exists (select 1 from pg_policy where polname = 'allow_all' and polrelid = 'public_holidays'::regclass) then
    create policy allow_all on public_holidays for all using (true) with check (true);
  end if;
end $$;
grant select, insert, update, delete on public_holidays to anon, authenticated;

insert into public_holidays (holiday_date, name) values
  ('2026-04-29','昭和の日'),
  ('2026-05-03','憲法記念日'),
  ('2026-05-04','みどりの日'),
  ('2026-05-05','こどもの日'),
  ('2026-05-06','振替休日'),
  ('2026-07-20','海の日'),
  ('2026-08-11','山の日'),
  ('2026-09-21','敬老の日'),
  ('2026-09-22','国民の休日'),
  ('2026-09-23','秋分の日'),
  ('2026-10-12','スポーツの日'),
  ('2026-11-03','文化の日'),
  ('2026-11-23','勤労感謝の日'),
  ('2027-01-01','元日'),
  ('2027-01-11','成人の日'),
  ('2027-02-11','建国記念の日'),
  ('2027-02-23','天皇誕生日'),
  ('2027-03-21','春分の日'),
  ('2027-03-22','振替休日')
on conflict (holiday_date) do nothing;

commit;
