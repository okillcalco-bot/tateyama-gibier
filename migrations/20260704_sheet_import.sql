-- 台帳スプレッドシート取込の下地（2026-07-04 適用済み: sheet_import_groundwork）
-- 「イノシシの搬入・処理管理台帳（令和8年度）」の構成に対応。追加のみ・既存データ無変更。

-- 個体: 放血場所・買取関連（歩留まり買取の将来実装用。シートの見出しに対応）
alter table individuals add column if not exists bleed_location text;   -- 放血場所
alter table individuals add column if not exists meat_rank text;        -- 肉ランク
alter table individuals add column if not exists yield_rate numeric;    -- 歩留まり(%)
alter table individuals add column if not exists buyback_base text;     -- 買取価格ベース
alter table individuals add column if not exists buyback_amount numeric;-- 買取価格
alter table individuals add column if not exists purchase_payee text;   -- 買取料金支払先（捕獲者と異なる場合）
alter table individuals add column if not exists image_url text;        -- 画像URL

-- 捕獲者台帳: 公式台帳（国産ジビエ認証様式）の項目
alter table hunters add column if not exists registry_number text;      -- 台帳番号
alter table hunters add column if not exists registered_on date;        -- 登録年月日
alter table hunters add column if not exists document_type text;        -- 許可証/従事者証/狩猟者登録証
alter table hunters add column if not exists has_gun boolean default false;

-- 地区マスタ（市 → 地区・旧町村 → 現住所表記 のボタン選択用）
create table if not exists area_master (
  id uuid primary key default gen_random_uuid(),
  city text not null,        -- 館山市 / 南房総市
  district text,             -- 地区・旧町村（例: 豊房 / 和田町）
  district_note text,        -- 旧町村等の補足
  oaza text,                 -- 大字（例: 南条）
  address_label text unique, -- 現住所表記（例: 館山市南条）
  yomi text,
  sort_order integer,
  created_at timestamptz default now()
);
alter table area_master enable row level security;
do $$ begin
  create policy allow_all on area_master for all using (true) with check (true);
exception when duplicate_object then null; end $$;

-- ── データ取込（2026-07-04 実施済み）──
-- ・individuals: シート「生データ」(イノシシ247頭) + 「イノシシ以外データ」(90頭) を
--   label_id で upsert（既存レコードはシートの内容で上書き）
-- ・hunters: シート「捕獲者台帳」206名を全入替（delete → insert。逝去/返納はmemoに記録）
-- ・area_master: シート「地区マスタ」190件を投入
-- ・テストデータ: 個体 TGC-TEST-01 / TGC-TEST-02、注文 TEST-001（練習用・削除可）
-- 取込スクリプト: セッション内 parse_sheets.py（令和→西暦変換、午前/午後→24h変換、
-- 捕獲場所を市/大字に分割、捕獲方法の表記統一: 括り→くくり罠 / 檻→箱罠 / 銃→銃猟）

-- ── 加工処理（完成品在庫）2026-07-04 適用済み: processed_products ──
-- products: 完成品マスタ（小売/卸売、BASE連携用のbase_item_id/base_url付き）
-- product_movements: 完成/持ち出し/店頭販売/廃棄/棚卸調整のログ
--   （source_ident_code で原料の精肉識別コードと紐付け＝トレーサビリティ）
-- シード: BASEショップの食品系10商品（革製品は除外）
-- スタッフ: 今泉貴雄・吉田友美 を追加
