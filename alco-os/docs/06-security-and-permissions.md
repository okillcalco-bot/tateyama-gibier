# 06. セキュリティと権限

## 前提

顧客情報・個人情報・財務情報・申請書情報を扱うため、
「権限管理」「監査ログ」「AI出力の人間承認」を最優先の設計原則とする。

## 認証・認可

- 認証: Supabase Auth（メール+パスワードから開始。必要に応じMFA/SSO拡張）
- profiles が auth.users と 1:1。organization_id を持つ
- ロール: roles / user_roles（owner / manager / staff）
  - 現段階のRLSは「組織メンバーなら CRUD 可」の粗い粒度
  - ロール別の細粒度制御（例: 承認は manager 以上）は `has_role()` を
    使ってポリシー追加する（ロードマップ Phase 2）

## RLS 方針

| テーブル群 | ポリシー |
|---|---|
| organizations | 自組織のみ select |
| profiles | 自組織 select / 本人のみ update |
| 業務テーブル全般 | `alco_add_member_policy`: 自組織のみ CRUD |
| ai_runs / audit_logs | insert + select のみ。**update/delete 不可（改変防止）** |
| ビュー | security_invoker = true |

## 鍵の管理

- `SUPABASE_SERVICE_ROLE_KEY` はサーバー専用。クライアントに渡さない。
  現MVPでは未使用（すべてRLS内で完結）。使う場合は必ず理由をADRに残す。
- `ANTHROPIC_API_KEY` はサーバー専用。`lib/env.ts` 以外から参照しない。
- 環境変数は Vercel の環境変数管理に置く。リポジトリにコミットしない。

## AI セーフティ

1. AI出力は generated_drafts 止まり。人間承認なしに業務データへ反映されない
2. すべてのAI実行が ai_runs に記録される（失敗含む）
3. レポートの証跡引用は evidence-service で実在チェック
4. 補助金文書は「AI生成→人間レビュー→提出」を運用ルールとして明文化
   （UI上にも注意書きを常時表示）

## 既知のギャップ（次に塞ぐもの）

- [ ] middleware による未ログイン時の /login リダイレクトとセッションリフレッシュ
- [ ] 承認操作の manager 以上限定（has_role ベースのRLS + UI制御)
- [ ] Storage バケットのRLSポリシー定義（files テーブルと対で）
- [ ] レート制限（AI実行の暴走防止。ai_runs の集計で監視は可能）
- [ ] 既存ジビエ基幹の allow_all RLS の段階的な厳格化（docs/09）
