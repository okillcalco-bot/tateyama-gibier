# 入金消込 Step 0：コンテキスト確認（2026-10-21）

指示書「ジビエ基幹システム 入金消込機能 追加指示書」（2026-10-21）の Step 0 の結果。
対象: main `8769cbf`、本番DB（読み取りのみ）。**このリポジトリは公開のため、取引先名・振込名義・金額・件数の実測値は書かない。**
確認できなかった項目は「仮定」または「未確認」と明記し、沖に確認する。

## 1. 実テーブル（指示書の仮名との対応）

| 指示書の仮名 | 実テーブル | 根拠・備考 |
|---|---|---|
| 取引先 | `customers` | 主キー `id uuid`、表示コード `code`（C0001形式）。`kana`（半角カナ）と `search_aliases text[]`（別名）を持つ。`email` はほぼ未登録（**督促メールの宛先がほとんど無い**） |
| 請求書 `invoices` | `documents`（`doc_type='請求書'`） | 主キー `id uuid`、番号 `doc_number`（`INV-YYYYMM-NNN`）、`issue_date`・`due_date`・`total_amount`（税込・整数円）・`tax_amount`・`status`（発行済／取消／下書き）・`billing_status`（未入金／一部入金／入金済）・`snapshot jsonb`。見積・納品・領収も同じ表で `doc_type` で区別 |
| 請求明細 | `document_items` | `amount` は**税抜**・整数円、`tax_rate` 8/10/0。`documents.total_amount = Σamount + tax_amount` は発行済の明細つき請求書で全件一致（税率ごとに切り捨て、`order-admin.html` `invCalcLines`） |
| 請求と注文の紐づけ | `document_orders` | 1請求書に複数注文（月まとめ発行） |
| 販売明細 | `orders` / `order_items` / `shipments` | 注文は税込。送料は `shipments.freight`（税抜） |
| 入金（消込の結果） `reconciliations` | **既存 `payments`**（`document_id, paid_date, amount, method, note`） | 既に「1請求書に複数入金」を持てる。本番の行数は現時点で0。**銀行明細との紐づけ列は無い** |
| 銀行明細 `bank_transactions` / `import_batches` / `bank_profiles` | なし | 新設が必要 |
| 振込名義のゆらぎ `customer_aliases` | 一部あり：`customers.search_aliases`・`customers.kana` | 名義専用の表は無い |
| 領収書 `receipts` | **基幹DBに無い** | 下の「5. 領収書」参照 |

### 請求書の状態の現状
- 画面の状態は `order-admin.html` `invStatusOf` が `payments` の合計から毎回計算する（入金済 → 一部入金 → 期限超過（`due_date < 今日`）→ 未入金）。`billing_status` 列は入金記録時に別リクエストで更新される（二重管理）。
- 指示書の「状態は消込の合計から導出・期日超過は保存しない」は、現行の `invStatusOf` と同じ考え方。

### 期日（due_date）の現状（仮定の材料）
- 月まとめ発行（翌月上旬に前月分を発行）で、`due_date` は**発行日の翌月末**になっている例がほとんど。一部に「発行月末」の例がある。
- 締日と入金サイトの正式なルールは**未確認**（沖に確認）。

## 2. 既存の照合コード

| もの | 場所 | 状態 | 本件での扱い（案） |
|---|---|---|---|
| `gibier-finance.html`（銀行CSV × Claude API） | **見つからない**（全ブランチ・Drive・アーティファクトを検索） | — | 所在を沖に確認。見つからなければ下の既存コードから組む |
| 入金明細の照合（貼り付け式） | 作業ブランチ `claude/tateyama-gibier-ux-ws4c5p` のコミット `1e2f273`（**未マージ・本番未反映**）`order-admin.html` `payParseLines` / `payKana` / `payMatchRun` / `payMatchRecord` | 名義の正規化（NFKC・ひらがな→カナ・法人略号除去）、残額と名義が一致し候補が1件のときだけ記録、それ以外は理由つき確認待ち（合算・手数料差・分割・過入金・別名義・該当なし）。記録前に入金を読み直して二重登録と残額超えを止める | **移植元にする**。指示書の機能2のルール1と候補理由の分類がほぼ揃っている |
| Shift_JIS 判定・CSV パーサ | `alco-os/src/app/billing/actions.ts`（UTF-8 で読めなければ `TextDecoder('shift_jis')`）、`alco-os/src/domain/billing/misoca-import.ts` `parseCsv` | 稼働（Misoca 取込用） | 考え方を流用（基幹は静的HTMLなのでコードは書き直し） |
| Claude API | `alco-os` のみ（サーバー側、`ANTHROPIC_API_KEY` は環境変数） | — | **ブラウザから直接呼べない**（キーが公開される）。ファジー照合はサーバー関数経由になる → 秘密値の登録・関数の公開が承認事項 |

## 3. 銀行CSV
- **未確認**。列構成・文字コード・日付書式は、沖から直近1か月のCSVを受け取って確認する。
- 受け取ったCSVは**リポジトリに入れない**（公開リポジトリ）。検証は手元（サンドボックスの一時領域）で行い、結果の件数だけを TESTLOG.md に書く。

## 4. 権限（重要）
- 業務画面は公開キー（anon）でDBに直接書いている。`payments` は条件なしで読み書きできる設定。
- 銀行明細は**公開キーで読めてはいけない**。新しい表は RLS で anon を拒否し、スタッフキー確認つきの関数（`staff_key_ok`）からだけ読み書きする設計にする。**RLS・権限の変更は承認事項。**

## 5. 領収書（機能4）
- 基幹DBに領収書の表は無い。リポジトリ内に Drive への振り分け処理も無い（`.gs` 等なし）。
- 近いのは ALCO OS の経費機能（`alco-os/src/app/expenses/actions.ts` → Storage `alco-os` バケット → 読み取り）。
- 指示書の「領収書処理（Driveフォルダ振り分け）稼働中」が何を指すかは**未確認**（リポジトリ外の Apps Script 等の可能性）。

## 6. その他
- 部門（ジビエ／自社）の概念はどの表にも無い。
- cron: 本番で pg_cron を1件使用中（固定シフトの月次反映）。Vercel cron の設定は無い。
- Gmail 下書きを作るコードは無い（Gmail API の接続は新しい継続アクセス設定 → 承認事項）。
- 過去の請求書: 基幹の `documents` に請求書があるのは **2026年9月以降**。それ以前は Misoca 等の外部で発行しており、基幹には無い（過去の請求書の取込は未マージのブランチで作業中のものがある）。→ 「過去3か月の実データでの検証」は、7〜8月分の請求書データの入手方法を決める必要がある。

## 仮定（沖の確認待ち）
| # | 仮定 | 確認すること |
|---|---|---|
| A1 | 請求書＝`documents(doc_type='請求書', status='発行済')`、入金＝`payments` に銀行明細IDなどの列を**追加**して使う（新しい `reconciliations` 表は作らない） | 新表で分けるか、既存 `payments` を拡張するか |
| A2 | 期日＝発行日の翌月末 | 締日・入金サイトの正式ルール |
| A3 | 振込手数料は先方負担、差額は自動確定しない（候補提示のみ） | 当方負担の取引先の有無・許容差額 |
| A4 | 振込名義のエイリアスは `customers.search_aliases` ではなく名義専用の表に持つ | — |
| A5 | 領収書の部門はアップロード時に選ぶ | 稼働中の領収書処理の所在 |
