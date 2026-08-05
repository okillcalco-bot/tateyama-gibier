# ALCO OS ギャップ分析 — 「捕獲個体IDを中心につなぐ」長期構想

作成: 2026-08-02 / 対象コミット: `68ea7e8`（main）/ 本番DB: `clpdyrehdgzgiidbfucj`
状態: **調査のみ。コード変更なし。実装は承認後。**

この文書は、長期構想（捕獲連絡 → 止め刺し・引取 → 受入 → 解体 → 在庫 → 受発注 →
販売 → 買取・行政申請 → 自然環境データ → TNFD）を、既存実装と突き合わせた結果である。
**一括実装はしない。** 小さく実装・検証できる単位に割り、優先順位をつける。

---

## 1. 現行システム構成図

```
┌─────────────────────── 現場・外部 ───────────────────────┐
│ 捕獲者(206名) ──LINE──▶ @889alcvb                        │
│ 飲食店 ──────────────▶ order-portal.html / /portal/board │
│ 一般 ────────────────▶ /support/[slug], /guide          │
└───────────────┬──────────────────────┬──────────────────┘
                │                      │
   ┌────────────▼───────────┐  ┌───────▼─────────────────────────┐
   │ ジビエ基幹（静的HTML）  │  │ ALCO OS（Next.js / Vercel）      │
   │ 本番稼働・壊さない       │  │ /line /gibier/reports /hunters  │
   │ index.html   個体台帳   │  │ /orders /billing /ledger        │
   │ capture-form 捕獲票     │  │ /nature /nature/quick /gaps     │
   │ order-portal 受注       │  │ /crosspost /social /media       │
   │ punch.html   打刻       │  │ /drafts 承認センター             │
   │ capture-report 一覧     │  │ /manual /guide                  │
   └────────────┬───────────┘  └───────┬─────────────────────────┘
                │ anonキーで直接        │ RLS + service_role
                │ （※6章の重大論点）    │
                └───────────┬───────────┘
                            ▼
        ┌──────────────────────────────────────────┐
        │ Supabase PostgreSQL（1プロジェクト共有）  │
        │ 既存ジビエ系 + ALCO OS系（0001〜0029）    │
        └──────────────────────────────────────────┘
```

**重要**: 2世代のシステムが**同じDBを共有**している。ジビエ基幹は anon キーで直接
DBを叩き、ALCO OS は RLS とサーバーアクションを通す。この非対称が6章の中心論点。

---

## 2. 既存DBテーブル一覧と関係

### 2-1. 既存ジビエ基幹系（ALCO OS はスキーマ変更禁止）

| テーブル | 行数 | 役割 | 個体との関係 |
|---|---:|---|---|
| `individuals` | **511** | 捕獲個体台帳（中核） | **本体**。`id`(uuid) / `label_id`(TGC-08-T239) / `serial_number`(394) |
| `inventory` | **135** | 部位在庫（枝肉→部位→小分け） | `individual_id`(**text**=label_id) / `individual_code`(text) / `ident_code`(TGC-08-T001-RO-10) / `parent_inventory_id`(uuid) / `tier` |
| `processing_log` | **111** | 解体・分割の履歴 | `parent_ident_code` → `child_ident_code`。`individual_id`(text) は**全行null** |
| `products` | 30 | 完成品マスタ | `stock_qty` が在庫の正 |
| `product_movements` | **230** | 完成品の入出庫 | `source_ident_code`(text) で inventory に紐づく |
| `orders` / `order_items` | 3 / 8 | 受注 | `order_items.inventory_id`(uuid) → inventory |
| `shipments` | 3 | 出荷 | `order_id` |
| `documents` / `document_items` / `payments` | 0 | 請求書・入金（旧系） | `customer_id` / `order_id` |
| `customers` / `customer_prices` / `customer_levels` | 0 | 顧客・価格ランク | — |
| `price_master` | **59** | 部位単価（5ランク） | species × part_name |
| `hunters` | 206 | 捕獲者（口座含む） | `individuals.hunter_name`(**text**) で緩く紐づく |
| `retail_outlets` / `freezers` / `supplies` / `cleaning_logs` / `staff` / `attendance` / `shifts` | 少 | 販売所・冷凍庫・備品・清掃・人 | — |
| `report_docs` | 1 | 行政提出帳票の状態（承認あり） | `doc_key` × `period` |
| `data_flags` / `app_settings` / `base_config` / `base_tokens` / `secretary_pages` | 少 | 運用フラグ・設定 | — |

