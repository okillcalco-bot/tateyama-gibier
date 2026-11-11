# 現行システム仕様確認書（2026-10-04・b1bcd6b）の指摘の検証

- 確認日: 2026-10-18
- 対象: main `8769cbf`（仕様確認書の対象 `b1bcd6b` から34コミット後）
- 本番の静的ファイル（index.html / order-admin.html / order.html / s.html / capture-form.html / sw.js）は `8769cbf` とバイト一致（md5 で照合）
- 本番DBの関数は、確認した範囲ではこのリポジトリの migrations と一致（`portal_issue_document` / `staff_register_customer_on_ship` / `tgc_assign_individual_number` / `admin_set_order_status` / `release_allocations_for_order`）

**このファイルは公開リポジトリに置くため、本番データの件数・金額・顧客情報は載せない。** 本番での実測値は非公開の検証資料に分ける。

## 分類の意味

| 区分 | 意味 |
|---|---|
| 再現 | 現在の main で、テストまたはロールバック付きSQLで症状を確認した |
| 既修正 | b1bcd6b 以降のコミットで直っており、テストがある |
| 非該当 | 指摘の前提が成り立たない |
| 未検証 | まだ再現手順を作っていない |
| 要判断 | コードの不具合ではなく、業務の決め方が先に要る |

## 在庫（仕様確認書 第6節・第10節）

| # | 指摘 | 区分 | 根拠 |
|---|---|---|---|
| I1 | 在庫一覧は200件取得後に獣種で絞る | **再現**（指摘より広い） | `index.html` `loadInventory`。さらに `sbPaged` は limit の無い GET を1000行で打ち切る（PostgREST の max-rows）ため、`loadDashboard`・`loadSyncStatus`・出荷の手動割当候補なども1000行で切れる。加工パック（tier 3）は個体番号を持たないため、獣種が「-」になり絞り込みで消える。→ PR1 |
| I2 | スキャン引当は `inventory_allocations` を作らず、取消は allocations 経由で在庫を戻す | **再現** | `index.html` `shipAssignPackToItem` は `order_items.inventory_id` だけを書く。`release_allocations_for_order`（migrations/20260809_portal_allocations.sql）と `admin_set_order_status`（migrations/20260810_phase3_hardening.sql）は allocations だけを見る。→ PR3（DB関数の追加変更・本番適用は別承認） |
| I3 | 加工の小売SKU選択で `products.stock_qty` と inventory パックの二重表現 | **再現**・**要判断** | `index.html` 加工完成で両方を加算。BASE発送・店舗出庫は `stock_qty` だけ、注文スキャンはパックだけを減らす。月末棚卸は両方を数える。どちらを正本にするか業務判断が要る |

## 受発注・請求・入金（第10節）

| # | 指摘 | 区分 | 根拠 |
|---|---|---|---|
| B1 | 手入力注文はヘッダーと明細を別POST | **再現** | `order-admin.html` `submitManualOrder` |
| B2 | 出荷確定・直販は逐次更新でトランザクションなし | **再現** | `index.html` `recordDirectShipment` / `recordFulfillOrders` / `shipOrderConfirmed`。明細POSTを失敗させると、明細の無い「発送済」注文が残る（モックで再現） |
| B3 | 希望kgの概算を実重量・確定額に更新する処理がない | **既修正**（残り小） | #361（10/06）`shipAssignPackToItem` で割当時に実重量・金額を確定。テスト `ship-split-by-weight`。確定時のドロップダウン割当経路だけ重量を更新しない |
| B4 | 単価未設定の部位を0円相当で記録 | **再現** | `index.html` `recordDirectShipment`：単価なしで `unit_price=null`。警告は保存後の toast だけ |
| B5 | 顧客登録に失敗しても顧客IDなしで出荷を続行 | **一部再現** | RPC の同名処理は意図どおり。UI `index.html` `recordDirectShipment` が登録失敗後も続行する |
| B6 | 管理帳票は先頭発送1件の送料、ポータル帳票は全発送を合算 | **再現** | `order-admin.html` `generateDoc` / `invBuildLinesFromOrders` が `shipments[0]`。`portal_issue_document` は `sum(freight)` |
| B7 | 請求書のヘッダー・明細・紐付けが別リクエストで、失敗しても印刷へ進む | **再現** | `order-admin.html` `invIssue` |
| B8 | 注文取込が現在の価格マスタで再計算する | **既修正** | #364/#365（10/06）`invBuildLinesFromOrders` は記録済み subtotal を使い、価格マスタで補うのは金額0の旧行だけ。テスト `invoice-pull-grouping` |
| B9 | 入金は payments 追加と状態更新が別、過入金を拒否しない | **再現** | `order-admin.html` `invRecordPayment` |
| B10 | ポータルは入金確認なしで領収書を発行、発行履歴にスナップショットなし | **再現** | `portal_issue_document`、`portal_document_issues` |
| B11 | ALCO OS の帳票は別台帳で送料を取得しない | **再現** | `alco-os/src/domain/billing/billing-service.ts` |
| B12 | 管理画面と顧客画面で同じ注文の金額が一致するか | **再現**（1円単位のずれ） | 管理: 税込明細を税抜へ戻して税率別に切捨て（`invCalcLines`）。顧客: 税込合計から内税を四捨五入（`order.html`）。ALCO OS: 内税を切捨て |

