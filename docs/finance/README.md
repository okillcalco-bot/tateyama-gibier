# 会計（finance.html）

通帳・カード明細・領収書・請求書を一つの画面で突き合わせ、月ごとに税理士へ渡せる形で出す。
入金消込（`docs/reconciliation/`）の上に載っている。**実データ（通帳・名義・金額）はこのリポジトリに入れない。**

## 画面と役割

| タブ | 何をする | スタッフ | 管理者 | 税理士（閲覧専用） |
|---|---|---|---|---|
| ダッシュボード | 預金残高（通帳の最新）、月ごとの入出金、未入金・期日超過、やること（未消込・未分類・未確認の件数） | 見る | 見る | 見る |
| 銀行 | 通帳の取込（千葉銀行の「入出金明細」PDF／各銀行CSV）、明細一覧、出金の科目付け | 取込・科目 | 同左 | 見る・CSV |
| 入金消込 | 自動で当たったものをまとめて確定、候補から選んで確定（名義を登録）、請求書でない入金に科目、取消 | 確定・取消 | 同左 | 結果だけ |
| 未入金・督促 | 取引先ごとの未入金、督促文のコピー、送った記録 | 記録 | 同左 | 見る・CSV |
| カード | カード明細CSVの取込（列は見出しから自動）、科目付け、領収書の有無 | 取込・科目 | 同左 | 見る・CSV |
| 領収書 | 写真（縮小してから送る）／PDFの登録、明細との紐づけ、確認・却下 | 登録・確認 | 同左 | 見る・CSV |
| 月次・出力 | 月の集計（売上・入金・出金・カード・現金・科目別）、仕訳、税理士向けに5つのCSV | 出す | 出す | 出す |
| 設定 | 勘定科目、振込名義、閲覧専用キーの発行 | 科目・名義 | ＋キー発行 | 見る |

- **スタッフ**: スタッフキー（業務アプリ・受発注管理と同じ `tg_staff_key`）。
- **管理者**: スタッフキー＋業務アプリで管理者コードを入れた端末（`sessionStorage tg_role_v1=admin`）。閲覧専用キーの発行には管理者用回復コードも要る。
- **税理士**: 閲覧専用キー（`tg_finance_key`、共有リンク `finance.html#fkey=…` で渡す）。DB側で `finance_role()` が `viewer` を返し、書く関数（`staff_*`）は `staff_key_ok` で弾く。画面側も `body.readonly` で書く操作（`class="w"`）を消す。

## 部門と口座

- 部門は `departments`（初期値: `gibier` 館山ジビエセンター＝通帳は館山市への報告義務あり、`arco` 合同会社アルコ本体）。設定タブで足せる。
- 口座は `bank_accounts`（銀行・支店・種別・口座番号・呼び名・部門）。千葉銀行の PDF は見出しの「館山支店 普通 ○○○」から口座を自動で見分け、未登録なら取込の画面でその場で登録する。CSV は口座を選ぶ。
- カードは `finance_cards`（カード名・呼び名・部門）。はじめて取り込むときに部門を選ぶ。
- 明細の部門は「口座／カードの部門」が既定。1件ずつ別の部門に付け替えられる（`finance_classifications.department`）。請求書は `documents.department`（無ければ取引先の部門、無ければ gibier）、領収書は `receipts.department`。
- 右上の部門の選択で、ダッシュボード・一覧・月次・出力がその部門だけになる。ジビエに絞った「銀行明細」CSV が市役所に出す通帳の明細（科目つき）になる。

## データの流れ

```
千葉銀行PDF / 銀行CSV ─ finance-core.js（列判定・検算）─ staff_bank_import ─ bank_transactions（取込後は変更不可）
                                                                                   ├─ recon-core.js → staff_recon_confirm → payments（請求書と紐づく）
                                                                                   └─ staff_classify → finance_classifications（科目・メモ・部門）
カードCSV ─ finance-core.js ─ staff_card_import ─ card_transactions（取込後は変更不可）─ staff_classify
写真/PDF ─ 画面で縮小 ─ staff_receipt_add（台帳 receipts）＋ staff_receipt_file_put（本体 receipt_files）─ 明細と紐づけ・確認
月次 ─ finance_month → finance-core.js（monthSummary / journalRows）→ 仕訳CSV・明細CSV
```