### 2-2. ALCO OS 系（0001〜0028 適用済み。**0029 は未適用**）

| 群 | 主テーブル |
|---|---|
| 基盤 | `organizations` `profiles` `roles` `user_roles` `tasks` `files` `ai_runs` `audit_logs` `generated_drafts` |
| 捕獲者LINE | `hunter_line_links`(11) `line_webhook_events`(91) `line_inbound_messages`(75) `line_outbound_messages` `line_conversation_states` `line_channel_registry` `line_staff_groups` `hunter_profiles` |
| 捕獲報告 | **`capture_reports`(3)** `capture_report_photos`(5) |
| 自然・里山 | `sites` `survey_points` `field_surveys` `biodiversity_observations` `management_actions` `taxa` `evidence` `ecological_interactions` `survey_campaigns` `survey_tasks` |
| 応援 | `supporters` `support_pledges` `quest_payouts` `achievement_grants` |
| 業務 | `billing_documents` `sales_slips` `advisor_consultations` `board_posts` `social_projects` `media_projects` `grant_*` `contacts` `deals` `projects` `sops` `checklists` `knowledge_docs` |
| 未適用(0029) | `social_sources` `social_channel_drafts` ほか6テーブル |

### 2-3. 現在つながっている経路（実線）と切れている経路（点線）

```
捕獲者LINE ──▶ capture_reports ──承認──▶ individuals ──?──▶ inventory
 (hunter_line_links)   (uuid FK)    (uuid)   (text: label_id)  │
                                                              ▼
individuals ‥‥‥‥‥‥‥‥‥‥‥‥‥‥‥ processing_log（individual_id 全null）
     │                                            │ (ident_code の親子のみ)
     │                                            ▼
     │                                       inventory ──▶ order_items ──▶ orders
     │                                            │            (uuid FK)
     │                                            ▼
     │                                    product_movements（source_ident_code:text）
     │
     ├──▶ 買取: individuals.buyback_amount（**支払台帳なし**）
     ├──‥‥ 行政: capture-form.html?cityform=label_id（別アプリ・手動）
     └──‥‥ 自然環境: capture_lat/lng はあるが biodiversity_observations と**無関係**
```

---

## 3. 構想 × 実装状況

