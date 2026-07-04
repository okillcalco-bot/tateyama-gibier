# 07. Opus 保守ガイド

このリポジトリの骨格は Fable（上位モデル）で設計・実装された。
日常の機能追加・修正は Opus 等で行う。**このガイドとCLAUDE.md を読んでから作業すること。**

## 作業前に必ず読む

1. `CLAUDE.md`（ルール全体）
2. `docs/02-architecture.md`（レイヤールール）
3. `docs/03-domain-model.md`（不変条件）
4. `docs/04-database-schema.md`（DB変更手順）
5. 該当モジュールのコード（app/ → domain/ → ai/ の順）

## やってよいこと（Opusの担当領域）

- 画面の追加・修正（一覧・詳細・フォーム・帳票・ラベル）
- 出力テンプレート・プロンプト文言の調整（PROMPT_VERSION を上げる）
- 新しいワークフロー追加（docs/05 の手順に従う）
- KPI・グラフ・フィルタの追加
- 新モジュールのテーブル追加（新しい連番マイグレーション + alco_add_member_policy）
- テスト追加・文言修正・ドキュメント更新

## やってはいけないこと

- アーキテクチャの変更（レイヤー構造・DbPort・adapter層の廃止や迂回）
- domain service を迂回して画面から直接業務テーブルを更新する
- React コンポーネント・route handler からAIプロバイダを直接呼ぶ
- generated_drafts を経由しないAI出力の業務反映
- audit_logs / ai_runs の記録を削る
- 既存マイグレーションファイルの編集（新ファイル追加のみ）
- 既存ジビエ基幹（リポジトリルートのHTML群・既存テーブル）の破壊的変更
- モデル名のハードコード

## 作業の型

1. 変更は小さく。1タスク=1関心事
2. 実装後に必ず実行:
   ```bash
   pnpm typecheck && pnpm test
   ```
   UI変更時は `pnpm dev` で該当画面を目視確認（可能なら e2e 追加）
3. 挙動が変わったら docs/ を更新
4. 出力すべき報告: 変更概要 / 変更ファイル / 追加・更新テスト /
   追加マイグレーション / リスクとフォローアップ

## 典型タスクのレシピ

### 画面に項目を足す
app/<module>/page.tsx の select 句とJSXを変更するだけ。DB変更が要るなら新マイグレーション。

### ドラフトの反映先を増やす
domain/drafts/draft-service.ts の applyDraft() に case 追加 + テスト追加。

### プロンプト調整
ai/prompts/<name>.prompt.ts のみ変更。PROMPT_VERSION を上げ、
mock-provider の応答がスキーマに合っているか確認。

### 新しい補助金テンプレ
プロンプトではなく documents（doc_type: template）に入れて
ワークフロー入力に渡す設計を優先する（プロンプト肥大化を防ぐ）。
