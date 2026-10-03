# 05 試験結果と未検証項目（2026-10-03 実行）

## 実行したもの
| 試験 | 環境 | 結果 |
|---|---|---|
| 連携の結合試験 `test/run-all.mjs`（指示書9章） | ローカルの使い捨て PostgreSQL 16（本番の定義・RLS を写したもの）＋MCPハンドラー（実際のHTTP要求・署名付きトークン） | **145/145 合格**（2026-10-03 に aud 差し替えフック案の5項目を追加） |
| 画面の e2e `tests/e2e/seamalt-review-guard.e2e.js` | Chromium（API はモック） | **19/19 合格**。ガードを外すと3件落ちることも確認（試験が効いている） |
| 既存の e2e 全137本（回帰） | 同上 | 123本合格。不合格14本のうち13本は main でも同じ件数で不合格（日付が10月に変わったことによる請求番号・支払期限の期待値ずれ、撮影系の環境依存など、今回の変更と無関係）。残る1本 capture-furigana-area は並列実行時だけ落ち、単独で2回合格（変更していない画面） |

指示書が名指しした既存試験: manual-order-products 6/6、order-detail-part-consolidation 6/6、orders-list-sort 8/8、shipment-data-tab 18/18、
ship-new-customer-register 16/16、direct-ship-pricing 合格、base-ship-freight 14/14、document-duplicate-order-warning 6/6、
**document-multi-order-unique-constraint 9/11（main でも同じ2件が不合格: 期待値が9月固定）**。