| # | 構想領域 | 判定 | 実装の実体 | 重複実装の危険 |
|---|---|---|---|---|
| 1 | 捕獲者向けLINE受付 | **実装済み** | `/api/line`（チャネル識別・署名検証・冪等）、`/line`（職員チャット）、`/guide`。0021〜0028 | **高**: 新しいLINE受け口を作らないこと。分岐は既存 `hunter-keywords.ts` に足す |
| 2 | 捕獲個体台帳 | **実装済み（既存側）** | `individuals`(511) + index.html / capture-form.html | **高**: ALCO OS に個体台帳を再実装しない。参照のみ |
| 3 | 受入・食用可否判定 | **一部実装** | capture-form.html に「食用不可」トグル・放血90分超過アラート・`individuals.quality`。ALCO OS 側は `intake_status='搬入待ち'` の仮登録まで | 中: 判定ロジックを2箇所に持つと矛盾する |
| 4 | 解体・部位・歩留まり | **一部実装** | `inventory`(tier/parent_inventory_id) `processing_log`(親子ident_code) `individuals.yield_rate`。**ALCO OS 側は未実装** | 低 |
| 5 | 在庫 | **一部実装** | 2系統: 部位在庫`inventory` と 完成品`products.stock_qty`+`product_movements`。ALCO OS は**読み取り専用**（`gibier-catalog.ts` / `v_gibier_inventory`） | **高**: ALCO OS から stock_qty を書かない（docs/09 の不変条件） |
| 6 | 受注・出荷・請求 | **実装済み** | `/orders`（status更新+CSV）、`/billing`（0014/0017）、order-portal.html、`shipments`、旧 `documents`/`payments` | **中**: 請求が `billing_documents`(新) と `documents`(旧) の**二重系統** |
| 7 | 捕獲者への買取・支払い | **一部実装** | `individuals.buyback_base/buyback_amount/purchase_payee`、`hunters` に口座。index.html で自動計算 | — **支払実績の台帳が無い**（誰にいつ幾ら払ったかが残らない） |
| 8 | 行政申請 | **一部実装** | `/hunter/city-form/[token]`（セルフDL・0027）、`/gibier/reports/[id]/pack`（写真台紙）、`report_docs`（承認・出力回数）、放射能検査列 | 中: 提出物の一元管理が index.html 側にある |
| 9 | 顧客・営業 | **一部実装** | 既存 `customers`/`customer_prices`/`customer_levels`/`retail_outlets` と ALCO OS `contacts`/`deals`（CRM）が**別物** | **高**: 顧客マスタが二重。CRMを顧客マスタに昇格させない |
| 10 | 商品・レシピ | **一部実装（レシピは未実装）** | `products`(30) `price_master`(59)。**レシピはリポジトリ全体に存在しない** | 低 |
| 11 | 自然環境・位置情報 | **実装済み（里山OS）／連携は未実装** | 0019: `taxa`(希少度) `geo-masking.ts` `v_public_observations`。`capture_reports.capture_lat/lng`、`individuals.capture_lat/lng` | **高**: 捕獲位置を里山OSのマスキングを通さず表示しないこと |
| 12 | レポート・分析 | **一部実装** | `v_gibier_*` 4ビュー、`/`ダッシュボード、`/api/*/csv`、`report_docs`。**TNFD向け集計は未実装** | 低 |
| 13 | ユーザー権限と監査ログ | **一部実装（重大な穴あり）** | ALCO OS: RLS + `can_approve()` + `audit_logs` + `generated_drafts`。**既存ジビエ系は `allow_all`（誰でも読み書き）** | — 6章参照 |

---

## 4. 現在の個体IDの生成・利用状況

### 4-1. 3つの識別子が併存している

| 識別子 | 型 | 例 | 生成場所 | 使う側 |
|---|---|---|---|---|
| `individuals.id` | uuid | `dcb33f6f-…` | DB default | ALCO OS（`capture_reports.individual_id`） |
| `individuals.label_id` | text | `TGC-08-T239` | capture-form.html（`?label_id=like.TGC-08-T*` の最大値+1） | **現場の共通語**。ラベル印刷・在庫・行政・スプレッドシート |
| `individuals.serial_number` | int | `394` | 同上（連番） | 台帳の通し番号 |

派生: `inventory.ident_code` = `label_id + 部位コード + 連番`（例 `TGC-08-T001-RO-10`）。
`product_movements.source_ident_code` がこれを参照する。

### 4-2. 実データで確認した接続状況

- `inventory.individual_id` は **uuid ではなく label_id 文字列**（uuid形式は0件）
- `inventory` 135件のうち、`individuals.label_id` と**突合できるのは111件（82%）**。
  **24件（18%）が孤児**（過去データまたは表記ゆれ）
- `processing_log.individual_id` は**全行 null**。解体履歴と個体は `ident_code` の
  接頭辞でしか辿れない（文字列前方一致に依存）
- ALCO OS が LINE 経由で作る仮個体は `label_id='仮-<base36>'`。
  受入時に人が正式な `TGC-08-…` を採番し直す運用（`capture-report-service.ts`）

### 4-3. 結論

