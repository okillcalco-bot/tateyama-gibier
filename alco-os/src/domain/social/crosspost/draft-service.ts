import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";
import { approveDraft } from "@/domain/drafts/draft-service";
import { evaluateReview } from "./sensitive";
import { DRAFT_STATUS_LABELS, type DraftStatus } from "./channels";
import type { ChannelDraft } from "@/ai/schemas/crosspost.schema";

/**
 * 媒体ごとの下書き（0029）。
 *
 * 中核ルール:
 * - `ai_body` は**AIが最初に出した文章**。編集しても書き換えない（証跡）
 * - `edited_body` は人が直した作業コピー
 * - 承認ボタンを押した瞬間の本文を `approved_body` として固定し、
 *   その本文で generated_drafts を1件作って approveDraft() に通す
 * - つまり「AIの元出力」と「人が承認した本文」が別レコードで両方残る
 */

export interface ChannelSpecLite {
  key: string;
  label: string;
  maxChars: number | null;
}

export interface SaveDraftsInput {
  sourceId: string;
  /** この生成で使ったAI出力ドラフト（証跡）のID */
  aiGeneratedDraftId: string | null;
  drafts: ChannelDraft[];
  specs: ChannelSpecLite[];
  sourceBody: string;
  hasPersonPhoto: boolean;
  needsPublicCheck: boolean;
  aiFlags: string[];
  styleProfileId: string | null;
  styleVersion: number | null;
}

/** 承認済み・投稿済みの下書きは生成で上書きしない */
const PROTECTED: DraftStatus[] = ["approved", "queued", "published"];

/**
 * 生成結果を媒体ごとの行に落とす。
 * 文字数超過は**生成全体を失敗させず**、その媒体だけ要確認にする。
 */
export async function saveGeneratedDrafts(
  db: DbPort,
  ctx: AuditContext,
  input: SaveDraftsInput,
): Promise<Row[]> {
  const saved: Row[] = [];

  for (const draft of input.drafts) {
    const spec = input.specs.find((s) => s.key === draft.channel_key);
    if (!spec) continue;

    const existing = await findDraft(db, input.sourceId, draft.channel_key);
    if (existing && PROTECTED.includes(existing.status as DraftStatus)) {
      // 承認済みのものは守る
      continue;
    }

    const review = evaluateReview({
      sourceBody: input.sourceBody,
      channelBody: draft.body,
      hasPersonPhoto: input.hasPersonPhoto,
      needsPublicCheck: input.needsPublicCheck,
      maxChars: spec.maxChars,
      aiFlags: input.aiFlags,
      anonymizedNotes: draft.anonymized_notes,
    });

    const patch: Row = {
      ai_generated_draft_id: input.aiGeneratedDraftId,
      ai_body: draft.body,
      // 生成し直したときは編集内容を消す（人の修正は承認前の作業コピーのため）
      edited_body: null,
      title: draft.title,
      hashtags: draft.hashtags,
      link_guidance: draft.link_guidance,
      cta: draft.cta,
      photo_order: draft.photo_order,
      photo_captions: draft.photo_captions,
      narration: draft.narration,
      cautions: draft.cautions,
      anonymized_notes: draft.anonymized_notes,
      // 文字数はAIの自己申告を信じず、ここで数え直す
      char_count: draft.body.length,
      status: review.needsReview ? "needs_review" : "draft",
      review_reasons: review.reasons,
      error_message: null,
      style_profile_id: input.styleProfileId,
      style_version: input.styleVersion,
    };

    if (existing) {
      const count = Number(existing.regenerate_count ?? 0);
      saved.push(
        await db.update("social_channel_drafts", existing.id as string, {
          ...patch,
          regenerate_count: count + 1,
        }),
      );
    } else {
      saved.push(
        await db.insert("social_channel_drafts", {
          organization_id: ctx.organizationId,
          social_source_id: input.sourceId,
          channel_key: draft.channel_key,
          created_by: ctx.actorId,
          ...patch,
        }),
      );
    }
  }

  return saved;
}