## 結合試験の内訳（全項目）
```
PASS : 保護リソースメタデータ: resource・authorization_servers・scopes を返す
PASS : 未認証: 401 と WWW-Authenticate（resource_metadata）
PASS : 拒否: 署名が違う鍵 → 401 invalid_token
PASS : 拒否: 期限切れ → 401 invalid_token
PASS : 拒否: audience 違い → 401 invalid_token
PASS : 拒否: issuer 違い → 401 invalid_token
PASS : 拒否: 寿命が長すぎる（24時間） → 401 invalid_token
PASS : 拒否: 許可していないクライアント → 401 invalid_token
PASS : 拒否: HS256（対称鍵） → 401 invalid_token
PASS : 拒否: alg=none → 401 invalid_token
PASS : initialize: プロトコル版と手順の instructions
PASS : 通知には 202 で応答のみ
PASS : tools/list: 5つだけ（汎用SQL・ステータス変更・顧客作成・在庫・請求・送信は無い）
PASS : 読取りツールは readOnlyHint=true・書込みツールは false。全ツール oauth2 の securitySchemes
PASS : GET /mcp は 405（SSE は使わない）
PASS : ブラウザーの Origin 付き要求は 403
PASS : 本文 256KB 超は 413
PASS : 検索のページ送り: 130件を 50/50/30 の3ページで重複なく取得し、最後だけ complete=true
PASS : 1ページ目は complete=false（直近の件数だけで「未登録」と判断させない）
PASS : 検索結果に出荷・請求・取消の状態が並ぶ（BASE-E2 は出荷済・請求済、E3 はキャンセル）
PASS : 検索の照合根拠（match_basis）を返す
PASS : 担当顧客を限定した主体には担当外の注文が出ない
PASS : 担当外の order_id を指定すると forbidden
PASS : A preview: 候補を保存（受注は未登録）・commit_ready
PASS : A preview: 顧客が一意に一致・商品は exact（猪ロース→イノシシ ロース）
PASS : A preview: 「2本」を kg に換算しない（normalized_kg=null）・重量未確定の警告
PASS : A preview: 「フレッシュ」の意味は確認事項にする（冷蔵と決めつけない）
PASS : A preview: 納品日空欄は警告だけ（日付を補わない）
PASS : A preview: orders は増えない
PASS : A preview を同じメールで再実行しても候補は増えず同じ版（1段目）
PASS : A commit: created・受注として登録・要確認（フレッシュ）
PASS : A commit: 在庫確保・出荷・請求はしていないと明示
PASS : A commit: detail_url は受発注画面の ?order= リンク
PASS : A 再読: 外部注文ID・状態・出典（添付名・SHA-256）が一致
PASS : A 再読: 原文単位（2本）を保持し、requested_kg・重量・単価・金額は null（0 を入れない）
PASS : A 再読: 納品日 null・合計 null・温度帯 fresh・希望条件の原文
PASS : A 再読: 履歴に「誰の依頼で」が残る
PASS : A: orders.status は既存の「受注」、channel は既存の「メール」（新しいステータス・経路を足さない）
PASS : 転送メール（同じPDF）: already_exists・新しい注文を作らない
PASS : 転送メール: 同じファイル（SHA-256）が別メールにあると知らせる
PASS : 本文だけの再送（別メール・同じ外部ID・同じ内容）: already_exists
PASS : 同じメール・添付の再処理: already_exists
PASS : 再送・転送を何度送っても注文は1件のまま
PASS : 1つの外部注文に複数のメール・添付が結び付く（出典3つ）
PASS : B preview: 「肩」→カタ は名称が違うので確認待ち（自動で置換しない）
PASS : B preview: スネは exact
PASS : B 確認前の commit は needs_review（登録しない）
PASS : B preview（確認後）: 版が上がり commit_ready
PASS : B 古い版で commit すると conflict（上書きしない）
PASS : B commit: created・確認済み（冷凍・kg 指定なので要確認なし）
PASS : B 再読: 2明細・各 0.6kg と原文「600g」の両方
PASS : B 再読: 部位は価格マスタの表記（カタ・スネ）・温度帯 frozen・納品希望日
PASS : B 次回: 確認済みの対応表（猪 肩→カタ）を再利用
PASS : C preview: 温度帯未記載と「1頭」を確認事項に挙げる（冷凍と推定しない）
PASS : C preview: 枝肉は価格マスタの「枝肉（全体）」に揃える・1頭を1パック扱いしない（kg なし）
PASS : C commit: 要確認の受注として保存
PASS : C: 開いて（読んで）も確認済にならない
PASS : ガード: 出荷画面の「受注→確認済」(anon PATCH) を拒否
PASS : ガード: 管理RPC admin_set_order_status(発送済) も拒否
PASS : ガード: 出荷記録 shipments の作成を拒否
PASS : ガード: 請求書 documents の作成を拒否
PASS : ガード: まとめ請求 document_orders への追加を拒否
PASS : ガード: 在庫の引当 inventory_allocations を拒否
PASS : ガード: 明細へのパック割当（order_items.inventory_id）を拒否
PASS : ガード: 取込でない既存注文は従来どおり 受注→確認済 にできる（回帰なし）
PASS : 一覧・出荷画面のバッジ用: 要確認と未確認項目コードだけ返す（キー無しでも）
PASS : 注文詳細の取込欄（原文・出典）はスタッフキー必須
PASS : 注文詳細の取込欄: 外部注文ID・原文数量・温度帯・出典・履歴
PASS : 確認: 温度帯を選ばずに確認済にはできない
PASS : 確認: 冷蔵を選んで確認すると確認済みになる
PASS : 確認後は 受注→確認済 に進める（承認された段階へだけ進む）
PASS : 確認の履歴が残り、温度帯は chilled に
PASS : 同じPDFの2注文: 2件とも登録（同じ添付を処理済みとして落とさない）
PASS : 同じPDFの2注文: 出典（添付）は1行で、2つの注文から参照
PASS : 同じ外部IDで数量変更: conflict（変更候補）・既存注文を示す・上書きしない
PASS : 変更候補の commit は登録しない
PASS : 変更候補があっても元の注文は2本のまま
PASS : 変更候補は差分の原本（3本）を候補に保持
PASS : 同じ冪等キーで別の内容: conflict（上書きしない）
PASS : commit を同時に2回（同じキー）: 1注文だけ
PASS : 登録直後に応答を失い、同じキーで再送: 増えない（前回の注文を返す）
PASS : order_import_status: キーから登録済みの注文と履歴を確認できる
PASS : order_import_status: 未実行のキーは「記録なし」と返す
PASS : commit を同時に2回（別のキー）: 1注文だけ
PASS : 外部IDの無い既存注文を候補に出す（手入力・BASE・取消・直接出荷）・自動で結合しない
PASS : 候補ごとに出荷済・請求済・取消の状態を返す（新規未処理と誤認しない）
PASS : 「同じ注文」と確認: 新しい注文は作らず既存注文に外部IDを結び付ける
PASS : 結び付けても既存注文（orders）の中身は変えない
PASS : 結び付け後の再送は 2段目で already_exists
PASS : 「別の注文」と全候補を確認したら登録できる
PASS : 番号の無い注文: external_order_id は null のまま、確認済み出典の識別子で保持
PASS : 番号の無い注文の同じメール再処理: already_exists
PASS : 注文番号が読めない: 確認待ち（欠落のまま登録しない）
PASS : 明細の保存に失敗: failed・ヘッダーだけ残らない・外部参照も残らない
PASS : 明細の保存に失敗: 失敗だけを履歴に記録（SQLSTATE のみ・本文なし）
PASS : 原因を直して同じキーで再実行すると登録できる（失敗は冪等キーを消費しない）
PASS : 監査の保存に失敗: 注文も残さない（監査なしの登録をしない）
PASS : read のみの主体は preview できない（forbidden + 再認可の _meta）
PASS : read のみの主体でも読取りはできる
PASS : 失効した主体は読取りも拒否
PASS : 登録されていない主体（正しい署名でも）は拒否
PASS : 他人の candidate_id を commit できない
PASS : 他人の candidate_id の状態も見られない
PASS : 別組織の指定は拒否
PASS : ユーザー確認（confirmed_by_user=true）が無い commit は検証エラー
PASS : 検証エラー: UUID でない
PASS : 検証エラー: 存在しない日付
PASS : 検証エラー: タイムゾーンなしの日時
PASS : 検証エラー: 小数4桁
PASS : 検証エラー: 未知の単位
PASS : 検証エラー: 未知の項目
PASS : 検証エラー: 外部IDありなのに値なし
PASS : 検証エラー: 番号なしなのに外部IDを指定（捏造防止）
PASS : 検証エラー: 明細51行
PASS : 検証エラー: 原文501文字
PASS : 検証エラー: line_no の重複
PASS : 検証エラー: https 以外のリンク
PASS : 検証エラー: 期間の逆転
PASS : 外部本文の命令・HTML: データとして候補に入るだけ（商品名が違うので確認待ち）
PASS : 外部本文の命令: 取消は起きない・外部への通信も起きない
PASS : seamalt_mcp: orders を直接読めない
PASS : seamalt_mcp: 補助表（候補）を直接読めない
PASS : seamalt_mcp: 内部関数（evaluate・order_brief）を実行できない
PASS : seamalt_mcp: 顧客台帳を直接更新できない
PASS : anon: api_* を実行できない
PASS : anon: 補助表を読めない
PASS : authenticated: 補助表を読めない
PASS : サーバーログにトークン・顧客名・本文が出ていない
PASS : 移行前（現状）: キー無しの anon でも全注文が読める（＝守られていない）
PASS : 段階A: キーの有無ごとに書込みを数える（拒否はしない）
PASS : 段階B: キー無しの anon は注文を読めない
PASS : 段階B: キー無しの anon は注文を書けない
PASS : 段階B: キー無しの anon は明細を読めない
PASS : 段階B: スタッフキー付きなら従来どおり読み書きできる
PASS : 段階B: 違うキーでは読めない
PASS : 段階B: 出荷画面のバッジ関数はキー無しでも動く（個人情報なし）
PASS : 段階B: MCP の読取り・取込は影響を受けない
PASS : 段階Bの切戻し: 既存画面の読み書きが戻る
PASS : 段階Bの切戻しと同時に、連携の新しい書込みは止まる（取込を続けない）
PASS : 連携停止中も読取りはでき、登録済みの注文・外部参照・監査は残る
PASS : フック: 許可リストの client_id だけ aud を MCP の URL にする（他のクラームは残す）
PASS : フック: 通常のログイン（client_id なし）は aud を変えない
PASS : フック: 許可リストにないクライアント・取り消したクライアントは変えない
PASS : フック: anon・authenticated・seamalt_mcp は実行できない
PASS : MCP を aud=MCP の URL だけにすると、aud=authenticated のトークンは 401・差し替え後のトークンは通る
```