> **「個体IDを中心につなぐ」の土台は既にあるが、キーが text の label_id であり、
> FK制約が無く、18%の不整合が実在する。**
> 新しいIDを発明するのではなく、**label_id を正とし、参照の健全性を検査・修復できる
> 状態にする**のが最短で安全。uuid への一括移行は現場アプリ（index.html /
> capture-form.html）の全面改修を伴うため、今は行わない。

---

## 5. データモデルの不足

| # | 不足 | 影響 | 補い方（案） |
|---|---|---|---|
| M1 | **個体↔在庫の参照整合性がない**（FKなし・18%孤児） | 歩留まり・原価・トレースが正確に出せない | 新テーブルで検査結果を保持（既存は変更しない）。`v_individual_trace` ビューで突合を可視化 |
| M2 | **捕獲者への買取支払台帳がない** | 誰にいつ幾ら払ったかが残らない。方針4（支払確定は人の承認）が担保できない | `hunter_payouts`（個体単位の買取・支払日・承認者・監査） |
| M3 | **食用可否の判定結果が構造化されていない** | `quality='食用不可'` の一列のみ。理由・判定者・根拠が残らない | `intake_assessments`（判定・理由コード・判定者・承認）※既存列は据え置き |
| M4 | **捕獲者と個体が氏名テキストで結ばれている** | 同姓同名・表記ゆれで集計がぶれる | `individuals.hunter_name` は残しつつ、`capture_reports.hunter_id` を正とする経路を増やす |
| M5 | **捕獲位置が里山OSの観察データと分離** | TNFD・生態系分析につながらない | `capture_observations`（個体→観察へのブリッジ。位置は geo-masking 経由） |
| M6 | **請求系が二重**（`documents` 旧 / `billing_documents` 新） | どちらが正か不明。二重計上の危険 | 新規は `billing_documents` に寄せる方針を docs に明記（データ移行はしない） |
| M7 | **顧客マスタが二重**（`customers` / CRM `contacts`） | 名寄せできない | `customers` を正とし、`contacts` は営業活動の記録に限定と明記 |
| M8 | **AI抽出の確信度・承認状態の保存が領域ごとにバラバラ** | 方針6が全体で守れていない | `capture_reports.ai_suggestion` の形（元データ+確信度+承認状態）を標準として横展開 |
| M9 | **レシピが存在しない** | 商品開発・原価計算につながらない | 優先度低。Phase 4以降 |

---

## 6. セキュリティ上の問題（**最重要**）

### S1. 既存ジビエ系テーブルが実質「全公開」— 最優先で対処すべき

本番DBのポリシー実測:

| テーブル | ポリシー | 対象ロール | 条件 |
|---|---|---|---|
| `individuals` | `allow_all` | **public**（anon含む） | `USING true` / `WITH CHECK true`（**ALL**） |
| `inventory` `products` `product_movements` `processing_log` `price_master` | `allow_all` | **public** | 同上 |
| `orders` `order_items` `customers` | `allow_all` ＋ anon 個別 | **public / anon** | 同上 |
| `hunters` | `hunters_select/insert/update` | **public** | `USING true`（delete のみ2026-07-26に廃止） |

静的HTMLは **anon キーをソースに埋め込んで公開**しているため、
**そのキーを取得した誰でも、捕獲者206名の氏名・住所・電話・銀行口座、
個体511件の捕獲座標を読み書きできる**。方針5（位置情報の権限別秘匿）と
方針3（既存データを壊さない）に真正面から反する状態。

> 注: これは今回の構想以前からある既存の状態であり、新規に作り込まれたものではない。
> ただし「個体IDを中心に全部つなぐ」と、被害範囲が全業務に広がるため、
> **統合を進める前に手を打つ必要がある**。

### S2. `secretary_pages` は RLS 自体が無効（`rowsecurity=false`）

### S3. 捕獲座標が二重管理

`individuals.capture_lat/lng` と `capture_reports.capture_lat/lng` が別々にあり、
前者は上記 S1 により無防備。里山OSの `geo-masking` は**後者にしか効かない**。

