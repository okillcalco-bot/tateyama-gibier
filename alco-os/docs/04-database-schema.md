# 04. データベーススキーマ

マイグレーションは `supabase/migrations/` に番号順で置く。
**追加のみ**（既存テーブル・カラム・データの破壊的変更は禁止）。
既存ジビエ基幹のテーブルには触れない。

## マイグレーション一覧

| ファイル | 内容 |
|---|---|
| 0001_core.sql | organizations, profiles, roles, user_roles, tasks, files, ai_runs, audit_logs, generated_drafts + RLSヘルパー |
| 0002_voice_memo.sql | voice_memos |
| 0003_grants.sql | grant_opportunities, grant_projects, grant_requirements, grant_documents, grant_budget_items |
| 0004_nature.sql | sites, survey_points, field_surveys, biodiversity_observations, management_actions |
| 0005_crm.sql | contacts, interactions, deals, referrals |
| 0006_projects.sql | projects, project_phases, project_issues, project_decisions, vendors, vendor_quotes |
| 0007_hr_documents.sql | sops, checklists, checklist_runs, knowledge_docs（既存の documents と衝突するため改名） |
| 0008_dashboard_views.sql | v_open_tasks, v_pending_drafts, v_grant_pipeline, v_deal_pipeline, v_site_activity, v_ai_usage |
| 0009_provisioning_and_approval.sql | デフォルト組織・ロール投入、provision_profile()（初回ログイン自動作成）、can_approve()、generated_drafts の update を owner/manager に限定 |
| 0010_storage.sql | Storage 非公開バケット alco-os + RLS（メンバーのみ読み書き。delete 不可） |
| 0011_gibier_views.sql | ジビエ基幹KPIビュー（v_gibier_intake_monthly / v_gibier_inventory / v_gibier_sales_monthly / v_gibier_movements_monthly。既存テーブルへの読み取り専用） |

**適用状況**: 0001〜0011 は本番 Supabase プロジェクト（tateyama-gibier /
clpdyrehdgzgiidbfucj。既存ジビエ基幹と共有）に適用済み（2026-07-05）。
seed.sql（ダミーデータ）は本番には投入していない。

## テーブル設計の標準

すべての業務テーブルは以下を持つ:

```sql
id               uuid primary key default gen_random_uuid()
organization_id  uuid not null references organizations(id)
created_at       timestamptz not null default now()
updated_at       timestamptz not null default now()   -- set_updated_at トリガー
created_by       uuid references profiles(id)          -- 必要に応じ updated_by も
deleted_at       timestamptz                            -- ソフトデリート（対象テーブルのみ）
```

## RLS の標準パターン

- `current_organization_id()`: ログインユーザーの組織IDを返す（security definer）
- `has_role(key)`: ロール判定
- `alco_add_member_policy('table')`: 「自組織の行のみ CRUD 可」の標準ポリシーを付与。
  **新テーブル追加時はこの関数を呼ぶだけでよい。**
- ai_runs / audit_logs は insert + select のみ（update/delete ポリシーなし = 改変不可）
- ビューは `security_invoker = true` で RLS を通す

## 汎用参照（related_table / related_id）

tasks, files, knowledge_docs は特定モジュールに依存しないよう
`related_table` + `related_id` の汎用参照を使う（FKなし）。
モジュール固有の強い整合性が必要な場合のみ専用FKカラムを足す。

## 変更手順

1. 新しい連番SQLファイルを作る（既存ファイルは編集しない）
2. `alco_add_member_policy` + `set_updated_at` トリガーを忘れない
3. 本ドキュメントの一覧表を更新する
4. Supabase に適用（`supabase db push` または MCP の apply_migration）
