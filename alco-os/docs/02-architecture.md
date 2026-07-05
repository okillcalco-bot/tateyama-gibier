# 02. アーキテクチャ

## 技術スタック

| 層 | 技術 |
|---|---|
| Frontend | Next.js App Router / TypeScript / Tailwind CSS v4 |
| UI部品 | 自作の最小コンポーネント（`src/components/ui`）。本格化したら shadcn/ui を導入して置換 |
| Backend / DB | Supabase (PostgreSQL, Auth, Storage, RLS) |
| AI | Anthropic Claude API（adapter層で抽象化。将来他社へ切替可能） |
| Validation | Zod |
| Test | Vitest（unit）/ Playwright（e2e） |
| Hosting | Vercel |
| Package manager | pnpm |

## ディレクトリ構成

```
alco-os/
├─ docs/                 設計・保守ドキュメント（本ファイル群）
├─ supabase/
│  ├─ migrations/        DBマイグレーション（追加のみ。既存変更禁止）
│  └─ seed.sql           開発用ダミーデータ
├─ src/
│  ├─ app/               ルーティングとUI組み立てのみ（ビジネスロジック禁止）
│  │  ├─ page.tsx        ダッシュボード
│  │  ├─ memos/          Voice Memo（フォーム + server actions）
│  │  ├─ drafts/         承認センター（全AI生成物のレビュー）
│  │  ├─ tasks/ grants/ nature/ crm/ projects/ gibier/ login/
│  ├─ components/        再利用UI（app-shell, ui/）
│  ├─ domain/            ビジネスルール（承認・監査・タスク・証跡）
│  │  ├─ drafts/draft-service.ts     ★中核: AI出力→業務反映の唯一の経路
│  │  ├─ audit/audit-log-service.ts
│  │  ├─ tasks/task-service.ts
│  │  └─ nature/evidence-service.ts
│  ├─ ai/                AIアダプタ層（プロバイダ直呼び禁止領域の境界）
│  │  ├─ model-router.ts      ワークフロー→(プロバイダ,モデル)解決の一元管理
│  │  ├─ types.ts             AiProvider インターフェース
│  │  ├─ providers/           anthropic-provider / mock-provider
│  │  ├─ workflows/           run-workflow（共通ランナー）+ 各ワークフロー
│  │  ├─ prompts/             プロンプト（PROMPT_VERSION 付き）
│  │  └─ schemas/             入出力の Zod スキーマ
│  └─ lib/
│     ├─ env.ts               環境変数の一元管理（他所で process.env 禁止）
│     ├─ auth.ts              ログインユーザー+組織の取得
│     ├─ db/port.ts           DbPort（ドメイン層のDB抽象）
│     ├─ db/supabase-db.ts    DbPort の Supabase 実装
│     └─ supabase/            server / browser クライアント
├─ tests/                unit テスト（InMemoryDb でドメイン層を検証）
└─ e2e/                  Playwright スモークテスト
```

## レイヤールール（違反禁止）

1. `app/` は表示とserver actionの入口のみ。ビジネスロジックは `domain/` へ。
2. AI呼び出しは `ai/model-router.ts` → `ai/workflows/` 経由のみ。
   React コンポーネントや route handler からプロバイダSDKを直接呼ばない。
3. `domain/` は Supabase SDK に依存しない。`DbPort`（lib/db/port.ts）に依存する。
   これにより InMemoryDb でのユニットテストが可能になっている。
4. AI出力が業務テーブルに入る唯一の経路は `draft-service.approveDraft()`。
5. モデル名・APIキーは `lib/env.ts` + `ai/model-router.ts` 以外に書かない。

## データフロー（Voice Memo の例）

```
memo-form.tsx (client)
  → app/memos/actions.ts "use server"
    → voice_memos に原文 insert（原文は以後不変）
    → ai/workflows/classify-voice-memo.ts
        → model-router がモデル解決
        → provider.complete()
        → Zod parse（失敗は ai_runs に failed 記録）
        → ai_runs insert（成功）
        → generated_drafts insert（status: draft）★ここで停止
  → /drafts で人間がレビュー
    → approveDraftAction
      → domain/drafts/draft-service.approveDraft()
        → tasks insert（audit_logs 付き）
        → voice_memos.status = processed
        → generated_drafts.status = approved
        → audit_logs（approve）
```

## フレームワーク追加のルール

新しいフレームワーク・大型ライブラリを導入する場合は、
このファイルを先に更新し、理由をADRとして docs/ に残すこと。
