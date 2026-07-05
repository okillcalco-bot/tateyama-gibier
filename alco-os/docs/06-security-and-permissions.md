# 06. セキュリティと権限

## 前提

顧客情報・個人情報・財務情報・申請書情報を扱うため、
「権限管理」「監査ログ」「AI出力の人間承認」を最優先の設計原則とする。

## 認証・認可

- 認証: Supabase Auth（メール+パスワードから開始。必要に応じMFA/SSO拡張）
- profiles が auth.users と 1:1。organization_id を持つ
- ロール: roles / user_roles（owner / manager / staff）
  - 初回ログイン時に `provision_profile()` がプロフィールを自動作成
    （最初のユーザー = owner、以降 = staff。昇格は user_roles を編集）
  - 承認（generated_drafts の update）は `can_approve()`
    ＝ owner / manager のみ。RLSポリシーとserver actionの両方で強制
  - その他の業務テーブルは「組織メンバーなら CRUD 可」。
    細粒度化が必要になったら `has_role()` でポリシーを追加する

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

- [x] middleware による未ログイン時の /login リダイレクトとセッションリフレッシュ（src/middleware.ts）
- [x] 承認操作の owner / manager 限定（0009: RLS + server action の二重チェック）
- [x] Storage バケットのRLSポリシー定義（0010: 非公開バケット alco-os、
      メンバーのみ読み書き、オブジェクト削除不可＝証跡保全）
- [ ] レート制限（AI実行の暴走防止。ai_runs の集計で監視は可能）
- [ ] 既存ジビエ基幹の allow_all RLS の段階的な厳格化（docs/09）
- [ ] 本番の secretary_pages テーブルは RLS 無効（ジビエ基幹側の課題。
      anon キーで全行読み書き可能な状態。既存アプリの動作確認の上で
      `alter table secretary_pages enable row level security;` + ポリシー追加を検討）