### S4. 罠の位置・私有地情報の扱いが未定義

`capture_reports.capture_place` `trap_number` は職員には見えるが、
公開・エクスポート時の規則が docs/10 の希少種ルールと接続していない。

### S5. 監査ログの空白

`audit_logs` は ALCO OS 経由の操作しか記録しない。**現場アプリからの
individuals 更新は一切記録されない**（誰が食用不可にしたか等が残らない）。

---

## 7. 優先順位付きロードマップ

原則: **1PR = 1機能 = 検証可能**。既存テーブルはスキーマ変更しない。

### Phase 0 — 安全化（統合の前提。ここを飛ばさない）

| # | 項目 | 理由 |
|---|---|---|
| **P0-1** | **既存ジビエ系RLSの段階的ハードニング** — まず「読み取りは維持・書き込みを絞る」から。`hunters` の口座列を分離ビュー化、`individuals` の座標列の露出制限 | S1。**現場アプリを壊さないため、1テーブルずつ・切り戻し可能に** |
| P0-2 | `secretary_pages` の RLS 有効化 | S2 |
| P0-3 | 個体↔在庫の整合性検査ビュー（読み取りのみ・孤児24件を可視化） | M1。修復の前に現状を測る |

### Phase 1 — 個体IDを軸に「見える」ようにする（DB変更は最小）

| # | 項目 |
|---|---|
| **P1-1** | **個体トレース画面**（`/gibier/individuals/[labelId]`）: 捕獲報告 → 個体 → 在庫 → 受注 → 請求 を1画面で表示（読み取りのみ・新テーブルなし） |
| P1-2 | 買取支払台帳 `hunter_payouts`（M2）+ 承認フロー（方針4） |
| P1-3 | 受入・食用可否の構造化 `intake_assessments`（M3）+ 承認 |

### Phase 2 — 現場の入力をALCO OSに寄せる

| # | 項目 |
|---|---|
| P2-1 | 解体・部位入力のALCO OS版（既存 `inventory` へ書き込み・監査ログ付き） |
| P2-2 | 行政提出パックの一元化（`report_docs` の承認をALCO OSへ） |
| P2-3 | 請求系の一本化方針の明文化（M6）と新規導線の統一 |

### Phase 3 — 自然環境・TNFDへの接続

| # | 項目 |
|---|---|
| P3-1 | `capture_observations` ブリッジ（M5）。位置は必ず geo-masking 経由 |
| P3-2 | TNFD/自然共生サイト向け集計ビュー（捕獲圧・季節・地域） |
| P3-3 | 胃内容物・餌資源（docs/10 Phase 2 と接続） |

### Phase 4 — 発展

商品・レシピ、原価計算、需要予測、外部連携。

---

## 8. 最初に着手すべき小さな実装案（推奨: **P0-3 + P1-1**）

**なぜここからか**: DBのスキーマを一切変えず、既存の動作を1行も壊さずに、
「個体IDで全部つながっているか」を**目で見えるようにする**。
不整合24件の正体が分かってから修復方針を決められる。安全で、効果が最も早く出る。

### 内容

1. **整合性ビュー**（マイグレーション0030・追加のみ・ビューのみ）
   - `v_individual_trace`: 個体1行に対し、在庫件数 / 部位重量計 / 受注件数 /
     出荷 / 請求 / 買取金額 / 捕獲報告の有無を集約
   - `v_individual_link_issues`: 孤児 inventory、label_id 不一致、
     `processing_log.individual_id` 欠損を列挙（読み取り専用）
2. **個体トレース画面** `/gibier/individuals`（一覧・検索）と `/[labelId]`（詳細）
   - 捕獲報告（LINE）→ 個体 → 在庫（親子ツリー）→ 受注 → 請求 を時系列で表示
   - 座標は `geo-masking` 経由（職員=原座標、それ以外=マスク）
   - **書き込みなし。** 既存データの表示のみ
3. **不整合の一覧**を `/gibier/reports` の下部に「要確認 24件」として提示

