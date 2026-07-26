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

## 捕獲者の個人情報（B案 / 2026-07-26 確定）

| 情報 | 保存先 | 収集経路 | 表示 |
|---|---|---|---|
| 氏名 | 既存 `hunters` | LINE（本人申告）+ 職員確認 | そのまま |
| 生年月日・郵便番号・住所・電話・活動エリア・従事者証 | `hunter_profiles`（0026） | 職員の聞き取り / CSV一括取込 | そのまま（認証済みメンバーのみ） |
| **口座** | **既存 `hunters` の口座欄**（新テーブルを作らない） | **職員が電話・対面で聞き取り**。LINEでは受け取らない | **一覧は下4桁のみ。フル表示は owner/manager + 監査ログ** |

- LINEの初回案内に「登録済みの方はお名前だけでOK」「口座は安全のためLINEで送らないでください」を必ず入れる
- CSV取込は口座列を持たない。台帳に無い名前・同姓同名は取り込まず飛ばす（`hunters` を新規作成しない）
- 口座番号は監査ログにも残さない（下4桁のみ記録）

### hunters の RLS（2026-07-26 第1段階を実施）

既存の `allow_all`（全操作 `using(true)`）は anon キーから口座まで読み書き・**物理削除**できる状態だった。
調査の結果、既存アプリが使っているのは select / insert / update のみで DELETE は無かったため、
`/migrations/20260726_hunters_rls_hardening.sql` で **delete ポリシーだけを廃止**した（現場に影響なし）。

**第2段階（未実施）**: 口座列を anon から隠すには列単位の `revoke` が必要だが、
PostgREST の `?select=*` が 42501 で失敗するため、先に `index.html` の2箇所の `?select=*` を
明示列リストへ変更し、本番で表示確認してから適用すること。手順はマイグレーションのコメントに記載。

## 既知のギャップ（次に塞ぐもの）

- [x] middleware による未ログイン時の /login リダイレクトとセッションリフレッシュ（src/middleware.ts）
- [x] 承認操作の owner / manager 限定（0009: RLS + server action の二重チェック）
- [x] Storage バケットのRLSポリシー定義（0010: 非公開バケット alco-os、
      メンバーのみ読み書き、オブジェクト削除不可＝証跡保全）
- [ ] レート制限（AI実行の暴走防止。ai_runs の集計で監視は可能）
- [x] hunters の物理削除を禁止（2026-07-26 第1段階）
- [ ] hunters の口座列を anon から隠す（第2段階。index.html の `select=*` 修正とセット）
- [ ] 既存ジビエ基幹の allow_all RLS の段階的な厳格化（docs/09）
- [ ] 本番の secretary_pages テーブルは RLS 無効（ジビエ基幹側の課題。
      anon キーで全行読み書き可能な状態。既存アプリの動作確認の上で
      `alter table secretary_pages enable row level security;` + ポリシー追加を検討）