## 個体・採番・系譜（第3〜5節）

| # | 指摘 | 区分 | 根拠 |
|---|---|---|---|
| N1 | 採番・プレビューが `TGC-08-` 固定、イノシシ通し番号の最大値に年度条件なし | **再現**（期限: 2027-04-01） | `tgc_assign_individual_number`（migrations/20261005_kujogai_no_serial.sql）。ロールバック付きSQLで捕獲日2027-04-05を登録すると `TGC-08-` のまま前年度の続き番号になる。`capture-form.html` のプレビューは `label_id.desc` の文字列順のため番号1000で順序が壊れる |
| N2 | 削除後の番号再利用は恒久的な非再利用ではない | **再現** | 末尾を削除すると再利用、途中を削除すると欠番のまま（ロールバック付きSQLで確認）。手入力・番号変更の経路は履歴が残らない |
| N3 | 採番競合 | **非該当**（トリガ経路） | `pg_advisory_xact_lock` で接頭辞とイノシシ共通をロックしてから最大値を数える。手入力経路は一意制約で止まる |
| N4 | 二重送信 | **再現** | 一回限りの仕組みは個体の `submit_ref` とポータル注文の `client_request_id` だけ。精肉登録（`pmRequestRegister`）・直販出荷はモックで2回分のPOSTを確認 |
| N5 | 途中失敗で在庫を巻き戻さずラベルへ進む | **再現** | 精肉で `processing_log` の POST が失敗すると在庫行は残り、画面は「在庫に登録できませんでした」と誤表示、再試行でもう1行できる。加工・骨/内臓ロットは警告のみ |
| N6 | 権限確認と操作履歴 | **再現** | 業務の書き込みは公開キーでテーブルへ直接。在庫・加工ログ・出荷・入金は条件なしの書込ポリシー。監査トリガなし。セキュリティ是正は Draft PR #393（本番未適用）で別途進行中 |
| P1 | 地区代表点の変更で過去個体の参考地点が変わる | **未検証**（要判断） | `tgc_capture_point` は閲覧時に `area_master` を引く。固定するか参考値とするかは業務判断 |
| P2 | 捕獲者名が文字列キー | **再現**（設計） | `individuals.hunter_name` は文字列。マスタとの不一致あり |

## 公開・バックアップ（第8・10節）

| # | 指摘 | 区分 | 根拠 |
|---|---|---|---|
| V1 | 声の投稿は即時掲載、管理画面コメントは「承認してから公開」 | **再現**・**要判断** | 本番の `story_add_voice` / `story_add_voice_individual` / `story_add_voice_menu` は `published_at=now()` |
| K1 | アプリのCSV出力だけでは復元できない | **再現** | `index.html` `CSV_TABLES` は12表のみ。請求・入金・顧客・価格・物販在庫・写真（Storage）を含まない。`manual-app.html` の月次手順は対象表の一覧がない |
| K2 | 自動バックアップ・PITR | **未検証** | SQL からは確認できない。Supabase の管理画面で要確認 |

## 進め方（PRの順番）

| PR | 内容 | DB変更 | 状態 |
|---|---|---|---|
| PR0 | この分類表 | なし | — |
| PR1 | 件数・合計を全件から出す（I1） | なし | 作成 |
| PR2 | 直販・精肉の失敗を画面に出し、二重送信を止める（B4・B5・N4・N5 のうち画面側で直せる分） | なし | 予定 |
| PR3 | 取消で在庫を戻す（I2） | 追加のみの関数変更（本番適用は別承認） | 予定 |
| PR4 | 帳票の送料を全発送で合算、請求書発行の途中失敗で印刷へ進まない（B6・B7） | なし | 予定 |
| PR5 | 精肉登録を1つのRPCにまとめる（一回限り・権限・履歴）（N4・N5・N6） | 追加のみ（本番適用は別承認） | 案 |
| PR6 | 年度切替の採番（N1） | 関数の置き換え（本番適用は別承認） | 案・2027-04 までに |

業務の判断が必要なもの: I3（物販在庫の正本）、B12（税の丸め方をどれに揃えるか）、V1（声の公開方式）、P1（地区代表点）、B10（領収書の発行条件）。
