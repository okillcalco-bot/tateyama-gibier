# 実DBテスト（請求書ステージング）

## ファイル構成

| ファイル | 内容 |
|---|---|
| `invoice_staging.test.sql` | 1/3 本体テスト（投入・冪等・名寄せ・数字コード・ハイフン・同時投入・RLS/認可）／80件 |
| `invoice_confirm.test.sql` | 2/3 確認画面テスト（矛盾拒否・手動確定・商品alias・金額検算・実績反映/取消・監査・認可）／38件 |
| `invoice_confirm_hardening.test.sql` | 2/3 ハードニング（状態ゲート・親行ロック・検索・alias残存・担当者必須・認可網羅）／41件 |
| `phase4_usual_prices.test.sql` | 3/3（いつもの自動生成の取消除外/pin保持/saved_items不変・価格比較・portal_enabled・認可）／22件 |
| `phase4_portal_e2e.test.sql` | 3/3 顧客ポータル実連携（order.html が呼ぶ portal_* を login→usual→last→rebuild→place_order→favorite で通し検証。3社分の試験データ・在庫を begin/rollback で用意）／25件 |
| `invoice_rollback.test.sql` | ロールバックSQLの完全性テスト（全オブジェクト削除→残存0件→復元） |
| `concurrent-import.test.mjs` | 同時投入の冪等テスト（`Promise.all`・任意・要スタッフキー） |
| `concurrent-finalize.test.mjs` | finalizeと編集の同時実行テスト（親行ロックの直列化・A/B/C・任意・要スタッフキー） |
| `../e2e/invoice-import.e2e.js` | 確認画面のPlaywright E2E（390px・タップ44px・矛盾表示・検索の特異性・担当者必須・確定→対応づけ→反映）／24件 |

## テスト件数（2026-08-13 本番DBで実測）

- 1/3 `invoice_staging.test.sql`: **80/80 PASS**（名寄せRPCを取込単位ロック方式へ再構築後も回帰なし）
- 2/3 `invoice_confirm.test.sql`: **38/38 PASS**
- 2/3 `invoice_confirm_hardening.test.sql`: **41/41 PASS**
- 3/3 `phase4_usual_prices.test.sql`: **22/22 PASS**
- 3/3 `phase4_portal_e2e.test.sql`: **25/25 PASS**（2026-08-16 本番DBで実測・残骸0件。いつもの表示/取消除外/再集計冪等/お気に入り不変/is_hidden非表示/顧客間分離/過去価格不使用・現在価格サーバー再解決/在庫切れ・販売停止の理由つき拒否/portal_enabledゲート/二重注文防止/不正トークン拒否）
- E2E `invoice-import.e2e.js`: **24/24 PASS**／`portal-config.e2e.js`: **14/14 PASS**（Playwright 390×844）

## フェーズ4(3/3)（phase4_usual_prices.test.sql・2026-08-13 実測 22/22 PASS）

対象: `migrations/20260813_phase4_usual_prices.sql`（本番適用済み）。

- いつもの商品の自動再集計 `admin_recompute_usual_items`: `customer_purchase_facts` の
  **canceled_at is null のみ**を集計（取消済み実績を除外）／is_pinned・is_hidden を保持／
  実績が消えた非pin行を削除（pin行は残す）／**customer_saved_items を参照も更新もしない**。
- 顧客別価格比較 `admin_customer_price_comparison`: 適用価格・出所（個別/ランク/標準）・
  standard・ランク価格・個別価格・standardとの差額。resolve_unit_price に一元化。
- ポータル利用 `admin_list_portal_enabled` / `admin_set_portal_enabled`（担当者必須・
  security_events へ監査・住所/電話/キーは残さない）。
- 認可: 新5RPC PUBLIC無・anon/authenticated有・SECURITY DEFINER・search_path固定。誤スタッフキー拒否。
- E2E `portal-config.e2e.js`（390px）: タブ・一覧・価格比較（個別・差額-500）・いつもの・
  顧客別/全再集計・トグル・担当者名なしでは状態変更しない・横スクロールなし。

## 実行方法

