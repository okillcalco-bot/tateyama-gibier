# 実DBテスト（請求書ステージング）

## ファイル構成

| ファイル | 内容 |
|---|---|
| `invoice_staging.test.sql` | 本体テスト（投入・冪等・名寄せ・数字コード・ハイフン・同時投入・RLS/認可） |
| `invoice_rollback.test.sql` | ロールバックSQLの完全性テスト（全オブジェクト削除→残存0件→復元） |
| `concurrent-import.test.mjs` | Node.jsからRPCを`Promise.all`で同時実行する競合テスト（任意・要スタッフキー） |

## 実行方法

SQLテストは**ファイル全体**を psql（`ON_ERROR_STOP`推奨）または Supabase SQL Editor /
MCP execute_sql に貼り付けて実行する。全体が `begin` 〜 `rollback` で囲まれているため、

- テストデータ（顧客・取込・明細・対応表）は**一切本番に残らない**
- スタッフキーもトランザクション内で一時キーに差し替えられ、rollbackで元に戻る
- 例外で中断した場合もトランザクションごと巻き戻る（テスト残骸は残らない）

### 合否の機械判定

`invoice_staging.test.sql` は結果表の表示後、**ok=false が1件でもあれば最後のDOブロックが
`raise exception` してSQL全体を失敗させる**。psqlでは終了ステータス非0、SQL Editor / API では
エラー応答になり、例外メッセージに失敗テスト名の一覧が入るため目視不要で検知できる。
全件PASSなら NOTICE `ALL TESTS PASSED` が出て正常終了する。
`invoice_rollback.test.sql` も同様（残存オブジェクトがあれば raise exception）。

## テスト項目と直近の実行結果

実行日: 2026-08-12（JST）／ 対象: 本番DB `clpdyrehdgzgiidbfucj` ／ 結果: **65/65 PASS**

### A. 基本フロー（1〜10）

| # | 項目 | 結果 |
|---|---|---|
| 1 | 投入OK（請求書3枚・明細4行） | PASS |
| 2 | 同一内容ファイル（SHA-256一致）の再投入はskip・既存idを返す | PASS |
| 3 | skip時に取込行が増えない | PASS |
| 4 | 品名が対応表に「未判定」で登録される | PASS |
| 5 | 名寄せ実行で自動確定2件 | PASS |
| 6 | 顧客コード印字→match_status='確定'・matched_by='auto'・確度1.00 | PASS |
| 7 | 電話番号の一意一致→'確定'・'auto'・確度0.95 | PASS |
| 8 | 不明な名称は確定しない | PASS |
| 9 | 未照合が残ると取込ステータス=顧客未照合 | PASS |
| 10 | 一覧RPCに未照合数が出る | PASS |

### B. 顧客コード照合（13〜22）

判定方法: 請求書文字列（宛名・宛先・備考）とcustomers.codeの両方を正規化
（大文字化・全角→半角・ハイフン類6種の統一・前後空白除去）した上で、
**英数字・ハイフン境界付きの完全一致**（`(^|[^A-Z0-9-])コード($|[^A-Z0-9-])`）で照合。
「一致したコードが1種類」かつ「そのコードを持つ顧客が1件」のときだけ
match_status='確定'・matched_by='auto'・match_confidence=1.00。
それ以外（複数コード印字・埋め込み・曖昧）は候補あり/未照合として人の確認へ回す。

| # | 項目 | 結果 |
|---|---|---|
| 13 | コード1件完全一致 → 1.00確定 | PASS |
| 14 | 包含ペア（ZC90⊂ZC900）でZC900印字 → ZC900だけに一致 | PASS |
| 15 | 同ペアでZC90印字 → ZC90に一致（長い方に誤爆しない） | PASS |
| 16 | 同一コードの顧客複数は customers_code_key（一意制約）で作れないことを実証※ | PASS |
| 17 | 請求書に複数コード印字 → 確定しない | PASS |
| 18 | 別文字列への埋め込み（INVZC901X） → 一致しない | PASS |
| 19 | ハイフン連結（INV-ZC901） → 一致しない | PASS |
| 20 | 全角小文字・前後空白（　ｚｃ９０１　） → 正規化して一致 | PASS |
| 21 | 名称一致は候補提示（≤0.50）のみで確定しない | PASS |
| 22 | コード曖昧でも電話一意一致は0.95で確定（回帰） | PASS |

※ DBの一意制約により「同一コードの顧客が複数」はそもそも発生しない。
万一に備えた防御（顧客が複数なら確定しない）は関数側にも実装済み。

### C. 数字だけの顧客コード（23〜28。2026-08-12レビュー対応で追加）

数字のみのコードは「顧客コード」「顧客番号」「お客様番号」「得意先コード」等の
**明示的なラベル直後に印字されている場合だけ**一致として扱う
（正規表現 `(顧客|お客様|得意先|客先)\s*(コード|番号|NO\.?|ID)[\s：:＃#]*コード`）。
年度・金額・電話番号などラベルなしの数字には一致しない。

