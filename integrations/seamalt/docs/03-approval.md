# 03 本番で承認が必要な操作（未実施）

この連携は **ローカル実装・ローカル試験まで完了／本番未適用・未接続** です。以下はどれも本人の承認があるまで実行しません。
順番は上から。各段で止めて結果を確認できます。

| 段 | 操作 | 対象・権限 | 費用 | 影響 | 戻し方 |
|---|---|---|---|---|---|
| A | **認可移行 段階A（計測）** `sql/20_orders_authz_stageA_measure.sql` | orders/order_items に AFTER トリガー（キー有無を日別に数える） | なし | 何も拒否しない。書込み1件ごとに計数1行の更新 | ファイル末尾の drop trigger 2行 |
| B | **補助表・API関数・要確認ガード** `sql/10_order_link.sql` | 新スキーマ order_link、ロール seamalt_mcp（NOLOGIN で作成）、既存6表にガード用トリガー | なし | 既存注文には影響なし（ガードは取込注文の要確認だけに効く）。新しい関数3つを anon に公開（中身は上記） | 下記「切戻し」 |
| C | **画面の差分をデプロイ**（このブランチの index.html / order-admin.html） | PR → squash merge → Vercel | なし | 取込注文のバッジ・詳細欄・確認操作・`?order=` リンク。DB側（B）が未適用でも何も変わらない作り（試験済み） | revert PR |
| D | **認可移行 段階B（キー必須）** `sql/21_orders_authz_stageB_enforce.sql` | orders/order_items の anon・authenticated ポリシーを「スタッフキーのヘッダ必須」に | なし | **スタッフキー未設定の端末では、出荷一覧・BASE取込・直接出荷が注文を読めず書けなくなる**。A の計測で「キー無しの書込み=0」が1週間続き、出荷に使う全端末へ共有リンクでキーを配ってから | `sql/22_orders_authz_stageB_rollback.sql`（同時に連携の書込みを止める） |
| E | **Supabase Auth の OAuth 2.1 サーバーを有効化**（ダッシュボード > Authentication > OAuth Server。**ベータ機能**・ベータ期間は無料） | Authorization Path を `/oauth-consent.html`、動的クライアント登録（DCR）を有効化 | 現状無料（ベータ） | Site URL（Authentication > URL Configuration）が同意画面のドメインになる。現在の Site URL の用途を確認してから | 無効化する |
| F | **同意画面を配置** `consent/oauth-consent.html` をサイト直下へ（C と同じPRに入れてもよい） | 静的ページ1枚（公開キーのみ） | なし | なし | ファイル削除 |
| G | **秘密値の登録**（本人がダッシュボードで） | `alter role seamalt_mcp login password '…'`（SQLエディタで本人が実行）、Edge Function Secrets に `SEAMALT_DB_URL` | なし | なし | `alter role seamalt_mcp nologin` |
| H | **Edge Function `seamalt-mcp` をデプロイ**（`--no-verify-jwt`。トークン検証は関数内で行うため） | 関数1本・設定値は `.env.example` | Supabase の Edge Function 実行回数（無料枠内の見込み） | 外部から `/functions/v1/seamalt-mcp/mcp` に到達可能になる（認証必須） | 関数を削除 |
| I | **主体の登録**（本人1名・read+import） | `insert into order_link.principals(issuer, subject, display_name, staff_name, scopes) values ('https://clpdyrehdgzgiidbfucj.supabase.co/auth/v1', '<auth.users の本人id>', '沖', '沖浩志', array['orders:read','orders:import']);` | なし | なし | `update … set revoked_at = now()` |
| J | **シーモルトから接続**（ChatGPT 開発者モードで MCP を追加 → OAuth で許可） | 04-connect.md | ChatGPT 側の契約範囲 | 既存顧客情報（注文の店名・配送先）がシーモルトの会話に出る＝**新サービスへの送信**にあたる | 下記「切戻し」・ChatGPT 側で接続を削除・Supabase で grant を取り消し |
| K | 架空注文での実機試験（O-DEMO-001〜003） | 本番に架空の注文が3件できる（テスト後キャンセル。削除はしない） | なし | 受注一覧に「練習」の注文が出る | ステータスをキャンセル |

**認可移行（D）が済むまで、実顧客の新しい注文の取込（commit）は始めません。** A〜C と E〜K（架空注文での導通）は D の前でも実施できますが、D の前は `writes_paused=true` のまま読取りと架空注文だけにする運用を推奨します。

## バックアップ
- 適用前: Supabase ダッシュボード > Database > Backups で当日の自動バックアップがあることを確認（Pro 以上は日次・PITR は契約次第）。
- 加えて、触る表の定義を保存: `pg_dump --schema-only -t public.orders -t public.order_items -t public.shipments -t public.documents -t public.document_orders -t public.inventory_allocations`（定義だけ・個人情報なし）。
- 既存データは書き換えない設計（取込は追記のみ・補助表は新設）なので、データのバックアップを戻す必要が出るのは想定外の事故だけ。

## 切戻し（連携の停止）
`sql/90_seamalt_pause.sql`:
1. 即時: `writes_paused=true` → preview / commit が `forbidden` になる。読取りは続く。
2. 完全停止: `alter role seamalt_mcp nologin` と Edge Function の削除。
3. 登録済みの注文・外部参照・出典・監査は**消さない**。orders/order_items の認可を全開放に戻さない（段階Bを入れた後で連携だけ止める場合）。
4. 要確認ガードは残す（取込済みの要確認注文が確認なしに出荷へ進まないように）。外すのは要確認が0件になってから。

## 既知の残課題（今回の認可移行の範囲外）
- shipments / documents / document_orders / inventory など計56表が anon キーで全行読み書きできる。documents には請求先の住所が入る。orders と同じ「スタッフキー必須」への移行を別途提案予定（段階Aと同じ方法で先に計測する）。
- anon / authenticated の TRUNCATE 権限（PostgREST からは呼べない）を剥がす。
- Supabase OAuth のトークンは `aud=authenticated` で、通常のログインと同じく PostgREST にも使える。現状 authenticated は anon と同じ範囲しか開いていない（customers は authenticated に許可なし）ため、新たな露出は増えない。段階B後は orders もスタッフキー必須になる。