- **psql の場合（`-v ON_ERROR_STOP=1` は必須）**:

  ```
  psql -v ON_ERROR_STOP=1 -f tests/db/invoice_staging.test.sql
  ```

  ON_ERROR_STOP なしだと、途中で raise exception が発生しても後続の rollback まで実行され、
  プロセス終了コードが 0 になることがある（＝失敗を見逃す）。
- **Supabase SQL Editor / API（MCP execute_sql）の場合**: ファイル全体を貼り付けて実行し、
  エラー応答の有無で判定する。

全体が `begin` 〜 `rollback` で囲まれているため、

- テストデータ（顧客・取込・明細・対応表）は**一切本番に残らない**
- スタッフキーもトランザクション内で一時キーに差し替えられ、rollbackで元に戻る
- 例外で中断した場合もトランザクションごと巻き戻る（テスト残骸は残らない）

### 合否の機械判定

**ok=false が1件でも存在した場合はテスト失敗**。`invoice_staging.test.sql` は結果表の表示後、
ok=false があれば最後のDOブロックが `raise exception` してSQL全体を失敗させる
（psqlでは ON_ERROR_STOP=1 により終了ステータス非0、SQL Editor / API ではエラー応答。
例外メッセージに失敗テスト名の一覧が入るため目視不要で検知できる）。
全件PASSなら NOTICE `ALL TESTS PASSED` が出て正常終了する。
`invoice_rollback.test.sql` も同様（残存オブジェクトがあれば raise exception）。

## テスト項目と直近の実行結果

実行日: 2026-08-12（JST・再レビュー対応後に全件再実行）／ 対象: 本番DB `clpdyrehdgzgiidbfucj` ／
結果: **80/80 PASS**

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

判定方法（2026-08-12 再レビュー対応で改訂・「ラベル付きコードの事前抽出」方式）:

1. 請求書文字列（宛名・宛先・備考）を正規化（大文字化・全角→半角・ハイフン類6種の統一・
   前後空白除去）し、**customersとの照合より先に**「顧客コード」「顧客番号」「お客様コード」
   「お客様番号」「得意先コード」「得意先番号」「客先コード」「客先番号」等の
   ラベル直後にある `[A-Z0-9-]{4,}` をコード候補として抽出する
2. ラベル付き候補が**複数種類** → DBに存在するかに関わらず自動確定しない
   （未登録・OCR誤読のコードが混ざっていても、DBに残った1件へ寄せない）
3. ラベル付き候補が**1種類だけ** → 正規化後の customers.code と完全一致で照合し、
   該当顧客が1件のときだけ match_status='確定'・matched_by='auto'・match_confidence=1.00
4. 抽出コードが**DBに存在しない** → 未照合/候補あり（既存顧客へ推測で確定しない。
   このとき電話一意でも「確定」にせず候補提示に留める）
5. 同じコードの複数回印字は distinct 後の1種類として扱う
6. **ラベル付き候補が1つも無いとき**だけ、英字入りコードの境界一致
   （`(^|[^A-Z0-9-])コード($|[^A-Z0-9-])`）を従来どおり使う（数字のみコードはラベル必須のまま）

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

### F. RLS・認可（39〜74。2026-08-12レビュー対応で追加、再レビューでhelper4本へ拡張）

| # | 項目 | 結果 |
|---|---|---|
| 39-58 | 5テーブル×SELECT/INSERT/UPDATE/DELETE: anonはすべて拒否（20項目） | PASS |
| 59-61 | admin_invoice_*（3関数）は誤ったスタッフキーで拒否 | PASS |
| 62-69 | helper4本（norm_code / name_similarity / norm_phone / norm_name）× anon・authenticated の直接EXECUTEをすべて実測で拒否（8項目） | PASS |
| 70-71 | anon / authenticated は public schema へ CREATE 不可 | PASS |
| 72 | admin_invoice_* のEXECUTEはPUBLICに無し・anon/authenticatedにのみ有り（proacl実測） | PASS |
| 73 | admin_invoice_*（SECURITY DEFINER）のsearch_pathが固定されている | PASS |
| 74 | helper4本の権限表: PUBLIC(grantee=0)のEXECUTEエントリ無し＋anon/authenticatedともhas_function_privilege=false | PASS |

