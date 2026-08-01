import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";
import { createTask } from "@/domain/tasks/task-service";
import { voiceMemoOutputSchema } from "@/ai/schemas/voice-memo.schema";
import { grantDraftOutputSchema } from "@/ai/schemas/grant.schema";
import {
  hunterMessageOutputSchema,
  HUNTER_INTENT_LABELS,
} from "@/ai/schemas/hunter-message.schema";

/**
 * ドラフト承認サービス — ALCO OS の中核ルールを実装する。
 *
 *   AI出力 → generated_drafts（draft）→ 人間承認 → 業務テーブル反映 → 監査ログ
 *
 * AI出力が業務テーブル（tasks / grant_documents / ...）に入る経路は
 * approveDraft() のみ。これ以外の経路を作ってはならない。
 */

export async function approveDraft(
  db: DbPort,
  ctx: AuditContext,
  draftId: string,
): Promise<{ draft: Row; createdRecords: Row[] }> {
  const draft = await db.findById("generated_drafts", draftId);
  if (!draft) throw new Error(`ドラフトが見つかりません: ${draftId}`);
  if (draft.status !== "draft") {
    throw new Error(`このドラフトは承認できません（status: ${draft.status}）`);
  }

  // 1. ドラフトの種類ごとに業務テーブルへ反映
  const createdRecords = await applyDraft(db, ctx, draft);

  // 2. ドラフトを承認済みにする
  const now = new Date().toISOString();
  const approved = await db.update("generated_drafts", draftId, {
    status: "approved",
    reviewed_by: ctx.actorId,
    reviewed_at: now,
    applied_at: now,
  });

  // 3. 監査ログ
  await writeAuditLog(db, ctx, {
    action: "approve",
    tableName: "generated_drafts",
    recordId: draftId,
    before: draft,
    after: approved,
    note: `反映レコード数: ${createdRecords.length}`,
  });

  return { draft: approved, createdRecords };
}

export async function discardDraft(db: DbPort, ctx: AuditContext, draftId: string): Promise<Row> {
  const draft = await db.findById("generated_drafts", draftId);
  if (!draft) throw new Error(`ドラフトが見つかりません: ${draftId}`);
  if (draft.status !== "draft") {
    throw new Error(`このドラフトは破棄できません（status: ${draft.status}）`);
  }

  const discarded = await db.update("generated_drafts", draftId, {
    status: "discarded",
    reviewed_by: ctx.actorId,
    reviewed_at: new Date().toISOString(),
  });

  await writeAuditLog(db, ctx, {
    action: "discard",
    tableName: "generated_drafts",
    recordId: draftId,
    before: draft,
    after: discarded,
  });

  return discarded;
}

/** draft_type ごとの反映処理。新しいドラフト種別を足すときはここに追加する。 */
async function applyDraft(db: DbPort, ctx: AuditContext, draft: Row): Promise<Row[]> {
  switch (draft.draft_type) {
    case "voice_memo_result":
      return applyVoiceMemoResult(db, ctx, draft);
    case "grant_application":
      return applyGrantApplication(db, ctx, draft);
    case "presentation_outline":
    case "video_plan":
      return applyMediaPlan(db, ctx, draft);
    case "social_posts":
      return applySocialPosts(db, ctx, draft);
    case "advisor_brief":
      return applyAdvisorBrief(db, ctx, draft);
    case "hunter_message_result":
      return applyHunterMessageResult(db, ctx, draft);
    case "crosspost_approval":
      return applyCrosspostApproval(db, ctx, draft);
    case "nature_report":
      // レポートはドラフト承認のみで完結（提出用の確定文書化は将来 grant_documents 同様の仕組みで）
      return [];
    default:
      // 反映処理が未定義のドラフトは承認のみ（レコード生成なし）
      return [];
  }
}

/** 音声メモ分類結果 → 提案タスクを tasks に作成 + メモを processed に */
async function applyVoiceMemoResult(db: DbPort, ctx: AuditContext, draft: Row): Promise<Row[]> {
  const content = voiceMemoOutputSchema.parse(draft.content);
  const created: Row[] = [];

  for (const suggested of content.suggested_tasks) {
    const task = await createTask(db, ctx, {
      title: suggested.title,
      dueDate: suggested.due_date,
      priority: suggested.priority,
      module: "voice_memo",
      relatedTable: draft.source_table as string | undefined,
      relatedId: draft.source_id as string | undefined,
      sourceDraftId: draft.id as string,
    });
    created.push(task);
  }

  if (draft.source_table === "voice_memos" && draft.source_id) {
    await db.update("voice_memos", draft.source_id as string, {
      status: "processed",
      detected_category: content.detected_category,
    });
  }

  return created;
}

/**
 * 捕獲者からのLINE連絡の分類結果 → 対応タスクを作成 + 受信メッセージを対応済みに。
 *
 * 既存ジビエ基幹テーブル（individuals / hunters / orders）には一切書き込まない。
 * 捕獲者へのLINE返信もここでは送らない（送信は職員が /line 画面で明示操作する）。
 */
