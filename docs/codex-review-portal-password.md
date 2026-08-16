# 注文サイト パスワード再設計（v2）— Codex 再レビュー依頼

前回レビューで指摘された **P0-1 / P0-2 / P0-3 / P0-4 / P1-1〜P1-6** に対応する再設計です。
本番DBへは未適用、main へは未マージ、実顧客への発行・実注文は未実施です（下記「制約の遵守」）。

## ブランチ / 差分

- 新ブランチ: **`claude/tateyama-gibier-portal-password-fix-v2`**（旧 `claude/tateyama-gibier-portal-password-fix` は保存・改変なし）
- ベース: 最新 `origin/main`（P0-4）。**origin/main に対し 0 behind / 3 ahead**。
- 変更ファイル（main 差分＝ポータルパスワード関連のみ。invoice/capture/photo/50音/sw.js/manifest.json には触れていない）:
  - `migrations/20260816_portal_password_reissue_fix.sql`（M1: 発行の42702修正）
  - `migrations/20260816_portal_temp_password_lifecycle.sql`（M2: 仮pw方式・login・complete・ロック・管理RPC）
  - `migrations/20260816_portal_session_require_password_set.sql`（M3: セッションゲート）
  - `migrations/20260816_portal_revoke_legacy_auth.sql`（M4: 旧認証RPCのEXECUTE剥奪）
  - `order.html`（初回変更画面・変更専用トークン）
  - `order-admin.html`（発行平文の消去）
  - `tests/db/portal_temp_password_lifecycle.test.sql`
  - `tests/db/portal_password_reissue.test.sql`
  - `tests/e2e/portal-password.e2e.js`

## 設計の要点（指摘への対応）

### P0-1: 初回変更の総当り・期限迂回の遮断（変更専用トークン方式）
- 旧 `portal_change_password(login, old, new)` の匿名試行を廃止。
- `portal_login_v2` が仮pwを正しく検証したときだけ **15分有効の「変更専用セッショントークン」** を発行する。
- `portal_complete_temp_password(p_temp_token, p_new)` は、そのトークンから顧客を解決し、
  DB側で **must_change / temp_expires_at>now() / portal_enabled / is_active** を確認（`for update`）。
  成功時に `password_hash` 更新・`must_change=false`・`temp_expires_at=null`・`password_changed_at` 記録・
  **当該顧客の全セッション削除（＝変更トークンの単一使用）**・新30日セッション発行。
- クライアントは **変更専用トークンをメモリのみ**に保持（sessionStorage/localStorage に保存しない）。

### P0-2: 旧認証RPCの迂回廃止
- `pg_proc/proacl` で列挙。旧 `portal_login` / `portal_change_password` は **作成時に PUBLIC へ EXECUTE** が付いており、
  anon/authenticated は PUBLIC 経由でも実行できていた。M4 で **PUBLIC・anon・authenticated から REVOKE**（service_role/postgres は保持）。
- ACLテストで「旧2関数は anon/auth 実行不可」「新 `portal_login_v2` / `portal_complete_temp_password` は anon 実行可」を実測。

### P0-3: 再発行時のセッション失効
- `staff_issue_portal_passwords` は各対象顧客について、ハッシュ更新と同一トランザクション内で
  `delete from portal_sessions where customer_id = <対象>` を実行（他顧客には影響しない）。

### P0-4: ブランチのベース
- 最新 `origin/main` から新ブランチを作成。差分は上記のポータルパスワード関連のみ。

### P1-1: 変更前はPIIを返さない
- `portal_login_v2` は `must_change=true` のとき **status/token/expires_at/must_change のみ**返し、
  phone/address/building/price_rank/code 等は NULL。PIIは変更後に `portal_me` で取得。

### P1-2: ロック等の存在推測を防ぐ
- 不存在・停止・無効・pw違い・失効仮pw・ロック中・識別子曖昧は **すべて `status=invalid`** に統一。
  クライアントも単一の汎用メッセージを表示。解除予定時刻（locked_until）は管理RPC
  `admin_portal_credential_status` だけが返す。

