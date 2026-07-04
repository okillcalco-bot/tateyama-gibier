# ALCO OS

合同会社アルコの業務全体を支える業務オペレーティングシステム。
館山ジビエセンター・R.O.K.A.・里山保全・自然共生サイト支援・補助金・CRM を、
**同じデータベース・同じ権限・同じAI処理基盤** で扱うためのモノリシックな土台です。

> 中核ルール: **AI出力は必ずドラフト保存 → 人間承認 → 業務反映 → 監査ログ**

## モジュール

Core（認証・権限・監査・AI実行ログ・タスク）/ Voice Memo / Grants /
Nature Capital / CRM / Projects / HR（SOP・チェックリスト）/ Documents / Dashboard
— ジビエ基幹は既存システム（リポジトリルート）が本番稼働中で、段階統合します
（[docs/09-gibier-integration.md](docs/09-gibier-integration.md)）。

## セットアップ

```bash
cd alco-os
pnpm install
cp .env.example .env.local   # Supabase と AI の設定を記入
pnpm dev                     # http://localhost:3000
```

Supabase 未設定でも起動でき、各画面にセットアップ案内が表示されます
（AI は `AI_PROVIDER=mock` でAPIキーなしで動作）。

### Supabase（本番プロジェクトは適用済み）

マイグレーション 0001〜0009 は既存ジビエ基幹と同じ本番プロジェクト
**tateyama-gibier（clpdyrehdgzgiidbfucj）に適用済み**（既存テーブルは無変更）。
`.env.local` / Vercel には以下を設定する:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://clpdyrehdgzgiidbfucj.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNscGR5cmVoZGd6Z2lpZGJmdWNqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyODEzNDksImV4cCI6MjA4ODg1NzM0OX0.cKxpyw0gyZj0Flsd8wzojiNFqyCEcrAF8tFpXXUmZck
```

（anon キーはクライアント配布前提の公開キー。データ保護は RLS が担う）

**ユーザー作成**: Supabase Dashboard → Authentication → Add user で
メール+パスワードのユーザーを作るだけ。初回ログイン時に
`provision_profile()` がプロフィールを自動作成する
（**最初のユーザーが owner** になる。以降のユーザーは staff）。

**別プロジェクトで新規に立てる場合**: `supabase/migrations/` を番号順に適用し、
開発用ダミーデータが欲しければ `supabase/seed.sql` を適用（本番には入れない）。

## コマンド

| コマンド | 内容 |
|---|---|
| `pnpm dev` | 開発サーバー |
| `pnpm build` | 本番ビルド |
| `pnpm typecheck` | 型チェック |
| `pnpm test` | ユニットテスト（Vitest） |
| `pnpm test:e2e` | スモークe2e（Playwright） |

## ドキュメント

| ファイル | 内容 |
|---|---|
| [docs/00-business-context.md](docs/00-business-context.md) | 事業背景 |
| [docs/01-product-vision.md](docs/01-product-vision.md) | プロダクトビジョン・設計思想 |
| [docs/02-architecture.md](docs/02-architecture.md) | アーキテクチャ・レイヤールール |
| [docs/03-domain-model.md](docs/03-domain-model.md) | ドメインモデル・不変条件 |
| [docs/04-database-schema.md](docs/04-database-schema.md) | DBスキーマ・RLS・変更手順 |
| [docs/05-ai-workflows.md](docs/05-ai-workflows.md) | AIワークフローと追加手順 |
| [docs/06-security-and-permissions.md](docs/06-security-and-permissions.md) | セキュリティ・権限 |
| [docs/07-opus-maintenance-guide.md](docs/07-opus-maintenance-guide.md) | **保守モデル（Opus等）向けガイド** |
| [docs/08-roadmap.md](docs/08-roadmap.md) | ロードマップ |
| [docs/09-gibier-integration.md](docs/09-gibier-integration.md) | 既存ジビエ基幹との統合方針 |

AIエージェントで保守する場合は [CLAUDE.md](CLAUDE.md) と docs/07 を必ず読ませてください。
