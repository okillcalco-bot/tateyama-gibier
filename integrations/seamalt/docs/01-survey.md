# 01 現行構造の調査結果（2026-10-02〜03・読取りのみ）

対象: main `b1bcd6b`（PR #360 時点）、本番DB `clpdyrehdgzgiidbfucj` の定義・権限メタデータ。注文の実データは変更していない。
本番配信（Vercel）と main が同一かは未検証（サンドボックスから vercel.app へ直接出られないため。必要なら CLAUDE.md の `http_get` 手順で確認する）。

## 指示書と一致した点
- 受注の正本は `orders` / `order_items`。出荷 `shipments`、引当 `inventory_allocations`、帳票 `documents` + `document_orders`。
- `orders` / `order_items` は RLS 有効だが、anon・authenticated に SELECT / INSERT / UPDATE 全行許可（`20260812_orders_rls_relax.sql` と一致。DELETE ポリシーなし）。
- `orders_client_request_uq`（customer_id, client_request_id の部分一意）だけでは外部注文IDの重複を防げない。
- `submitManualOrder`（order-admin.html）は orders と order_items を別々に POST（非原子的）。
- `shipSelectOrder`（index.html）は受注を選んだ時点で `確認済` に PATCH する。
- `orders.status` の CHECK は 受注／確認済／発送済／納品完了／キャンセル。

## 食い違い・追加で分かったこと
| # | 内容 | 影響と対応 |
|---|---|---|
| 1 | `orders.status` の**既定値が「受付」なのに CHECK に「受付」が無い** | status を省いた INSERT は失敗する。取込は必ず `受注` を明示。既存データに「受付」は0件 |
| 2 | `order_items.order_id` は NULL 可・`on delete cascade` | 取込は order_id を必ず入れ、補助表は `on delete restrict` で参照（注文の物理削除を補助表側で止める） |
| 3 | `inventory_allocations` は RLS 有効・ポリシーなし（SECURITY DEFINER の引当関数だけが書く） | 指示書の「参照」と一致。ガードはトリガーで追加 |
| 4 | **shipments / documents / document_orders / inventory も public に全許可**（allow_all）。このほか anon・authenticated に全行許可の表が計56 | 指示書の範囲（orders/order_items）外にも直接経路がある。今回の認可移行案は orders/order_items に限定し、残りは「既知の残課題」として 03 に記載 |
| 5 | anon / authenticated に TRUNCATE 権限が付いている（RLS は TRUNCATE に効かない） | PostgREST からは TRUNCATE を呼べないため実害は低い。別途剥がすことを推奨 |
| 6 | 受発注画面の `sbRpc` はスタッフキーのヘッダを付けない | 取込欄の関数はヘッダで認可するため、専用の `olRpc` を追加 |
| 7 | 既存の注文に金額・単価が null の行があると、詳細画面は「¥0」と表示していた | 取込注文は金額未確定（null）で保存するため、「未確定」と表示するよう修正 |
| 8 | 受発注画面のヤマトB2 CSV は荷扱いを常に「冷凍」で出す | 取込で冷蔵が確定した注文でも「冷凍」になる。今回は変更せず、運用説明に注意として記載 |
| 9 | 注文詳細への直リンクが無かった | `order-admin.html?order=<注文番号>` を最小限追加（デプロイは承認後。`SEAMALT_DETAIL_URL` はデプロイ後に設定） |
| 10 | サーバー層: ルートの Vercel プロジェクトに `api/`・`vercel.json` は無い。Supabase Edge Functions は既に4本稼働 | MCP は Supabase Edge Function として置く（ALCO OS を経由しない） |
| 11 | Supabase Auth のユーザーは1名（本人）だけ | MCP の主体は本人に限定しやすい |
| 12 | **Supabase OAuth 2.1 サーバーのアクセストークンは `aud=authenticated` 固定・カスタムスコープ非対応**（Supabase公式 2026-10 時点） | OpenAI 公式が求める「resource を aud に入れる」を満たせない。代わりに client_id で絞る（04 に詳細） |
| 13 | 価格マスタの部位名は「カタ」「枝肉（全体）」「レバー（肝臓）」等の表記 | 取込の商品照合は価格マスタ表記に揃える。名称が違うもの（肩→カタ）は人が確認するまで登録しない |

## 既存の注文経路（照合の対象）
| 経路 | channel / order_code | 書く場所 |
|---|---|---|
| 顧客ポータル | `ポータル` / `ORD-YYYYMMDD-…` | `portal_place_order`（SECURITY DEFINER） |
| 手入力（受発注画面） | `メール`・`電話`等 / `ORD-<base36>` | order-admin.html `submitManualOrder` |
| BASE | `BASEネットショップ` / `BASE-<キー>` | index.html |
| 直接出荷 | `直販`・`直販（注文なし）` / `DIR-…` | index.html `recordDirectShipment` |
| **シーモルト取込（新設）** | 既存の `メール` / `ORD-YYYYMMDD-XXXXXX` | `order_link.api_import_commit`（1トランザクション） |
