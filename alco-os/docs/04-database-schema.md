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
| 0012_media.sql | media_projects（プレゼン資料 / YouTube動画の企画〜成果物。承認済み構成は approved_content に保存。素材は files を related_table='media_projects' で紐付け） |
| 0013_workforce.sql | shift_patterns / shift_requests（HRMOS型シフト管理。予定は既存 shifts、実績は既存 attendance を使う — docs/09 Step 2.5） |
| 0014_billing.sql | billing_documents（請求書/納品書/領収書の台帳。月毎・種類毎に自動採番、発行時の明細・金額・発行者をスナップショット。発行者情報は既存 org_settings のキーを共用） |
| 0015_boards_social.sql | board_posts（スタッフ/飲食店の共有ボード。辞書ベース自動タグ・宛先絞り込み・在庫スナップショット添付）、customer_levels（飲食店の信頼度 new/repeat/vip）、social_projects（投稿一括更新: 一次データ→チャンネル別原稿→承認→投稿管理） |
| 0016_ledger_advisor.sql | sales_slips（売上伝票。手売り/解体体験等の月毎自動採番 SL-YYYYMM-###、取消=欠番）、advisor_consultations（士業相談の一次整理。AI出力は法的助言ではない） |
| 0017_billing_center.sql | billing_documents 拡張（追加のみ）: source_document_id（見積→納品→請求→領収の変換系譜）、source（alco / misoca）。見積書 doc_type='quote'（QT採番）追加 |
| 0018_gibier_link.sql | sales_slips.product_id（既存 products への汎用参照）。帳票・伝票の品目ピッカーは products / price_master を読み取り専用参照（在庫増減は既存システムが正） |
| 0019_satoyama_os.sql | 里山OS: taxa（希少度）/ evidence / ecological_interactions（※既存CRM interactions と衝突のため改名）/ survey_campaigns / survey_tasks + biodiversity_observations 拡張（source_type・evidence_type・confidence_*・review_*・visibility_level・ai_suggestion・sensitivity）+ mask_coordinate() + v_public_observations |

| 0020_quests_support.sql | 調査クエスト & 応援: survey_tasks 拡張（目標件数・進捗・資金・公開スラッグ）、supporters / support_pledges（入金確認で資金計上）/ quest_payouts（調査謝金）/ achievement_grants + 公開ビュー v_public_quests（restricted は含めない） |

| 0021_hunter_line.sql | 捕獲者LINE連携: hunter_line_links（既存 hunters への汎用参照。チャネル内で line_user_id 一意。pending/verified/blocked）、line_webhook_events（webhookEventId の unique による冪等性台帳）、line_inbound_messages（職員が確認・返信する受信メッセージ。位置は has_location フラグのみで原座標を保存しない） |

| 0022_capture_reports.sql | 捕獲報告（LINE経由）: capture_reports（獣種・捕獲方法・原座標・写真file・本文・ai_suggestion・status[pending/accepted/rejected]・individual_id）、line_conversation_states（会話状態。捕獲報告の続きとして写真・本文を受け取る）。org_settings は既存キーバリューに gibier_accepting / gibier_acceptance_note を足すのみ（スキーマ変更なし） |

| 0023_line_channel_ref.sql | LINEチャネル識別子を安定ラベル（channel:hunter 等）に統一。line_channel_registry（受信した destination を自動記録。ルーティングには使わない）+ 既存行の読み替え + 列コメント。**LINE_HUNTER_CHANNEL_ID は不要になった** |

| 0024_line_chat_and_report_photos.sql | 職員チャット返信 line_outbound_messages（本文・送信者・送信時刻・成否）、捕獲報告の写真種別 capture_report_photos（未仕分け/全体/尻尾を切る前/切った後/その他） |

| 0025_capture_weight_and_form_fields.sql | 体重（weight_kg + weight_measure: center/facility/estimated）、捕獲票の職員入力項目（性別・幼獣・体長・箱わな番号・餌・設置日・止め刺し方法・処理方法）、会話状態に体重の聞き取りを追加 |
| 0026_hunter_profiles.sql | 捕獲者の追加情報 hunter_profiles（生年月日・郵便番号・住所・電話・活動エリア・従事者証）。**口座は入れない**（既存 hunters の欄を使う） |

| 0027_capture_form_share.sql | 捕獲票のセルフDL: capture_reports に share_token / share_expires_at / capture_place、`get_capture_form_by_token()`（SECURITY DEFINER・期限内1件・捕獲票に必要な列だけ）、会話状態に awaiting_capture_form |

| 0028_staff_notify_groups.sql | 搬入連絡のスタッフグループ通知: line_staff_groups（グループID・通知ON/OFF・状態 pending/active/disabled/left・通知回数） |