/** バッチが失敗したとき、その媒体だけエラーにする（他の媒体は残す） */
export async function markChannelsFailed(
  db: DbPort,
  ctx: AuditContext,
  params: { sourceId: string; channelKeys: string[]; message: string },
): Promise<void> {
  for (const key of params.channelKeys) {
    const existing = await findDraft(db, params.sourceId, key);
    if (existing && PROTECTED.includes(existing.status as DraftStatus)) continue;

    if (existing) {
      await db.update("social_channel_drafts", existing.id as string, {
        status: "error",
        error_message: params.message,
      });
    } else {
      await db.insert("social_channel_drafts", {
        organization_id: ctx.organizationId,
        social_source_id: params.sourceId,
        channel_key: key,
        status: "error",
        error_message: params.message,
        created_by: ctx.actorId,
      });
    }
  }
}

export async function findDraft(
  db: DbPort,
  sourceId: string,
  channelKey: string,
): Promise<Row | null> {
  const rows = await db.findMany(
    "social_channel_drafts",
    { social_source_id: sourceId, channel_key: channelKey },
    1,
  );
  return rows[0] ?? null;
}

export async function listDrafts(db: DbPort, sourceId: string): Promise<Row[]> {
  return db.findMany("social_channel_drafts", { social_source_id: sourceId }, 50);
}

/** 承認の対象になる本文。人が直していればそちら、なければAIの文章 */
export function resolveFinalBody(draft: Row): string {
  const edited = typeof draft.edited_body === "string" ? draft.edited_body.trim() : "";
  if (edited) return edited;
  const ai = typeof draft.ai_body === "string" ? draft.ai_body : "";
  return ai;
}

/** 本文の編集（スタッフができる） */
export async function editDraftBody(
  db: DbPort,
  ctx: AuditContext,
  params: { draftId: string; body: string },
): Promise<Row> {
  const before = await db.findById("social_channel_drafts", params.draftId);
  if (!before) throw new Error("下書きが見つかりません");
  if (PROTECTED.includes(before.status as DraftStatus)) {
    throw new Error("承認済みの下書きは編集できません。差し戻してから直してください");
  }

  const body = params.body.trim();
  if (!body) throw new Error("本文を入力してください");

  const after = await db.update("social_channel_drafts", params.draftId, {
    edited_body: body,
    char_count: body.length,
    // 編集しても要確認の理由は消さない
    status: before.status === "needs_review" ? "needs_review" : "editing",
  });

  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "social_channel_drafts",
    recordId: params.draftId,
    note: `${before.channel_key} の本文を編集（${body.length}字）`,
  });

  return after;
}

export interface ApproveChannelInput {
  draftId: string;
  /** 要確認の理由を読んだうえで承認する場合 true（センシティブ時は必須） */
  acknowledgeReasons?: boolean;
  now?: Date;
}

/**
 * 媒体ごとの承認。
 *
 * 1. その瞬間の本文（edited_body ?? ai_body）を固定
 * 2. 固定した本文で generated_drafts(crosspost_approval) を1件作る
 * 3. approveDraft() に通す（監査ログ・承認者・承認日時はここで付く）
 * 4. applyDraft() が social_channel_drafts に approved_body を書く
 *
 * 失敗した場合、承認は成立しない（「承認だけ通って本文が入らない」向きには壊れない）。
 */
