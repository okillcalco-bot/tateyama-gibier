# 09. ジビエ基幹システム統合方針

## 現状

リポジトリルートの静的HTMLアプリ群（index.html, capture-form.html,
order-portal.html, punch.html 等）が **本番稼働中** のジビエ基幹システム。
Supabase プロジェクト（個体・捕獲者・スタッフ・勤怠・完成品在庫・受注・顧客）に
直接接続し、RLSは「有効化 + allow_all ポリシー」パターン。

主な既存テーブル:

| テーブル | 内容 |
|---|---|
| individuals | 個体（捕獲日・場所・獣種・体重・肉ランク・歩留まり・買取） |
| hunters | 捕獲者台帳（国産ジビエ認証様式対応） |
| staff / attendance | スタッフ・出退勤 |
| products / product_movements | 完成品マスタ・在庫移動ログ（append-only、source_ident_code でトレーサビリティ） |
| orders / customers | 受注・顧客 |
| area_master | 地区マスタ |

## 統合の原則

1. **現場を止めない。** 既存アプリ・既存テーブル・既存データは壊さない
2. 在庫はムーブメント（append-only）から算出する既存設計を維持する
3. トレーサビリティ（製品→個体）の連鎖を切らない
4. 統合は「共存 → 参照 → 統一」の3段階で進める

## Step 1: 共存（現状）

- ALCO OS と既存アプリが同一 Supabase プロジェクトを共有する
- ALCO OS の新テーブルは既存と名前衝突しない（本番DBで確認済み。
  既存: individuals/hunters/staff/attendance/shifts/products/product_movements/
  orders/order_items/customers/customer_prices/price_master/inventory/shipments/
  documents/report_docs/processing_log/cleaning_logs/supplies/freezers/
  data_flags/area_master/org_settings/secretary_pages/obara_lectures。
  このうち **documents が帳票用として既存**のため、ALCO OS の社内Wikiは
  knowledge_docs という名前にしている）
- 既存テーブルへの変更は既存側のマイグレーション（/migrations）でのみ行う

## Step 2: 参照（ダッシュボード統合）— 実施済み（0011）

- 読み取り専用ビュー `v_gibier_*` を追加済み:
  - v_gibier_intake_monthly: 月次捕獲頭数・重量・平均歩留まり（獣種別）
  - v_gibier_inventory: 完成品在庫スナップショット（products.stock_qty が正）
  - v_gibier_sales_monthly: 月次売上（orders。status別）
  - v_gibier_movements_monthly: 月次ムーブメント（完成/持ち出し/店頭販売/廃棄）
- ダッシュボードの「ジビエ基幹」カードは実数値表示に差し替え済み
  （今月の捕獲頭数・獣種内訳・在庫金額・今月売上・累計頭数）
- 残タスク: 音声メモの detected_category = gibier_operation を
  既存テーブルへの参照付きタスクに変換できるようにする

## Step 2.5: 運用統合（勤怠・シフト / 受注）— 実施済み（0013）

参照だけでなく、既存テーブルへの**行の読み書き**を ALCO OS が担う段階。
スキーマは一切変更しない（原則1）。書き込みは必ず domain サービス経由 +
audit_logs 記録。

| 対象 | 正となるテーブル | ALCO OS の役割 |
|---|---|---|
| シフト予定 | 既存 `shifts`（未使用だったものを正式採用） | /hr でパターン割当・上書き・削除（shift-service） |
| 打刻実績 | 既存 `attendance`（punch.html が書く） | 読み取り専用（予実比較・サマリー表示のみ） |
| シフトパターン・希望 | ALCO OS `shift_patterns` / `shift_requests`（0013） | HRMOS流のパターン管理・希望収集 |
| 受注 | 既存 `orders` / `order_items`（order-portal.html が insert） | /orders で status 更新のみ（order-service）。語彙は order-portal と同じ「受注/確認済/発送済/納品完了/キャンセル」で固定 |

注意:
- `shifts` は organization_id を持たない既存スキーマのまま使う。
  ALCO OS 側から organization_id を書き込まないこと
- orders の status に新しい語彙を勝手に足さない（order-portal.html の
  バッジ表示が壊れる）。増やすときは order-portal 側と同時に変更する

追加の共用ポイント（0014〜0018）:
- 帳票センター（/billing）と売上伝票（/ledger）の品目ピッカーは
  既存 `products`（完成品・在庫数）と `price_master`（部位単価3ランク）を
  **読み取り専用**で参照する。顧客の `price_rank` で単価を自動適用
- sales_slips.product_id で products への汎用参照（FKなし）を持つ。
  **在庫数量の増減は既存システム（product_movements）が正。
  ALCO OS から products.stock_qty を書き換えないこと**（二重減算防止）
- 帳票の発行者情報は既存 `org_settings` のキー（org_name / org_postal /
  org_address / org_phone / invoice_number）を共用し、org_bank_info を追加
- スタッフの役割は既存 `staff.role` を共有ボードの宛先として使う（値の更新のみ）
- 飲食店向けボード（/portal/board）は既存 `customers.portal_token` で認証する。
  order-portal.html は変更していない（リンクを置くのは任意・既存側の作業）

## Step 3: 統一（権限・データモデル）

- 既存テーブルに organization_id を追加（default で単一組織を埋める）
- allow_all ポリシーを段階的に `alco_add_member_policy` 相当へ移行
  （既存静的アプリが anon キーで動いている間は互換ポリシーを併存させる）
- 既存アプリの画面を ALCO OS の /gibier 配下へ段階移行
  （現場スタッフの習熟を優先し、機能単位で少しずつ）

## 注意

- 既存アプリは PWA としてルートから配信されている。
  リポジトリのルート構成を変えるとサービスワーカー（sw.js）や
  manifest.json が壊れる可能性があるため、alco-os/ ディレクトリ内で完結させること。
- 既存の staff / attendance を HR モジュールで置き換えない。
  データの正はあくまで既存テーブル側（shifts / attendance）に置き、
  ALCO OS はその上の管理UI（/hr, /orders）と SOP・チェックリストを担う。