| # | 項目 | 結果 |
|---|---|---|
| 23 | 数字コード2026 vs 備考「2026年度請求分」 → 一致しない | PASS |
| 24 | 「お客様番号：2026」 → 1.00確定 | PASS |
| 25 | 数字コード0470123456と同値のraw_phone → コードでなく電話照合(0.95) | PASS |
| 26 | 金額表記「1,000円」（数字コード1000あり） → 一致しない | PASS |
| 27 | ラベル付き数字コードが複数印字 → 確定しない | PASS |
| 28 | 「顧客コード 1000」（ラベル別表記） → 1.00確定 | PASS |

### D. ハイフン表記の正規化（29〜35。2026-08-12レビュー対応で追加）

`invoice_norm_code()` が － U+FF0D / ‐ U+2010 / ‑ U+2011 / – U+2013 / — U+2014 / − U+2212 を
ASCIIの「-」へ正規化する。正規表現へ入るコード文字は `^[A-Z0-9][A-Z0-9-]*$` に限定し、
それ以外の文字を含むコードは1.00の自動照合に使わない。

| # | 項目 | 結果 |
|---|---|---|
| 29 | 全角ハイフン（U+FF0D）印字 → ZC-901に一致 | PASS |
| 30 | enダッシュ（U+2013）印字 → ZC-901に一致 | PASS |
| 31 | emダッシュ（U+2014）印字 → ZC-901に一致 | PASS |
| 32 | マイナス記号（U+2212）印字 → ZC-901に一致 | PASS |
| 33 | 末尾ハイフンコード（ZC77-）単独印字 → 一致 | PASS |
| 34 | INV-ZC-901 → ZC-901と一致しない | PASS |
| 35 | [A-Z0-9-]以外を含むコード（ZC(9)）は1.00自動照合に使わない | PASS |

### E. 同時投入の冪等性（36〜38。2026-08-12レビュー対応で追加）

`admin_invoice_stage_import` は SELECT→INSERT ではなく
`INSERT ... ON CONFLICT (content_hash) DO NOTHING RETURNING id` を使う（原子的・競合窓なし）。
INSERTできた場合だけ documents/lines を登録。(source, source_file_id) 競合は
例外分岐で明示的に skipped=true を返す（自動上書きしない）。

| # | 項目 | 結果 |
|---|---|---|
| 36 | 先行INSERT済みハッシュへの投入 → エラーなくskipped=true・既存id・1件のみ | PASS |
| 37 | skip時はdocuments/linesを登録しない | PASS |
| 38 | 同一source_file_idで内容変更 → skipped=true・理由明示・1件のみ | PASS |

補助検証（2026-08-12 実測）: 2つの独立セッションから同じcontent_hashの
`INSERT ... ON CONFLICT DO NOTHING RETURNING id`（RPC内部と同一パターン）を並列実行 →
片方のみ作成・もう片方は0行（エラーなし）・作成行は1件のみ。テスト行は削除済み。
`concurrent-import.test.mjs`（RPCを`Promise.all`で2本同時）はスタッフキー保持者が実行できる
（本番に CONCURRENCY-TEST の取込が1件残るため、終了時に表示される掃除SQLを実行すること）。

### F. RLS・認可（39〜67。2026-08-12レビュー対応で追加）

| # | 項目 | 結果 |
|---|---|---|
| 39-58 | 5テーブル×SELECT/INSERT/UPDATE/DELETE: anonはすべて拒否（20項目） | PASS |
| 59-61 | admin_invoice_*（3関数）は誤ったスタッフキーで拒否 | PASS |
| 62-63 | helper関数（invoice_norm_code / invoice_name_similarity）はanonから実行不可 | PASS |
| 64-65 | anon / authenticated は public schema へ CREATE 不可 | PASS |
| 66 | admin_invoice_* のEXECUTEはPUBLICに無し・anon/authenticatedにのみ有り（proacl実測） | PASS |
| 67 | admin_invoice_*（SECURITY DEFINER）のsearch_pathが固定されている | PASS |

## ロールバック完全性（invoice_rollback.test.sql・2026-08-12 実測）

トランザクション内でロールバックSQLを実行 → 5テーブル＋7関数（admin_invoice_* 3・
invoice_norm_phone/name/code・invoice_name_similarity）の**残存0件**を確認 → rollbackで復元。
結果: **PASS（残存なし）**。

## dry-run の無書込み確認（2026-08-11 実測）

1. `invoice_imports / invoice_documents / invoice_lines / product_name_aliases` の件数を記録（すべて0件）
2. `node scripts/import-invoices.mjs --dir <サンプル> --dry-run` を実行
3. 再度件数を確認 → **すべて0件のまま**（dry-runはRPCを一切呼ばないコードパス）

あわせて: 実請求書配置場所 `import/invoices/` は .gitignore 済み（`git check-ignore` で確認、
`_samples/` のみGit管理）。dry-runのコンソール出力は電話番号を下2桁以外マスクする。

## 名寄せの実行範囲（import-invoices.mjs）

- 既定: **今回新規投入した import_id だけ**を1件ずつ `admin_invoice_run_matching` に渡す
  （skipされた既存ファイル・過去の未照合/候補ありデータは触らない）
- `--rematch-all` を明示指定したときだけ全件再照合（p_import_id=null）
