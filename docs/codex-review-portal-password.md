# 注文サイト パスワード再設計（v3）— Codex 再レビュー依頼

前回レビューで指摘された **P0-1 / P0-2 / P0-3 / P0-4 / P1-1〜P1-6** に加え、v2再レビューでの
残ブロッカー **（P0-1 リンク認証の廃止 / P0-2 顧客編集の視認性）** と **適用順（M4を最後）** に対応しました。
本番DBへは未適用、main へは未マージ、実顧客への発行・実注文は未実施です（下記「制約の遵守」）。

## ブランチ / 差分

- 新ブランチ: **`claude/tateyama-gibier-portal-password-fix-v2`**（旧 `claude/tateyama-gibier-portal-password-fix` は保存・改変なし）
- ベース: 最新 `origin/main`（P0-4）。**origin/main に対し 0 behind**（ahead はブランチ先端。最新head SHA は再提出報告本文に記載）。
- 変更ファイル（main 差分＝ポータルパスワード関連のみ。invoice/capture/photo/50音/sw.js/manifest.json には触れていない）:
  - `migrations/20260816_portal_password_reissue_fix.sql`（M1: 発行の42702修正）
  - `migrations/20260816_portal_temp_password_lifecycle.sql`（M2: 仮pw方式・login・complete・ロック・管理RPC）
  - `migrations/20260816_portal_session_require_password_set.sql`（M3: セッションゲート）
  - `migrations/20260816_portal_revoke_legacy_auth.sql`（M4: 旧認証RPC＋リンク認証RPCのEXECUTE剥奪。**最後に適用**）
  - `order.html`（初回変更画面・変更専用トークン・#t=リンク自動ログイン廃止）
  - `order-admin.html`（発行平文の消去・リンク配布廃止・注文サイト設定カード＋発行完了モーダル）
  - `tests/db/portal_temp_password_lifecycle.test.sql`
  - `tests/db/portal_password_reissue.test.sql`
  - `tests/e2e/portal-password.e2e.js`
  - `docs/codex-review-portal-password.md`

## v3 追加対応（v2再レビューの残ブロッカー）

### P0-1（再）: 「かんたんログインリンク」の廃止 — 仮pw方式へ一本化
新方式では発行で `must_change=true`・全セッション失効となり、URLトークンのリンクではログインできない
（`portal_session_customer` が `must_change=true` を拒否）。さらに `must_change=false` の顧客へ長期リンクを残すと
パスワード/ロックをURLトークンで迂回できてしまう。よってリンク発行・配布・自動ログインを全廃した。
- order-admin: `portalIssueCredentials` から `admin_issue_customer_link` 呼出しと `__issuedLink` を削除。
  案内文・CSV・印刷から「かんたんログインリンク」を除去。案内は **URL・ログインID・数字6桁の仮パスワードのみ**。
- order.html: `#t=` トークンの自動ログインを廃止。URLに `#t=` が残ってもセッションに保存せず除去。
- M4: `admin_issue_customer_link(text,uuid[],integer)` を **PUBLIC/anon/authenticated から REVOKE**（service_role/postgres は保持）。
- E2E: 案内文に `#t=` を含めない・`admin_issue_customer_link` を一度も呼ばない・order.html が `#t=` を保存しない
  ・仮pw→初回変更→通常ログインのみ成功、を検証（C3/C4/D1/D2/A1-A9）。

#### 既存リンク（admin-issued-link セッション）の調査結果 — **削除せず判断を仰ぎます**
本番 `portal_sessions` を読み取り（変更なし）:
- `user_agent='admin-issued-link'` の総数 **1件**、うち有効 **1件**（対象顧客 **1件**）。
- 対象は **`C-TEST01`**（テスト用顧客・`portal_enabled=true`）。作成 2026-08-11、失効予定 **2026-12-09**。
- 通常セッション（非リンク）は 1件。
- 影響: このリンクを開くと（M3適用前は）パスワード無しでC-TEST01としてログインできる。M3適用後は
  `must_change` 状態次第。テスト顧客のため実害は小さいが、URLトークン迂回を完全に断つには失効が望ましい。
- **提案**: 承認いただければ `delete from portal_sessions where user_agent='admin-issued-link';`（1件）で失効。
  実顧客が含まれないことは確認済み。勝手には削除していません。

### P0-2（再）: 顧客編集の視認性 — 最新mainへ必要UIのみ小さく再実装
独立した「注文サイト設定」カードを追加（旧ブランチの大規模差分は移植せず）。
- 行全体を押せる大トグル（緑「利用中」／灰「停止中」、min-height 60px）
- ログインID＋コピー、状態バッジ（未発行/仮発行済み/変更済み/期限切れ/ロック中）、
  発行日時・最終ログイン・解除予定（`admin_portal_credential_status` から取得）
