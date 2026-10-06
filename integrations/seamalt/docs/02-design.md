# 02 設計・ツール・権限一覧

```
シーモルト（ChatGPT dot）
  │ OAuth 2.1 + PKCE（Supabase Auth の OAuth サーバー・本人がメールリンクでログインして許可）
  ▼
Supabase Edge Function  seamalt-mcp   … integrations/seamalt/supabase/functions/seamalt-mcp/
  │ トークン検証（署名JWKS・iss・aud・exp・寿命・client_id）→ 入力のJSON Schema検証
  │ 専用ロール seamalt_mcp で接続（order_link.api_* の5関数を実行できるだけ）
  ▼
PostgreSQL  order_link.api_*（SECURITY DEFINER・search_path固定）
  │ 主体（principals）・スコープ・組織・対象を毎回認可
  ▼
既存の orders / order_items（受注の正本）＋ order_link の補助表
```

## MCPツール（すべて新設。実装済み・ローカル試験済み・本番未接続）
| ツール | 種類 | 必要権限 | 内容 |
|---|---|---|---|
| `orders_search` | 読取 | orders:read | 外部注文ID・注文番号・顧客・期間・商品・状態で検索。総件数・`next_cursor`・`complete`・照合根拠・出荷/請求/取消/要確認の状態 |
| `orders_get` | 読取 | orders:read | 1件の明細・原文数量と単位・温度帯・未確認項目・出典・履歴・出荷・帳票・引当・version |
| `order_import_preview` | 書込み（候補だけ） | orders:import | 検証して取込候補を保存。顧客/商品照合・3段階の重複・変更候補・未確認項目・保存予定。orders は変更しない |
| `order_import_commit` | 書込み（登録） | orders:import | 候補ID・版・ダイジェスト・冪等キー・`confirmed_by_user=true` で、ヘッダー・明細・外部参照・明細補助・監査を1トランザクションで登録 |
| `order_import_status` | 読取 | orders:import | 冪等キー／候補IDから処理結果と履歴 |

公開しないもの: 汎用SQL、任意テーブル更新、ステータス変更、顧客作成、在庫・請求・送信。

共通の結果: `request_id, outcome, order_id, order_code, external_order_id, version, warnings, verified_at, detail_url`。
`outcome` = created / already_exists / needs_review / conflict / forbidden / failed（読取ツールの成功は `read`）。
検証エラーは `failed` + `reason=validation_error` + `errors[]`（成功扱いにしない）。

## 補助表（スキーマ `order_link`。PostgREST 非公開・RLS有効・ポリシーなし）
| 表 | 役割 |
|---|---|
| principals | MCPの主体（トークンの iss+sub）→ 表示名・担当者名・スコープ（read/import）・担当顧客の限定・失効日時 |
| sources | 出典（provider/account/message_id/thread_id/attachment_id/ファイル名/SHA-256/ページ/受信時刻/リンク）。本文・添付そのものは保存しない |
| candidates / candidate_sources | 取込候補（版・ダイジェスト・正規化内容・照合結果・状態）。登録前の作業用 |
| external_refs / ref_sources | 外部注文参照（組織＋経路＋発行元＋外部注文ID、無ければ確認済み出典キー）→ order_id・内容ダイジェスト・改訂・**review_state（要確認）** |
| item_ext | order_item 1行ごとの原文・原文数量・数量・単位・kg換算（g/kgのみ）・温度帯・希望条件・未確認項目・確認状態 |
| product_aliases | 人が確認した商品名→種・部位の対応（発行元ごと） |
| runs | 監査（主体・操作・候補と版・ダイジェスト・冪等キー・結果・注文・依頼の要約）。本文・秘密値は入れない |
| settings | `writes_paused`（切戻しスイッチ）・組織キー |

## 重複防止（DBの一意制約＋トランザクション）
1. 同じメール・添付の再処理: `sources (provider, account, message_id, attachment_id)` 一意。SHA-256 一致は「同じファイルが別メールにも」と通知。開いている候補は `candidates_open_*_uq` で1つ。
2. 同じ業務注文の再送・転送: `external_refs (org, channel, issuer, external_order_id)` 一意。同内容は no-op（出典だけ結び付け）、別内容は変更候補（conflict・上書きしない）。
3. 外部IDの無い既存注文: 同じ顧客・±14日・同じ部位の注文を出荷・請求・取消の状態付きで返し、`not_duplicate_of` か `duplicate_of` をユーザーが確認するまで登録しない（自動結合しない）。
- 冪等キー: `runs (principal, idempotency_key)` 一意（失敗は除く）。同キー同内容は前回結果、同キー別内容は conflict。
- 並行 commit: 候補行の `FOR UPDATE` と上記一意制約。競合時は既存を取り直して比較。

## 「要確認」の扱い（orders.status に値を足さない）
- 温度帯の記載なし・「フレッシュ」の意味・枝肉の頭数注文 → `external_refs.review_state='needs_review'`。
- **DBトリガー**（order_link.guard_review）で、要確認のうちは次を拒否: orders.status を 確認済/発送済/納品完了 へ（admin_set_order_status 経由も）、shipments・documents・document_orders の作成、inventory_allocations、order_items.inventory_id の割当。キャンセルは可。
- 受発注画面の注文詳細で人が未確認項目（温度帯の選択など）を確認 → `order_link_confirm_review`（スタッフキー必須）→ 全部済めば confirmed。

## 単位・未確定
- 数量は数値＋単位（kg/g/本/頭/パック/個/枚/ブロック/羽）。g→kg だけ換算し原文も保持。本・頭は requested_kg・重量・単価・金額を null（0を使わない）。
- 納品希望日の空欄は null、「用意でき次第」は文章で保持。注文日と受信時刻を分ける（timestamptz・業務日付は Asia/Tokyo）。
- 価格は取込時に付けない（`price_source='unpriced_import'`）。出荷時に既存の価格解決で決まる。

## SECURITY DEFINER のレビュー
| 関数 | 実行できる人 | 理由・認可 |
|---|---|---|
| order_link.api_*（5） | seamalt_mcp のみ | 補助表と orders に直接権限を与えないため。先頭で principals・スコープ・組織・候補の所有者・担当顧客を確認。search_path 固定 |
| order_link.evaluate / upsert_sources / order_brief ほか | 誰にも付与しない | api_* の中からだけ |
| order_link.guard_review（トリガー） | 書込みした本人の権限で発火 | 補助表を読むため。拒否するだけで書き換えない |
| public.order_link_review_states | anon, authenticated | 出荷画面はキー無し端末でも使う（2026-08-12 の判断）。返すのは注文IDごとの状態・未確認コード・外部注文IDだけ（個人情報・原文なし）。1回1000件まで |
| public.order_link_order_detail | anon, authenticated（中でスタッフキー必須） | 原文・出典を含むため |
| public.order_link_confirm_review | anon, authenticated（中でスタッフキー必須） | 人の確認操作。版の照合・担当者名必須 |

## 権限一覧（本番に作るもの）
| 対象 | 権限 |
|---|---|
| ロール `seamalt_mcp`（LOGIN・パスワードは本人が設定） | schema order_link の USAGE、api_* 5関数の EXECUTE のみ。表の権限なし・service_role ではない |
| anon / authenticated | order_link の表・api_* に権限なし。public.order_link_* 3関数の EXECUTE |
| 主体（principals） | 初期は本人1名のみ（`orders:read`,`orders:import`）。追加・失効は SQL で（`revoked_at` を入れると即時に全ツール拒否） |