### やらないこと（この段階では）

- 既存テーブルへの列追加・FK追加・データ修復
- individuals への書き込み経路の追加
- 新しいID体系の導入

---

## 9. 変更予定ファイル一覧（P0-3 + P1-1）

| 種別 | パス | 変更 |
|---|---|---|
| 新規 | `alco-os/supabase/migrations/0030_individual_trace_views.sql` | ビュー2件のみ（**0029適用後に採番**。※0029未適用のため要調整） |
| 新規 | `alco-os/src/domain/gibier/individual-trace.ts` | 集約・不整合判定のドメインロジック（DbPort依存） |
| 新規 | `alco-os/src/app/gibier/individuals/page.tsx` | 一覧・検索 |
| 新規 | `alco-os/src/app/gibier/individuals/[labelId]/page.tsx` | 個体トレース詳細 |
| 変更 | `alco-os/src/app/gibier/reports/page.tsx` | 「要確認N件」リンク追加（既存機能は不変） |
| 変更 | `alco-os/src/components/app-shell.tsx` | ナビに「個体トレース」追加 |
| 変更 | `alco-os/src/app/manual/page.tsx` | 使い方を追記（ルール: 機能変更時は同PRで更新） |
| 変更 | `alco-os/docs/04-database-schema.md` `09-gibier-integration.md` | 0030の記載・不変条件の追記 |
| 新規 | `alco-os/tests/domain/individual-trace.test.ts` | 下記テスト |
| 変更 | `AI_HANDOFF.md` | ルート追加 |

**変更しないもの**: 既存テーブル定義、`capture-report-service.ts`、
`/api/line`、ジビエ基幹の全HTML、0001〜0029 の既存マイグレーション。

---

## 10. テスト計画

現行ベースライン: **320件 / 35ファイル 全passing**（`pnpm test` 実測）。

| 種別 | 内容 |
|---|---|
| 単体（InMemoryDb） | ① label_id で個体・在庫・受注を正しく集約する ② 孤児在庫（個体が無い）を不整合として検出する ③ `processing_log.individual_id` 欠損を検出する ④ 部位重量の合計と歩留まりの算出 ⑤ 個体が0件でも落ちない |
| セキュリティ | ⑥ 職員以外の権限では捕獲座標がマスクされる（`geo-masking` 経由であることをテストで固定） ⑦ トレース画面は書き込み関数を一切呼ばない（ドメイン層に insert/update が無いことを確認） |
| SQL | ⑧ `tests/migrations/sql-order.test.ts` の並び順チェックに0030を通す ⑨ PGlite でビュー定義が実Postgresに適用できること |
| 回帰 | ⑩ 既存320件が全て通ること（必須） |
| 手動 | ⑪ 本番相当データで `/gibier/individuals` を開き、既知の個体（TGC-08-T239）で在庫・受注が正しく出るか目視 ⑫ 既存の `/gibier/reports` `/line` `/orders` が従来どおり動くこと |

---

## 11. 承認をお願いしたい判断

1. **Phase 0（安全化）を先にやるか、Phase 1（見える化）を先にやるか**
   → 推奨: **P0-3 + P1-1 を同時に小さくやる**（読み取りのみで安全）。
   P0-1（RLSハードニング）は現場アプリへの影響があるため、**単独のPRで慎重に**
2. **label_id を正の個体IDとして確定してよいか**（uuid統一は当面しない）
3. **請求は `billing_documents` に寄せる**方針で確定してよいか（M6）
4. **顧客マスタは `customers` が正**、CRM `contacts` は営業記録に限定でよいか（M7）
5. 未適用の **0029（FB横展開）の扱い** — 先に適用するか、この統合の後にするか

---

## 付記: 現在の未処理事項

- **0029_crosspost は本番DB未適用**（コードは main にマージ済み）。
  次のマイグレーション番号を決める前に、この扱いを決める必要がある
- 0028 は適用済み（docs/04 の「未適用」表記は古い。この文書の内容が正）
