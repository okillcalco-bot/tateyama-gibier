-- 備品管理台帳（新規・追加のみ）
--
-- 参考: Google スプレッドシート「備品管理台帳（TGC）2025」（2026年2月4日現在）。
-- 「備品は3万円以上」を目安に、管理番号・備品名・在庫数・管理場所・購入日・購入金額・備考を持つ。
-- 台帳（管理者のみ）に「備品台帳」タブを置き、書類・帳票の「備品管理台帳」帳票と同じデータを使う。
-- 食品衛生法施行規則 別表17 三（設備等の衛生管理：機械器具の整備・温度計等の点検記録）の
-- 「何がどこにあるか」の台帳としても使う。

begin;

create table if not exists equipment (
  id            uuid primary key default gen_random_uuid(),
  mgmt_no       integer,                      -- 管理番号（台帳の No.）
  name          text not null,                -- 備品名
  qty           integer not null default 1,   -- 在庫数
  location      text,                         -- 管理場所（放血室/処理室/懸吊室/カット室/保管室/休憩室/屋外倉庫 等）
  purchased_on  text,                         -- 購入日（台帳どおり「令和3年10月」のような表記で持つ）
  price         integer,                      -- 購入金額（円）
  funding       text,                         -- 購入情報の補足（譲受け／館山市より借用／館山市予算で設置 等）
  note          text,                         -- 備考
  status        text not null default '使用中', -- 使用中 / 修理中 / 廃棄
  disposed_on   date,                         -- 廃棄・返却した日
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create unique index if not exists equipment_mgmt_no_idx on equipment (mgmt_no) where deleted_at is null and mgmt_no is not null;

alter table equipment enable row level security;
do $$
begin
  if not exists (select 1 from pg_policy where polname = 'allow_all' and polrelid = 'equipment'::regclass) then
    create policy allow_all on equipment for all using (true) with check (true);
  end if;
end $$;
grant select, insert, update, delete on equipment to anon, authenticated;

-- 初期データ: スプレッドシート「備品管理台帳（TGC）2025」の 22 行をそのまま移す（番号の抜け 4・8・21 も台帳どおり）
insert into equipment (mgmt_no, name, qty, location, purchased_on, price, funding, note)
select * from (values
  (1,  'レール',                     1, '放血室',   '令和3年10月', 1500000, null,               null),
  (2,  '電動チェーンブロック',       1, '放血室',   '令和3年12月',   87780, null,               null),
  (3,  '照明',                       1, '放血室',   '令和3年11月',    3795, null,               null),
  (5,  'クーラー',                   1, '処理室',   '令和3年11月',  140616, null,               null),
  (6,  '照明',                       1, '処理室',   '令和3年11月',    3795, null,               null),
  (7,  'ユニット冷蔵庫',             1, '懸吊室',   '令和3年12月', 1500000, null,               null),
  (9,  'スライサー',                 1, 'カット室', '令和3年12月',  100000, null,               'なるかポーク一式80万'),
  (10, 'ミンサー',                   1, 'カット室', '令和3年12月',  100000, null,               'なるかポーク一式80万'),
  (11, 'クーラー',                   1, 'カット室', '令和3年11月',  140616, null,               null),
  (12, '照明',                       1, 'カット室', '令和3年11月',    3795, null,               null),
  (13, '大型冷蔵冷凍庫1',            1, '保管室',   '令和3年12月',  150000, null,               'なるかポーク一式80万'),
  (14, '大型冷凍庫2',                1, '保管室',   '令和4年8月',   528000, null,               null),
  (15, '大型冷蔵冷凍庫3',            1, '保管室',   '令和3年12月',  150000, null,               'なるかポーク一式80万'),
  (16, '冷凍ストッカー1',            1, '保管室',   '令和4年9月',        0, '譲受け',           null),
  (17, '冷凍ストッカー2',            1, '保管室',   '令和5年6月',    50000, null,               'コメリ現金払い'),
  (18, '冷凍ストッカー（山さんが用）', 1, '保管室', '令和4年12月',  159800, null,               null),
  (19, '冷凍ストッカー（残渣用）',   1, '屋外倉庫', '令和5年8月',    72892, null,               null),
  (20, '金属検出機',                 1, '休憩室',   '令和3年12月',  460211, null,               null),
  (22, '真空包装機',                 1, 'カット室', null,             null, '館山市より借用',   null),
  (23, '冷凍庫1（ホシザキ）',        1, '保管室',   null,             null, '館山市より借用',   null),
  (24, 'ガス給湯器',                 2, null,       null,             null, '館山市予算で設置', null)
) as v(mgmt_no, name, qty, location, purchased_on, price, funding, note)
where not exists (select 1 from equipment e where e.mgmt_no = v.mgmt_no and e.deleted_at is null);

commit;
