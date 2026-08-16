# Codexレビュー依頼: 注文サイトのパスワード再発行バグ修正＋仮パスワード方式＋顧客編集UI

対象ブランチ: `claude/tateyama-gibier-portal-password-fix`（`main`未マージ・本番DB未適用・実顧客への発行なし）

## 背景 / 依頼

本番の受発注管理でポータルパスワードの「再発行」を実行すると、確認画面の後に
`42702: column reference "customer_id" is ambiguous` が出て失敗し、注文テストがブロックされていた。
この緊急修正に加え、注文サイトの初回認証を「数字6桁の仮パスワード＋初回変更必須＋顧客単位ロック」へ変更し、
顧客編集画面の視認性を改善した。**本番適用・マージ・実顧客への発行はこのレビュー承認後**に行う。

## 変更点（コミット単位）

1. `fix(order)` 42702修正＋暗号学的6桁化 — `staff_issue_portal_passwords`
2. `feat(order)` 仮パスワード方式＋顧客ロック（DB） — schema列・login/change・unlock・名簿状態RPC
3. `feat(order-admin)` 注文サイト設定カード＋発行完了画面
4. `feat(order)` order.html 初回パスワード変更画面＋仮pwセッションのサーバ側遮断
5. `test(order)` モックE2E＋発行完了モーダルz-index修正

## 追加マイグレーション（すべて本番未適用・適用順）

1. `migrations/20260816_portal_password_reissue_fix.sql`
   - `#variable_conflict use_column`＋ループ列別名で 42702 を解消。`on conflict (customer_id)` の曖昧性を除去。
   - 6桁を `random()` から `gen_random_bytes(4)` 由来へ（先頭0可・6桁固定）。存在しない顧客は全体拒否。
2. `migrations/20260816_portal_temp_password_lifecycle.sql`
   - `customer_secrets` に `must_change/temp_issued_at/temp_expires_at/password_changed_at/last_login_at/failed_attempts/last_failed_at/locked_until` を追加。
   - `staff_issue_portal_passwords`: 発行時に仮pw・`must_change=true`・7日失効を設定。平文はレスポンスで1回のみ。
   - `portal_login_v2`: `status('ok'|'invalid'|'locked')`。`for update of s` で失敗回数を原子的に加算し15分5回で `locked_until`。
     ロック中は正しいpwでも不可。成功で失敗回数リセット。存在しない/停止/無効/pw違い/期限切れ仮pwは全て `invalid`
     （列挙防止・不存在時もダミーcryptでタイミング均一化）。ロック時のみ解除予定時刻を返す。
   - `portal_change_password`: 8〜64文字・仮pwと同一/よくある値/同一文字連続を拒否・session再発行・`must_change`解除。
   - `staff_unlock_portal`（スタッフキー）。`admin_portal_credential_status`（名簿の状態・本pwは表示しない）。
   - IP単位制限は「信頼できるIPが無いため今回は省略・偽の共有IP/固定値で束ねない」。TODOと移行条件をコメントに明記。
3. `migrations/20260816_portal_session_require_password_set.sql`
   - `portal_session_customer` を `must_change=false` のときだけ解決。仮pw変更前のセッションでは
     商品一覧・注文履歴・お気に入り・注文確定などデータRPCを一切利用できない（サーバ側 fail-closed）。

## クライアント

- `order-admin.html`: 「注文サイト設定」独立カード（行全体タップの大トグル=利用中/停止中、ログインIDコピー、
  パスワード状態バッジ＋発行日時/最終ログイン/ロック解除、再発行48px）。発行完了画面（URL=order.html#/ID/6桁/期限/
  まとめ・LINE・印刷・閉じる）。閉じたら6桁を `_pwIssue` とDOMから消去（localStorage非保存）。生JSONは出さず折りたたみ詳細。
- `order.html`: 仮pwログイン→変更画面のみ表示（トークン非永続・login＋仮pwはメモリのみ）。変更成功時のみ新トークン保存し
  商品一覧へ。表示切替・確認一致。戻る/再読込で仮pw再表示なし。

## セキュリティ確認観点（レビューして欲しい点）

- 42702の再発防止（OUT列名とテーブル列の衝突）。他RPCに同種の曖昧参照が無いか。
- 仮pw変更前セッションで各データRPCが確実に拒否されること（`portal_session_customer` 経路の網羅）。
- 列挙防止（存在/停止/無効/pw違いの共通化）とロック時のみ時刻開示のトレードオフの妥当性。
- ロックの原子性（`for update of s`）と他顧客非波及。
- 平文6桁がDB/監査/ログ/レスポンス/スクショに残らないこと。発行完了画面の消去。
- IPベストエフォート方針（信頼IP無しでの省略）とgateway移行TODOの妥当性。

## テスト結果（本番DBで rolled-back 実測・残骸0／モックE2E）

- DB `portal_password_reissue`: 11 PASS
- DB 仮pw lifecycle＋lockout: 17 PASS ／ 名簿状態: 6 PASS ／ セッション遮断: 2 PASS
- E2E `portal-password.e2e.js`（モック・390px/PC）: 23 PASS
- 回帰 E2E `portal-config`/`invoice-import`: 全PASS（JSエラーなし）
- FAIL: 0 ／ SKIP: 本番適用・ライブログイン・実pw発行（承認後の受入試験へ）・IP単位制限（gateway移行後）

## 承認後の適用順（受入試験）

1. 本番データ・既存関数の事前確認 → 2. 3マイグレーション適用 → 3. 専用テスト顧客で42702解消確認 →
4. client を main 反映 → 5. 本番強制再読込 → 6. テスト顧客のみ portal_enabled=true → 7. 6桁発行 →
8. 仮pwログイン → 9. 初回変更 → 10. 商品/価格/在庫確認 → 11. 最小テスト注文 →
12. 単価/希望重量/実引当/内訳確認 → 13. 取消 → 14. 引当在庫が「在庫」へ復帰確認 → 15. 本番PC/390pxスクショ。
いずれか失敗で停止・報告。