- 明細（銀行・カード）は取り込んだら変えない。科目やメモは別の表（`finance_classifications`）に持つ。
- 入金の状態は `payments` の合計から毎回計算する（保存しない）。
- 自動で消込するのは「名義が完全一致＋残額が一致」か「合算が一致」だけ（`docs/reconciliation/DECISIONS.md`）。それ以外は人が選ぶ。
- 千葉銀行PDFは、PDFに印字された「入金合計・出金合計・件数」と、残高の繋がり（前の残高±金額＝次の残高）が全行一致したときだけ取り込める。1か所でも崩れていれば取り込まない。

## 承認が要るもの（本番に出す前）

| 項目 | 内容 |
|---|---|
| マイグレーション | `migrations/20261021_bank_reconciliation.sql`・`migrations/20261023_finance_cards_receipts.sql`（追加のみ。新しい表はすべて RLS 有効・anon 不可。関数は SECURITY DEFINER） |
| 権限 | 上の関数を anon から実行できるようにする（中でキーを確認する）。既存の表の権限は変えない |
| デプロイ | `finance.html`・`finance-core.js`・`recon-core.js`、受発注管理のヘッダに「会計」リンク |
| 秘密値 | 閲覧専用キーは管理者が画面から発行（DBに bcrypt／sha256 で保存）。新しい外部サービス・APIキーは無し |
| pdf.js | ブラウザが cdnjs から読む（3.11.174 固定）。読めないときは CSV で取り込める |

## 分かっている制約・次にやること

- **領収書の本体は DB（`receipt_files`、1件3MBまで）に置いている。** Supabase Storage は公開キー＋独自ヘッダ（x-staff-key）の RLS が効かない（Storage API はリクエストヘッダを `request.headers` に渡さない）ため。画面で長辺1600pxに縮小するので1枚 200〜400KB。件数が増えたら Edge Function（サービスロール内蔵）で Storage の署名URLを出す方式に移す（`receipts.storage_path` はそのために空けてある）。
- **キーの失敗回数の制限は、例外で終わる呼び出しでは記録が巻き戻る**（本番の `staff_key_ok` を RPC から呼ぶ場合と同じ）。`finance_role` を直接叩く総当たりは止まるが、`finance_*`/`staff_*` 経由の失敗は数えられない。止めたければ関数を「false を返す」形に変える必要がある（既存の設計と合わせて別途）。
- 千葉銀行以外の PDF は未対応（CSV で取り込む）。カード会社の CSV 形式は実物を受け取ってから列の当たりの辞書を足す。
- 税理士向けの仕訳は汎用の「日付・借方科目・貸方科目・金額・税区分・摘要・証憑」。会計ソフトの取込形式（freee・弥生など）に合わせる変換は、使うソフトが決まってから。
- 部門（ジビエ／アルコ）は列を用意してあるが、画面ではまだ分けていない。
- 消込の Claude API（ファジー照合）は Edge Function 経由にする設計のまま未実装（キー登録は承認地点）。

## テスト

- `tests/e2e/finance-core.e2e.js`（node）: PDFの行組み立て・検算・CSVの列判定・カード行・月次集計・仕訳 — 30/30
- `tests/e2e/finance-ui.e2e.js`（playwright・DBはモック）: キー・役割・取込（口座の登録を含む）・部門の絞り込みと付け替え・消込・督促・カード・領収書・月次・設定・閲覧専用 — 56/56
- `tests/db/finance.test.sql`（手元の使い捨てPG）: 閲覧専用キー・役割・科目・口座・カード取込・分類・部門の付け替えと絞り込み・領収書・ファイル・一覧・ダッシュボード・月次・anon 拒否 — 63/63
- 本物の千葉銀行PDF（4か月分）は手元だけで検証し、python 版の読み取りと全行一致（リポジトリには入れない）