| 0029_crosspost.sql | FB投稿 横展開（Phase 1）: social_sources / social_source_assets / social_channels / social_style_profiles / social_channel_drafts / social_publications。**制限が要るテーブルは alco_add_member_policy を使わず用途別ポリシー**（RLSはOR条件のため）、承認をまとめて行う `alco_crosspost_approve()`（**唯一の本番承認経路**。generated_draftsへの承認証跡・業務反映・監査ログを同一トランザクションで記録）、投稿済み登録をまとめて行う `alco_crosspost_record_publication()`（同じく唯一の本番経路）、承認INSERTの抜け道を塞ぐトリガー、承認列と確認理由の改ざん防止（approval_draft_id の付け替え禁止・review_reasons は追記のみ）、**承認済みからの引き戻し（approved→editing / published→draft）も owner/manager 限定**、**approved / published への遷移と approved_body・approval_draft_id の設定は所定のRPCの中だけ**（トランザクションローカルの `app.crosspost_*_rpc` で判定。直接UPDATEでの承認は owner/manager でも不可）、差し戻し・却下では承認関連列をすべてNULLへ、識別列（organization_id / social_source_id / channel_key / created_by）はINSERT後 変更不可、下書きの組織・元投稿・媒体の一致検証、媒体8件とスタイルv1のseed |

| 0030_expenses.sql | 経費（レシート）: expenses（**日付・金額・取引先を列として持ち検索できる** = 電子帳簿保存法スキャナ保存の検索要件。物理削除しない = deleted_at のみ。ai_suggestion にAIの読み取り候補を確定値と分けて保持、receipt_file_id で写真を参照、corrected でAIの精度を追跡） |

**適用状況**: 0001〜0020 は本番 Supabase プロジェクト（tateyama-gibier /
clpdyrehdgzgiidbfucj。既存ジビエ基幹と共有）に適用済み（0001〜0011: 2026-07-05、
0012〜0020: 2026-07-06〜15）。
**0021〜0026 は本番適用済み**（0021〜0023: PR #52 / 0024〜0026: PR #53）。ジビエ基幹側の `20260726_hunters_rls_hardening.sql` も適用済み。
0027 も本番適用済み（適用名 `alco_os_0027_capture_form_share`）。
**0029 は未適用**（FB投稿 横展開 Phase 1）。
**0028 は未適用**（搬入連絡のスタッフグループ通知）。
**0030 は未適用**（経費・レシート）。
なお 0027 は当初、関数定義が `capture_place` の列追加より前にあり素のPostgresでは
適用に失敗する順序だった。**本番へは順序を直したSQLで適用済み**で、
リポジトリのファイルも同じ順序に修正した（内容は同一。適用済みDBへの影響なし）。
あわせてジビエ基幹側に `/migrations/20260726_hunters_rls_hardening.sql`（hunters の delete ポリシー廃止）を追加している。
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

## RLSポリシーの注意（重要）

PostgreSQL の通常ポリシーは **OR 条件**で評価される。
`alco_add_member_policy()` は「組織メンバーに全CRUD」を許可する `FOR ALL` ポリシーを作るため、
**あとから owner/manager 限定のポリシーを足しても制限にならない**。

権限を絞りたいテーブルでは `alco_add_member_policy()` を**使わず**、
`SELECT` / `INSERT` / `UPDATE` を用途ごとに明示すること（0029 が実例）。
また、UPDATE トリガーだけでは **INSERT で最初から承認済みにする抜け道**が残るため、
BEFORE INSERT トリガーとポリシーの `with check` で二重に塞ぐ。

## 1ファイル内のSQLの並び順（重要）

**「参照より定義が先」** の順に書く。

1. `create table` / `alter table ... add column`
2. `create index` / 制約
3. `create or replace function` / `create view`
4. `select alco_add_member_policy(...)` / トリガー / `comment on`

PostgreSQLは**SQL関数の本体を作成時に検証する**ため、関数が参照する列を
そのファイルの後ろで追加すると `column ... does not exist` で適用に失敗する。

> 実例: 0027 は当初 `get_capture_form_by_token()` を `capture_place` の追加より
> 前に書いてしまい、素のPostgresへの適用に失敗した（本番へは順序を直したSQLで適用）。
> `tests/migrations/sql-order.test.ts` がこの並び順を機械的に確認する。

## 変更手順

1. 新しい連番SQLファイルを作る（既存ファイルは編集しない）
2. 上の並び順を守る（`pnpm test` の並び順チェックが落ちたら順序を見直す）
3. `alco_add_member_policy` + `set_updated_at` トリガーを忘れない
4. 本ドキュメントの一覧表を更新する
5. Supabase に適用（`supabase db push` または MCP の apply_migration）
