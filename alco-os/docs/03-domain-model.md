# 03. ドメインモデル

## 共通概念

- **Organization**: 合同会社アルコ。全業務データは organization_id を持ち、RLSで分離される。
- **Profile**: ログインユーザー（auth.users と 1:1）。Role（owner / manager / staff）を持つ。
- **Task**: 全モジュール横断のタスク。`module` と `related_table/related_id` で発生元と紐付く。
- **File**: Supabase Storage 上のファイルの台帳。撮影日時・GPS を持ち証跡になる。
- **GeneratedDraft**: AI生成物。必ず draft → (approved | discarded) のライフサイクルを辿る。
- **AiRun**: すべてのAI実行の記録（成功・失敗とも）。
- **AuditLog**: 重要な業務変更の記録（before/after 付き）。

## ドラフトのライフサイクル（中核）

```
draft ──承認(approveDraft)──→ approved（業務テーブルへ反映済み）
  └──破棄(discardDraft)──→ discarded
```

- draft 以外の状態からの遷移は禁止（二重承認・破棄後承認はエラー）
- 反映処理は draft_type ごとに draft-service の applyDraft() に定義する
  - `voice_memo_result` → tasks 作成 + voice_memos.status 更新
  - `grant_application` → grant_documents 作成
  - `nature_report` → 承認のみ（提出用文書化は将来拡張）

## モジュール別モデル

### Voice Memo
- **VoiceMemo**: 原文（raw_text）は不変。AI分類結果はドラフト側に持つ。
  detected_category は承認時に確定コピーされる。

### Grants
- **GrantOpportunity**（公募）→ **GrantProject**（申請案件）→
  **GrantRequirement**（要件チェックリスト。原文は改変禁止）
  / **GrantBudgetItem**（経費）/ **GrantDocument**（確定文書。source_draft_id で由来を保持）

### Nature Capital
- **Site**（対象地）→ **SurveyPoint** / **FieldSurvey** →
  **BiodiversityObservation**（証跡の最小単位。写真file・GPS・観察者を持つ）
  / **ManagementAction**（管理作業履歴）
- レポートの証跡引用は evidence-service.checkReportEvidence() で
  「実在するIDのみ」を検証する（AIの引用捏造をシステムで遮断）

### CRM
- **Contact**（人/会社/行政。referred_by で紹介ツリー）→
  **Interaction**（面談・1to1。next_action 付き）/ **Deal**（案件パイプライン）
  / **Referral**（紹介実績）

### Projects
- **Project** → **ProjectPhase** / **ProjectIssue**（課題・リスク）
  / **ProjectDecision**（意思決定ログ。削除禁止）/ **Vendor** / **VendorQuote**

### HR / Documents
- **Sop**（作業標準書）/ **Checklist**（定義）/ **ChecklistRun**（実施記録）
- **KnowledgeDoc**（社内Wiki。テーブル名は knowledge_docs — 既存ジビエ基幹の
  documents と衝突するため。is_ai_reference=true はAIワークフローの参照資料）
- シフト・勤怠は既存ジビエ基幹の staff / attendance が正（重複させない）

### Gibier（既存システム側が正）
- individuals（個体）/ hunters / products / product_movements / orders / customers
- ALCO OS 側には作らない。統合は docs/09 参照。

## 不変条件（インバリアント）

1. AI出力は必ず GeneratedDraft を経由する。直接業務テーブルに書かない。
2. 原文・原データ（メモ原文、公募要領原文、観察記録）は上書きしない。
3. 重要変更には AuditLog が残る。AuditLog と AiRun は削除・改変しない。
4. レポート・申請書は「入力に存在する事実・証跡」のみ引用する。
5. 業務テーブルは organization_id を持ち、RLS で保護される。