### G. ラベル付きコードの事前抽出（75〜79。2026-08-12再レビュー対応で追加）

「DBに存在する一致コードが1件」ではなく「請求書に印字されたラベル付きコードが1種類」を
先に確認してから照合する（未登録・OCR誤読コードの検出）。

| # | 項目 | 結果 |
|---|---|---|
| 75 | 既知ZC901+未登録ZC999が両方ラベル付きで印字 → ZC901へ自動確定しない | PASS |
| 76 | 同じZC901がラベル付きで2回印字 → distinct後1種類として確定できる | PASS |
| 77 | 未登録コードZC999だけがラベル付きで印字 → customer_id無しで未照合 | PASS |
| 78 | ラベル付きZC999＋ラベルなしの既知ZC901が併記 → ZC901へ自動確定しない | PASS |
| 79 | OCR表記揺れ（全角ｚｃ・EMダッシュ）を正規化後に複数コードとして検出 | PASS |

### H. 再照合で前回の候補情報を残さない（80〜82。2026-08-12再レビュー対応で追加）

未照合へ戻すときは customer_id / match_method / matched_by / matched_at を null、
match_confidence を 0 にクリア。候補ありへ更新するときも全列を今回の判定結果で
置き換え、matched_by / matched_at（「確定」を意味する列）は入れない。

| # | 項目 | 結果 |
|---|---|---|
| 80 | 名称一致で候補顧客Aが付く（前提。matched_by/matched_atはnull） | PASS |
| 81 | 生データ変更→再照合で候補A→候補Bへ完全に置き換わる | PASS |
| 82 | 一致しない状態へ変更→再照合で未照合・customer_id/method/by/at=null・confidence=0 | PASS |

## フェーズ4(2/3) 確認画面（invoice_confirm.test.sql・2026-08-12 実測 38/38 PASS）

対象: `migrations/20260812_invoice_confirm.sql`。すべて `begin`〜`rollback` 内で実行し本番に残さない。
名寄せRPCの差し替え後も 1/3 の全挙動（A〜H）が回帰なしであることを別途確認済み（64/64 PASS）。

| 区分 | 検証項目 | 結果 |
|---|---|---|
| §5 矛盾 | 顧客コードと電話が別顧客 → 自動確定せず候補あり・match_conflict=true・conflict_detail | PASS |
| §4 手動 | 候補/矛盾を人が手動確定 → 確定・match_method=manual・customer_confirmed_by記録 | PASS |
| §8 検算 | 明細合計=請求書合計で差額0 / 差額ありは要確認 / 差額の理由入力で確認済へ | PASS |
| §8 拒否 | 差額の理由なしでは実績反映を拒否 | PASS |
| §9 拒否 | 未対応明細があると反映拒否・拒否時は実績0件 | PASS |
| §7 商品 | 対応づけで確定・alias保存（次回前埋め）／別商品は保留／対象外は反映せずブロックもしない | PASS |
| §7 alias | 確定済みaliasが次回取込の同名明細を match_method='alias' で前埋め | PASS |
| §10 反映 | 確定分のみ実績へ・購入日=納品日/請求日・source_id=明細idで一意 | PASS |
| §10 冪等 | 連打・再送は already=true で実績が増えない | PASS |
| §10 原子 | 一部docが未確定なら例外で全体ロールバック（先行docの実績も作られない） | PASS |
| §11 取消 | 物理削除せず canceled_at/by/reason を記録・有効実績0件（集計除外用）・確認済へ | PASS |
| §11 二重 | 反映済み（取込済）以外の取消を拒否（二重取消拒否） | PASS |
| §11 再反映 | 取消後の再反映で同一source_idが復活し件数は増えない | PASS |
| §12 監査 | invoice_audit に customer_confirm/product_map/amount_reason/finalize/cancel を記録 | PASS |
| §14 認可 | 新RPC全9本 誤スタッフキーで拒否・PUBLIC EXECUTE無し・search_path固定 | PASS |
| §14 遮断 | invoice_audit は anon 直アクセス不可・内部関数(_invoice_*)は anon/authenticated 実行不可 | PASS |