async function applyHunterMessageResult(
  db: DbPort,
  ctx: AuditContext,
  draft: Row,
): Promise<Row[]> {
  const content = hunterMessageOutputSchema.parse(draft.content);
  const intentLabel = HUNTER_INTENT_LABELS[content.detected_intent] ?? content.detected_intent;
  const created: Row[] = [];

  for (const suggested of content.suggested_tasks) {
    const task = await createTask(db, ctx, {
      title: suggested.title,
      dueDate: suggested.due_date,
      priority: suggested.priority,
      module: "hunter_line",
      relatedTable: draft.source_table as string | undefined,
      relatedId: draft.source_id as string | undefined,
      sourceDraftId: draft.id as string,
    });
    created.push(task);
  }

  if (draft.source_table === "line_inbound_messages" && draft.source_id) {
    const message = await db.update("line_inbound_messages", draft.source_id as string, {
      status: "handled",
      detected_intent: content.detected_intent,
    });
    await writeAuditLog(db, ctx, {
      action: "update",
      tableName: "line_inbound_messages",
      recordId: message.id as string,
      after: message,
      note: `捕獲者の連絡を承認（${intentLabel}）`,
    });
  }

  return created;
}

/**
 * FB横展開の承認 → social_channel_drafts に「承認した本文」を固定保存する。
 *
 * draft.content は**承認ボタンを押した瞬間の本文のスナップショット**。
 * AIの元出力（social_channel_drafts.ai_body / crosspost_ai_output のドラフト）は
 * 別レコードとして残り、ここでは触らない。
 */
async function applyCrosspostApproval(
  db: DbPort,
  ctx: AuditContext,
  draft: Row,
): Promise<Row[]> {
  if (draft.source_table !== "social_channel_drafts" || !draft.source_id) {
    return [];
  }
  const content = (draft.content ?? {}) as Record<string, unknown>;
  const body = typeof content.body === "string" ? content.body : "";
  if (!body) throw new Error("承認する本文が空です");

  const updated = await db.update("social_channel_drafts", draft.source_id as string, {
    status: "approved",
    approved_body: body,
    approval_draft_id: draft.id,
    // 要確認だった場合、誰が理由を確認したかを残す（理由自体は消さない）
    review_acknowledged_by: ctx.actorId,
    review_acknowledged_at: new Date().toISOString(),
  });

  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "social_channel_drafts",
    recordId: updated.id as string,
    after: updated,
    note: `承認した本文を確定（${String(content.channel_key ?? "")}・${body.length}字）`,
  });

  return [updated];
}

/** プレゼン構成 / 動画プラン → media_projects.approved_content に確定保存 */
async function applyMediaPlan(db: DbPort, ctx: AuditContext, draft: Row): Promise<Row[]> {
  if (draft.source_table !== "media_projects" || !draft.source_id) {
    return [];
  }
  const project = await db.update("media_projects", draft.source_id as string, {
    approved_content: draft.content,
    status: "approved",
  });
  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "media_projects",
    recordId: project.id as string,
    after: project,
    note: `構成承認（${draft.draft_type}）`,
  });
  return [project];
}

/** 士業相談の整理結果 → advisor_consultations.approved_content に確定保存 */
async function applyAdvisorBrief(db: DbPort, ctx: AuditContext, draft: Row): Promise<Row[]> {
  if (draft.source_table !== "advisor_consultations" || !draft.source_id) {
    return [];
  }
  const consultation = await db.update("advisor_consultations", draft.source_id as string, {
    approved_content: draft.content,
    status: "approved",
  });
  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "advisor_consultations",
    recordId: consultation.id as string,
    after: consultation,
    note: "相談整理を承認",
  });
  return [consultation];
}

/** 投稿原稿（各チャンネル向け）→ social_projects.approved_content に確定保存 */
async function applySocialPosts(db: DbPort, ctx: AuditContext, draft: Row): Promise<Row[]> {
  if (draft.source_table !== "social_projects" || !draft.source_id) {
    return [];
  }
  const project = await db.update("social_projects", draft.source_id as string, {
    approved_content: draft.content,
    status: "approved",
  });
  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "social_projects",
    recordId: project.id as string,
    after: project,
    note: "投稿原稿を承認",
  });
  return [project];
}

/** 補助金申請ドラフト → grant_documents に確定保存 */
async function applyGrantApplication(db: DbPort, ctx: AuditContext, draft: Row): Promise<Row[]> {
  const content = grantDraftOutputSchema.parse(draft.content);
  if (draft.source_table !== "grant_projects" || !draft.source_id) {
    // 案件に紐付かないドラフトは承認のみ
    return [];
  }
  const doc = await db.insert("grant_documents", {
    organization_id: ctx.organizationId,
    grant_project_id: draft.source_id,
    doc_type: "application",
    title: draft.title ?? "申請書ドラフト",
    body: content.draft_text,
    source_draft_id: draft.id,
    created_by: ctx.actorId,
  });
  await writeAuditLog(db, ctx, {
    action: "insert",
    tableName: "grant_documents",
    recordId: doc.id as string,
    after: doc,
  });
  return [doc];
}