### P1-3: ロックのDB反映
- 15分窓で失敗回数を原子的に加算（`for update` 済み行に対する UPDATE）。5回目で `locked_until=now()+15min`。
  外部応答は invalid のままでも、DBに `locked_until` が入ることをテストで確認。

### P1-4: 識別子の曖昧一致
- `count(distinct c.id)` が1でなければ（portal_login_id と他顧客の code が衝突する等）invalid。
  ダミー `crypt` でタイミングも均一化。

### P1-5: 平文のメモリ/DOM/ストレージ残存を排除
- order.html: 入力平文はログイン/設定成功で即クリア。変更専用トークンは永続化しない。
- order-admin.html: `wipeIssuedSecrets()` を **コピー/CSV/印刷の finally** と **編集モーダルを閉じるとき** に実行し、
  `__issuedPw`/`__issuedLink` をメモリ・DOM・名簿から消去。印刷ウィンドウは印刷後に本文を消して閉じる。
  console/localStorage/sessionStorage/URL には平文を保存しない。
- **ドキュメント化した例外**: 配布用CSV（差し込み印刷・郵送ラベル用）は仮pw・リンクを平文で含む。
  確認ダイアログでファイルの取り扱い注意を明示し、生成後はメモリ側を消去する。

### P1-6: E2Eの可搬化
- 絶対パス（`/home/user/...`）・セッション固有 scratchpad を排除。ルートは `__dirname`、
  Chromium は `env(PW_CHROMIUM_PATH)`→既知候補→同梱、成果物は `env(PORTAL_E2E_ARTIFACTS)`→`mkdtemp`。
  HTTPサーバは空きポート自動割当。実データ・実認証情報なし。

### 補足対応
- 発行の upsert は `ON CONFLICT ON CONSTRAINT customer_secrets_pkey` を明示（`#variable_conflict use_column` 併用）。
- `portal_sessions` の INSERT は expires_at を明示。
- IP単位制限は「信頼できるIPが無い」ため今回は見送り（偽の共有IPで束ねない）。
  M2冒頭に **gateway移行後に強制する TODO と移行条件** を明記。

## テスト結果（本番DBに対する begin/rollback 実測。commit しない）

### DBテスト `tests/db/portal_temp_password_lifecycle.test.sql`（+ ACL）
必須15項目の対応と結果（すべて **PASS**）:

