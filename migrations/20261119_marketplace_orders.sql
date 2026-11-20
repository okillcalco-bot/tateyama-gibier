-- 通販（さとふる・まいぷれのご当地ギフト・AWAWA! FOOD）の注文を載せる（新規・追加のみ）
--
-- きっかけ（2026-11-19 沖）
--   BASE の注文は出荷タブに出て、発送すると在庫から引かれる。ほかの通販はメールで届くだけで、
--   システムのどこにも載らず、出荷しても在庫が減らなかった。
--
-- 取り込み
--   Gmail の注文メールを Google Apps Script（integrations/marketplace-gmail/Code.gs）が読み、
--   このテーブルへ入れる。同じメールを二度入れないよう (source_message_id, line_no) で止める。
--
-- 個人情報は持たない
--   さとふる・まいぷれのメールには届け先が無い。AWAWA のメールには届け先の名前・住所・電話があるが、
--   取り込みの時点で捨てる（商品・数・金額・日付・伝票番号だけ）。
--   認可（権限）の移行が終わるまで、新しい注文個人情報は取り込まない（沖の方針）。
--
-- 在庫の引き方
--   通販の商品（セット）→ 加工品の棚（products）の対応を marketplace_item_map に持ち、
--   出荷のときに「商品の数 × 対応の数」だけ products.stock_qty を引く（BASE と同じやり方）。

begin;

create table if not exists marketplace_orders (
  id                uuid primary key default gen_random_uuid(),
  platform          text not null,                 -- さとふる / まいぷれ / AWAWA
  source_message_id text not null,                 -- 元メールの ID（重複取り込み防止）
  line_no           integer not null default 1,    -- 1通に複数の商品があるときの行番号
  received_at       timestamptz,                   -- メールの受信日時
  external_order_no text,                          -- さとふる: 寄付受付番号 など
  item_code         text,                          -- さとふる: お礼品ID / まいぷれ: 商品番号 / AWAWA: 商品名
  item_name         text not null,
  item_detail       text,                          -- 部位・内容など（AWAWA の「部位：ロース(170g)」、まいぷれの商品内容）
  qty               integer not null check (qty > 0),
  amount            integer,                       -- 販売金額（分かるものだけ。AWAWA）
  pickup_date       date,                          -- 集荷予定日
  carrier           text,
  delivery_class    text,                          -- クール便（冷凍便）など
  tracking_nos      text,                          -- 伝票番号（カンマ区切り）
  status            text not null default '未出荷',
  shipped_at        timestamptz,
  shipped_by        text,
  order_id          uuid,                          -- 出荷したときに作る orders の行
  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  constraint marketplace_orders_platform_ck check (platform in ('さとふる','まいぷれ','AWAWA')),
  constraint marketplace_orders_status_ck check (status in ('未出荷','出荷済','取消'))
);

create unique index if not exists marketplace_orders_src_uidx
  on marketplace_orders (source_message_id, line_no);
create index if not exists marketplace_orders_open_idx
  on marketplace_orders (pickup_date) where deleted_at is null and status = '未出荷';

-- 通販の商品 → 加工品の棚（何を何袋使うか）。1つの商品に複数行（セットの中身）
create table if not exists marketplace_item_map (
  id          uuid primary key default gen_random_uuid(),
  platform    text not null,
  item_code   text not null,                       -- marketplace_orders.item_code と同じ値
  item_name   text,
  product_id  uuid not null references products(id),
  qty         integer not null default 1 check (qty > 0),
  note        text,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists marketplace_item_map_key_idx
  on marketplace_item_map (platform, item_code) where deleted_at is null;

alter table marketplace_orders enable row level security;
alter table marketplace_item_map enable row level security;
do $$
begin
  if not exists (select 1 from pg_policy where polname = 'allow_all' and polrelid = 'marketplace_orders'::regclass) then
    create policy allow_all on marketplace_orders for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policy where polname = 'allow_all' and polrelid = 'marketplace_item_map'::regclass) then
    create policy allow_all on marketplace_item_map for all using (true) with check (true);
  end if;
end $$;
grant select, insert, update on marketplace_orders to anon, authenticated;
grant select, insert, update on marketplace_item_map to anon, authenticated;

-- 分かっている対応（まいぷれ「館山ジビエ2種セット」= 味付け肉 塩ニンニク250g×1 + 山さんが210g×1）
insert into marketplace_item_map (platform, item_code, item_name, product_id, qty, note)
select 'まいぷれ', '1004297', '館山ジビエ2種セット', p.id, 1, '出荷依頼メールの商品内容より（2026-11-19）'
from products p
where p.deleted_at is null and p.name in ('味付け肉 塩ニンニク 250g', '味付けミンチ 山さんが 210g')
  and not exists (select 1 from marketplace_item_map m where m.platform = 'まいぷれ' and m.item_code = '1004297' and m.product_id = p.id and m.deleted_at is null);

commit;
