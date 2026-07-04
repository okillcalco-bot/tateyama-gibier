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

### Supabase の準備

1. 既存ジビエ基幹と同じ Supabase プロジェクトを使う（推奨）
2. `supabase/migrations/` を番号順に適用（SQL Editor または `supabase db push`）
3. `supabase/seed.sql` を適用（開発用ダミーデータ）
4. Auth でユーザーを作成し、`profiles` に organization_id 付きで登録

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