| # | 必須テスト | 実装アサーション | 結果 |
|---|---|---|---|
| 1 | 総当り遮断 | complete RPCへランダムトークン6連投→常にinvalid | PASS |
| 2 | 失効仮pw拒否 | 期限切れ仮pwは正しくてもlogin invalid | PASS |
| 3 | 通常pwでcomplete不可 | must_change=falseのトークンでcomplete→invalid | PASS |
| 4 | portal_enabled=false遮断 | login invalid / complete時もinvalid(#44) | PASS |
| 5 | is_active=false遮断 | login invalid | PASS |
| 6 | ロック中は変更トークン無し | 正しい仮pwでもinvalid・token無し | PASS |
| 7 | 他顧客トークン拒否 | Aの変更トークンはAのみ変更・Bは不変 | PASS |
| 8 | 使用済みトークン拒否 | complete後の再利用→invalid | PASS |
| 9 | 失効トークン拒否 | 期限切れ変更トークン→invalid | PASS |
| 10 | 再発行でセッション失効 | 再発行後 sessions=0・must_change=true | PASS |
| 11 | 旧RPCでロック迂回不可 | ACL: 旧2関数 anon/auth 実行不可（#200-203） | PASS |
| 12 | 変更前PII無し | must_changeログインで phone/code等NULL | PASS |
| 13 | 曖昧識別子→invalid | 同名衝突でinvalid | PASS |
| 14 | __issuedPw消去 | E2E C1/C3（下記） | PASS |
| 15 | 最新mainで回帰 | 既存E2E緑・本ブランチはmainに0 behind | PASS |

追加アサーション（同ファイル）: 変更後の単一セッション/PII取得、5回目でlocked_until設定（P1-3, #14）、
staff_unlockで復帰、same_as_temp分岐（8桁仮pwで検証, #43）、変更トークンでは portal_session_customer が
NULL（多層防御, #50）、ACL 200-206。**末尾でFAILがあれば例外**（CI検知）。

### DBテスト `tests/db/portal_password_reissue.test.sql`（5件・全PASS）
6桁数字・42702なし・must_change=true/7日失効・既存セッション失効・不存在で全体拒否・不正キーで例外。

### E2E `tests/e2e/portal-password.e2e.js`（16件・全PASS）
- order.html A1-A10: 仮pw→変更画面、変更前PII非表示、変更トークン非永続、8文字/不一致の弾き、
  変更成功で一覧遷移＋PII取得、本トークン保存・平文残存なし、JSエラーなし。
- B1-B2: 失敗は汎用メッセージ・具体的理由を含めない。
- order-admin C1-C4: CSV発行/コピー後に名簿・storage から平文消去、JSエラーなし。

### 回帰
- 既存E2E（例 `seika-search.e2e.js`）緑（exit 0）。変更は order.html / order-admin.html と
  新規マイグレーション/テストに限定され、他機能へ影響なし。

## 認証系RPCのACL（本番現状＝未適用）

`has_function_privilege` 実測。M4適用後の期待値も併記。

| 関数 | 現状 anon/auth | M4適用後（期待） |
|---|---|---|
| portal_login(text,text) | 実行可 | **不可**（PUBLIC/anon/authからREVOKE） |
| portal_change_password(text,text,text) | 実行可 | **不可** |
| portal_login_v2(text,text,text) | 実行可 | 実行可（維持） |
| portal_complete_temp_password(text,text) | （未作成） | 実行可（新規付与） |
| staff_unlock_portal(text,uuid) | （未作成） | 実行可（管理RPC。内部でstaff_key検証） |
| admin_portal_credential_status(text) | （未作成） | 実行可（管理RPC。内部でstaff_key検証） |
| staff_issue_portal_passwords(text,uuid[]) | 実行可 | 実行可（内部でstaff_key検証） |
| admin_issue_customer_link(text,uuid[],int) | 実行可 | 実行可（内部でstaff_key検証） |
| portal_me / portal_catalog / portal_my_orders / portal_place_order / portal_last_order / portal_rebuild_cart / portal_stock_marks / portal_toggle_favorite / portal_usual_items | 実行可 | 実行可（維持。トークン制・M3で must_change=false 必須） |
| portal_session_customer / portal_session_touch | 内部のみ（不可） | 内部のみ（維持） |

M4適用後の実測はレビュー承認後の適用時に取得（begin/rollbackでの事前確認では 200-206 全PASS）。

## 制約の遵守（レビュー承認まで）
- **本番DBへ未適用**（すべて begin/rollback で検証、commit していない）。
- **main へ未マージ**（作業は v2 ブランチのみ）。
- **実顧客への発行・実注文なし**（テストは固定モック値・ダミー顧客のみ）。
- capture/photo/50音/invoice-phase4 のファイル、`sw.js`/`manifest.json` は未変更。

## 承認後の適用手順（案・15ステップ）
1. `20260816_portal_password_reissue_fix.sql`
2. `20260816_portal_temp_password_lifecycle.sql`
3. `20260816_portal_session_require_password_set.sql`
4. `20260816_portal_revoke_legacy_auth.sql`
5. 適用後ACL実測（旧2関数 anon/auth 不可・新RPC anon可）
6. `tests/db/portal_temp_password_lifecycle.test.sql` を本番で begin/rollback 実行 → 全PASS
7. `tests/db/portal_password_reissue.test.sql` 同上
8. order.html / order-admin.html をデプロイ（Vercel）
9. E2E をCIで実行 → 16件PASS
10. ダミー顧客1件で仮pw発行→初回変更→通常ログインの手動スモーク
11. ロック（5回失敗）→ `staff_unlock_portal` 復帰の手動確認
12. `admin_portal_credential_status` で名簿状態の表示確認
13. 旧 order-portal.html の到達不可（案内しない）を再確認
14. 施主確認済みの取引先に限定して段階的に発行開始
15. 監視: `security_events` / ログイン失敗率の確認

（gateway移行後: 信頼IPでの顧客＋IP二重制限を追加＝M2のTODO）