E2E（`tests/e2e/invoice-import.e2e.js`・Playwright 390×844・22/22 PASS）: 取込タブ表示・状態別フィルタ8種・
横スクロールなし・詳細全画面・矛盾警告表示・抽出元/確度表示・金額検算表示・未確認時は反映ボタン無効・
詳細ボタンのタップ領域44px以上・顧客ピッカー検索と確定・商品対応づけ・全確定後の実績反映。

## フェーズ4(2/3) ハードニング（invoice_confirm_hardening.test.sql・2026-08-13 実測 41/41 PASS）

対象: `migrations/20260813_invoice_confirm_hardening.sql`（本番適用済み）。Codexレビュー対応。

| 区分 | 検証項目 | 結果 |
|---|---|---|
| 修正4 担当者必須 | set_customer / map_product 等で担当者名(p_by)が空白だと拒否（'staff'フォールバック廃止） | PASS |
| 修正1 状態ゲート | 取込済で set_customer / map_product / set_amount_reason を直接呼ぶ → 「編集できません」で拒否 | PASS |
| 修正1 run_matching | 取込済の取込は再照合の対象外（変更なし・skip） | PASS |
| 修正1 直列化 | 取消→確認済で編集可能 → 商品変更→再反映で facts が新商品へ更新・行数不変 | PASS |
| 修正1 直列化 | 取消→顧客変更→再反映で facts が新顧客へ更新・行数不変 | PASS |
| 修正1 除外 | 除外中の顧客・商品・差額理由変更 → 拒否 | PASS |
| 修正3 残存クリア | 別商品/対象外で invoice_lines.product_id=null・product_decided_by 更新・alias.product_id=null | PASS |
| 修正2 検索 | 日本語店名で該当のみ（無関係を返さない）／カナ／コード／電話下4桁で該当 | PASS |
| 修正2 検索 | 数字なし語で電話条件は無効／「%」「_」だけで全件返さない／空白は空配列／81字は拒否 | PASS |
| 追加5 認可 | 新RPC9本 PUBLIC無・anon/authenticated有・SECURITY DEFINER・search_path固定 | PASS |
| 追加5 認可 | 内部関数4本（_invoice_actor/_invoice_lock_editable/_invoice_audit/_invoice_recompute_import_status）を PUBLIC/anon/authenticated から実行不可 | PASS |
| 追加5 認可 | 誤スタッフキーで detail/products/customer_search/map_product を拒否 | PASS |
| 追加5 RLS | invoice_audit を anon・authenticated の SELECT/INSERT/UPDATE/DELETE すべて拒否（8項目） | PASS |

### finalize と編集の同時実行（concurrent-finalize.test.mjs・要スタッフキー）

`TGC_STAFF_KEY=… node tests/db/concurrent-finalize.test.mjs` で、2セッションから `Promise.all` で同時実行:

- **A**: finalize と 商品変更 → 編集が先勝ちなら成功・finalize が反映、finalize が先勝ちなら編集は「編集できません」で拒否。どちらでも最終状態は「取込済」で一部反映なし。
- **B**: finalize と 顧客変更 → A と同様。
- **C**: finalize ×2 → ちょうど1本だけ実績反映（already=false・facts=1）、もう1本は already=true（実績は増えない）。

いずれもすべての編集/反映/取消RPCが変更前に対象 `invoice_imports` 行を `FOR UPDATE` でロックし、
**ロック取得後に** status を判定することで直列化される（ロック前に status を読んで判断しない）。
※本番DBに一時データと実在顧客への購入実績を作るため、終了時に表示される掃除SQLを実行すること。

### 担当者名（actor）の位置づけ

`p_by`（担当者名）はスタッフキー利用者による**自己申告の操作名**であり、Supabase Auth 移行までは
認証済み本人を証明するものではない（画面にも明記）。移行後は actor を `auth.uid()` に結びつける前提。

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