## 起動と再実行
```bash
cd integrations/seamalt && npm install          # pg（試験用）だけ
./test/start-local-pg.sh                        # 127.0.0.1:55432 に使い捨てDB
node test/run-all.mjs                           # 毎回新しいDBを作って最後に消す（KEEP_DB=1 で残す）
NODE_PATH=/opt/node22/lib/node_modules node tests/e2e/seamalt-review-guard.e2e.js   # リポジトリ直下から
```
架空のメール・PDF: `test/fixtures/mail/*.eml`（7通・転送/再送/2注文入りPDF/命令文入り）、`test/fixtures/*.pdf`（`make-pdfs.cjs` で再生成）。

## 未検証（本番・実機でしか確かめられないもの）
- 本番DBへの適用（10/20/21 の SQL）。ローカルでは本番の定義を写したDBで適用・試験済み。
- Supabase Edge Function（Deno）上での動作と、`npm:pg` から Supavisor への接続。ハンドラーは Web 標準 API だけで書き、Node で試験した。
- Supabase OAuth 2.1 サーバー（ベータ）と ChatGPT の接続（DCR・同意画面・トークン）。特に aud=authenticated のトークンを受け入れる点（04 参照）。
- シーモルトの会話での「読取→照合→preview→確認→commit→再読」の通し。会話側の手順はツールの説明と instructions で誘導しているが、実際のモデルの振る舞いは未確認。
- 段階B（キー必須）で止まる端末・画面の実数。段階Aの計測で確かめる。
- MCP Events（新着通知）は第2段階として未実装。
