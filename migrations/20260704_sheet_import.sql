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

-- ── 書類・帳票ハブ 2026-07-04 適用済み: report_docs_hub ──
-- report_docs: 帳票の承認フロー（下書き/作成済み/確認待ち/承認済み/差戻し、
--   作成者・承認者・日時・出力回数を記録＝監査証跡）
-- org_settings: 事業者設定（インボイス登録番号など）
-- documents: 税区分・支払方法・請求ステータス・取引先名カラムを追加

-- ── 打刻体調チェック・送り状 2026-07-04 適用済み: punch_health_and_waybill ──
-- attendance: health_in / health_out（出退勤時の体調。基本「異常なし」、異常時のみ内容記録）
-- org_settings: org_phone / org_postal（送り状のご依頼主情報）

-- ── 識別コードASCII化・精肉完了フラグ 2026-07-20 適用済み: ascii_ident_codes_and_processing_done ──
-- individuals.processing_done_at: 精肉完了フラグ（部位登録なしでも完了にできる）
-- inventory/processing_log: 識別コード・ロットコードのカタカナをローマ字化
--   （CODE128バーコードは英数字のみのため。ア→A/ウ→U/キ→KI/シ→SHI/タ→TA/ハ→HA）

-- ── シフト表・掲示板・新規顧客申込 2026-07-20 適用済み: staff_board_and_customer_signup ──
-- staff_board: スタッフ掲示板（title/body/author/pinned、ソフトデリート）
-- customers: signup_source（申込経路）/ order_method（希望注文方法）/ notify_method（案内方法）を追加
-- シフト表は既存 shifts テーブル（旧シフトアプリ）をそのまま利用

-- ── 二段階入力（捕獲者→スタッフ受入） 2026-07-20 適用済み: intake_status_two_stage_capture ──
-- individuals.intake_status: 捕獲者フォーム(?hunter=)からの仮登録は '搬入待ち'（label_id=仮-xxx）
-- スタッフが受入(capture-form.html?receive=id)で個体番号を付けると null に戻る

-- ── 市役所提出用捕獲票 2026-07-20 適用済み: city_capture_report_fields ──
-- individuals: body_length_cm / is_juvenile / trap_part（くくり罠のかかった部位）/
--   trap_set_date / trap_number（箱わな番号）/ bait_type / disposal_method / finisher_name

-- ── 捕獲場所の地図 2026-07-20 適用済み: capture_location_latlng ──
-- individuals: capture_lat / capture_lng（保存は数値のみ。地図は地理院タイルを表示時に参照）

-- ── 道の駅の店頭在庫 2026-07-20 適用済み: retail_outlets_consignment ──
-- retail_outlets: 委託販売先マスタ（グリーンファーム館山/とみうら・枇杷倶楽部/富楽里とみやま を初期投入、メール保持）
-- product_movements.destination: 納品先。店頭在庫 = 納品合計 − 店頭販売等の合計