export async function approveChannelDraft(
  db: DbPort,
  ctx: AuditContext,
  input: ApproveChannelInput,
): Promise<{ draft: Row; approvalDraftId: string }> {
  const draft = await db.findById("social_channel_drafts", input.draftId);
  if (!draft) throw new Error("下書きが見つかりません");
  if (draft.status === "approved" || draft.status === "published") {
    throw new Error("この下書きはすでに承認されています");
  }
  if (draft.status === "not_generated" || draft.status === "error") {
    throw new Error("先に下書きを作ってください");
  }

  const reasons = Array.isArray(draft.review_reasons) ? (draft.review_reasons as string[]) : [];
  if (reasons.length > 0 && !input.acknowledgeReasons) {
    throw new Error("要確認の理由を確認してから承認してください");
  }

  const finalBody = resolveFinalBody(draft);
  if (!finalBody) throw new Error("本文が空です");

  const now = (input.now ?? new Date()).toISOString();

  // 承認スナップショット（この内容で承認したという証跡）
  const approvalDraft = await db.insert("generated_drafts", {
    organization_id: ctx.organizationId,
    draft_type: "crosspost_approval",
    source_table: "social_channel_drafts",
    source_id: input.draftId,
    title: `${draft.channel_key} の承認本文`,
    content: {
      channel_key: draft.channel_key,
      body: finalBody,
      title: draft.title ?? null,
      hashtags: draft.hashtags ?? [],
      cta: draft.cta ?? null,
      link_guidance: draft.link_guidance ?? null,
      photo_order: draft.photo_order ?? [],
      // 承認時点で残っていた要確認の理由も一緒に固定する
      review_reasons: reasons,
      snapshot_at: now,
    },
    needs_human_review: false,
    warnings: reasons,
    status: "draft",
    created_by: ctx.actorId,
  });

  // approveDraft() が applyDraft → generated_drafts を approved に更新
  await approveDraft(db, ctx, approvalDraft.id as string);

  const updated = await db.findById("social_channel_drafts", input.draftId);

  await writeAuditLog(db, ctx, {
    action: "approve",
    tableName: "social_channel_drafts",
    recordId: input.draftId,
    note:
      reasons.length > 0
        ? `${draft.channel_key} を承認（確認した理由: ${reasons.join(" / ")}）`
        : `${draft.channel_key} を承認`,
  });

  return { draft: updated ?? draft, approvalDraftId: approvalDraft.id as string };
}

/** 却下（理由を必ず残す） */
export async function rejectChannelDraft(
  db: DbPort,
  ctx: AuditContext,
  params: { draftId: string; reason: string },
): Promise<Row> {
  const draft = await db.findById("social_channel_drafts", params.draftId);
  if (!draft) throw new Error("下書きが見つかりません");
  if (draft.status === "published") throw new Error("投稿済みの下書きは却下できません");

  const reason = params.reason.trim();
  if (!reason) throw new Error("却下の理由を書いてください");

  const after = await db.update("social_channel_drafts", params.draftId, {
    status: "rejected",
    reject_reason: reason,
  });

  await writeAuditLog(db, ctx, {
    action: "discard",
    tableName: "social_channel_drafts",
    recordId: params.draftId,
    before: draft,
    after,
    note: `${draft.channel_key} を却下: ${reason}`,
  });

  return after;
}

/** 承認を差し戻す（修正したくなったとき） */
export async function reopenChannelDraft(
  db: DbPort,
  ctx: AuditContext,
  draftId: string,
): Promise<Row> {
  const draft = await db.findById("social_channel_drafts", draftId);
  if (!draft) throw new Error("下書きが見つかりません");
  if (draft.status === "published") throw new Error("投稿済みの下書きは差し戻せません");

  const reasons = Array.isArray(draft.review_reasons) ? (draft.review_reasons as string[]) : [];
  const after = await db.update("social_channel_drafts", draftId, {
    status: reasons.length > 0 ? "needs_review" : "editing",
    approved_body: null,
    approval_draft_id: null,
    approved_by: null,
    approved_at: null,
  });

  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "social_channel_drafts",
    recordId: draftId,
    note: `${draft.channel_key} の承認を差し戻し`,
  });

  return after;
}

/** 画面に出す状態のまとめ */
export function describeStatus(status: string): string {
  return DRAFT_STATUS_LABELS[status as DraftStatus] ?? status;
}