- 48px以上の「仮パスワードを発行」、スタッフ用「ロックを解除」（`staff_unlock_portal`）
- 発行完了モーダル: URL／ログインID／数字6桁／有効期限＋まとめてコピー／LINE用コピー／印刷／閉じる。
  **閉じたら6桁をDOM・メモリから消去**（`_pwIssue`/`pwiPw` クリア＋`wipeIssuedSecrets`）。生JSON・alertで6桁を出さない。
- 視認性: 本文16px以上・見出し18px・タップ44px以上・PC最大2列/390px1列・横スクロールなし・「保存」ボタンは最下部固定。
- スクリーンショット（モック認証情報のみ・実データなし）: `admin-card-pc.png` / `admin-issue-modal-pc.png` / `admin-card-390.png` / `order-changepw.png`。

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

### E2E `tests/e2e/portal-password.e2e.js`（31件・全PASS）
- order.html A1-A10: 仮pw→変更画面、変更前PII非表示、変更トークン非永続、8文字/不一致の弾き、
  変更成功で一覧遷移＋PII取得、本トークン保存・平文残存なし、JSエラーなし。
- B1-B2: 失敗は汎用メッセージ・具体的理由を含めない。
- D1-D2: `#t=` トークンで自動ログインしない・セッションに保存しない（リンク認証廃止）。
- order-admin C1-C5: CSV発行/コピー後に名簿・storage から平文消去、案内文に `#t=` を含めない、
  `admin_issue_customer_link` を一度も呼ばない。
- order-admin E1-E12（P0-2視認性）: 注文サイト設定カード表示、状態バッジ、大トグルの利用中/停止中切替、
  タップ44px以上、PC/390px 横スクロールなし、発行完了モーダル（6桁・ID・URL・有効期限・生JSON無し）、
  閉じたら6桁をDOM・メモリ・storageから消去。スクショはモック認証情報のみ。

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
| admin_issue_customer_link(text,uuid[],int) | 実行可 | **不可**（リンク認証廃止＝PUBLIC/anon/authからREVOKE） |
| portal_me / portal_catalog / portal_my_orders / portal_place_order / portal_last_order / portal_rebuild_cart / portal_stock_marks / portal_toggle_favorite / portal_usual_items | 実行可 | 実行可（維持。トークン制・M3で must_change=false 必須） |
| portal_session_customer / portal_session_touch | 内部のみ（不可） | 内部のみ（維持） |

M4適用後の実測はレビュー承認後の適用時に取得（begin/rollbackでの事前確認では 200-206 全PASS）。

## 制約の遵守（レビュー承認まで）
- **本番DBへ未適用**（すべて begin/rollback で検証、commit していない）。
- **main へ未マージ**（作業は v2 ブランチのみ）。
- **実顧客への発行・実注文なし**（テストは固定モック値・ダミー顧客のみ）。
- capture/photo/50音/invoice-phase4 のファイル、`sw.js`/`manifest.json` は未変更。

## 承認後の適用手順（M4は最後＝クライアント配信後）
**重要**: 旧RPCのREVOKE（M4）は、旧RPCを使うクライアントが残っている間に先行させるとログイン不能になる。
必ず **クライアント配信後・新方式の動作確認後に M4** を適用する。

1. 本番事前確認（`list_migrations` / 対象テーブル・ACLの現状取得）
2. **M1** `20260816_portal_password_reissue_fix.sql`
3. **M2** `20260816_portal_temp_password_lifecycle.sql`（lifecycle・新RPC）
4. **M3** `20260816_portal_session_require_password_set.sql`（セッションゲート）
5. DBスモーク: `tests/db/portal_temp_password_lifecycle.test.sql` と `..._reissue.test.sql` を本番で begin/rollback → 全PASS
6. `order.html` / `order-admin.html` をデプロイ（Vercel）
7. 新方式の確認: ダミー顧客1件で **仮pw→初回変更→通常ログイン** の成功、ロック（5回失敗）→`staff_unlock_portal`復帰、
   `admin_portal_credential_status` の名簿状態表示
8. **M4** `20260816_portal_revoke_legacy_auth.sql`（旧認証RPC＋`admin_issue_customer_link` のREVOKE）
9. 適用後ACL実測（`portal_login`/`portal_change_password`/`admin_issue_customer_link` が anon/auth 不可、
   `portal_login_v2`/`portal_complete_temp_password` が anon 可）
10. テスト注文→管理画面で確認→取消→在庫復帰の一連を確認
11. PC／390px の本番スクリーンショット取得。旧 order-portal.html の非案内を再確認
12. 既存 `admin-issued-link` セッション（1件・C-TEST01）の失効可否を判断し、承認のうえ削除
13. 施主確認済みの取引先に限定して段階的に発行開始
14. 監視: `security_events` / ログイン失敗率の確認

（gateway移行後: 信頼IPでの顧客＋IP二重制限を追加＝M2のTODO）
