"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getCurrentUser, canApprove } from "@/lib/auth";
import {
  runAction,
  runActionWith,
  type ActionResult,
  type ActionResultWith,
} from "@/lib/action-result";
import { getProvider } from "@/ai/model-router";
import { analyzeCrosspostSource } from "@/ai/workflows/analyze-crosspost-source";
import { generateCrosspostDrafts } from "@/ai/workflows/generate-crosspost-drafts";
import { createSource, attachAsset } from "@/domain/social/crosspost/source-service";
import {
  generateDraftsForSource,
  type GenerationResult,
} from "@/domain/social/crosspost/generation-service";
import {
  approveChannelDraft,
  editDraftBody,
  rejectChannelDraft,
  reopenChannelDraft,
} from "@/domain/social/crosspost/draft-service";
import { recordPublication } from "@/domain/social/crosspost/publication-service";
import { saveStyleVersion } from "@/domain/social/crosspost/style-service";

/**
 * FB横展開システムの操作（Phase 1）。
 *
 * 権限:
 * - スタッフ … 元投稿の登録、本文の編集、下書きの生成・再生成
 * - owner / manager … 承認、却下、差し戻し、投稿済み登録、スタイル変更
 *   （DB側のトリガーとポリシーでも強制。ここは二重チェック）
 */

async function requireUser() {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");
  return { supabase, user, ctx: { organizationId: user.organizationId, actorId: user.userId } };
}

async function requireApprover() {
  const session = await requireUser();
  if (!(await canApprove(session.supabase))) {
    throw new Error("この操作には承認権限が必要です（管理者に依頼してください）");
  }
  return session;
}

export async function createSourceAction(
  formData: FormData,
): Promise<ActionResultWith<{ sourceId: string; warnings: string[] }>> {
  return runActionWith(async () => {
    const { supabase, ctx } = await requireUser();
    const db = new SupabaseDb(supabase);

    const { source, warnings } = await createSource(db, ctx, {
      sourceUrl: String(formData.get("source_url") ?? ""),
      sourceNo: String(formData.get("source_no") ?? ""),
      title: String(formData.get("title") ?? ""),
      body: String(formData.get("body") ?? ""),
      postedOn: String(formData.get("posted_on") ?? "") || null,
      category: String(formData.get("category") ?? "") || null,
      visibility: String(formData.get("visibility") ?? "") || null,
      note: String(formData.get("note") ?? ""),
    });

    // 写真（複数可）
    const files = formData.getAll("photos").filter((f): f is File => f instanceof File);
    for (const file of files) {
      if (!file.size) continue;
      const path = `crosspost/${source.id}/${Date.now()}-${encodeURIComponent(file.name)}`;
      const { error } = await supabase.storage
        .from("alco-os")
        .upload(path, file, { contentType: file.type, upsert: false });
      if (error) continue;

      const saved = await db.insert("files", {
        organization_id: ctx.organizationId,
        bucket: "alco-os",
        path,
        filename: file.name,
        mime_type: file.type,
        size_bytes: file.size,
        module: "crosspost",
        related_table: "social_sources",
        related_id: source.id,
        created_by: ctx.actorId,
      });
      await attachAsset(db, ctx, {
        sourceId: source.id as string,
        fileId: saved.id as string,
        hasPerson: formData.get("has_person") === "on",
        needsPublicCheck: formData.get("needs_public_check") === "on",
      });
    }

    revalidatePath("/crosspost");
    return { sourceId: source.id as string, warnings };
  });
}

export async function generateDraftsAction(
  formData: FormData,
): Promise<ActionResultWith<GenerationResult>> {
  return runActionWith(async () => {
    const { supabase, ctx } = await requireUser();
    const db = new SupabaseDb(supabase);
    const sourceId = String(formData.get("source_id") ?? "");
    if (!sourceId) throw new Error("対象が指定されていません");

    const only = String(formData.get("channel_key") ?? "").trim();
    const provider = getProvider();
    const workflowCtx = {
      db,
      provider,
      organizationId: ctx.organizationId,
      userId: ctx.actorId,
    };

    const result = await generateDraftsForSource(
      {
        db,
        ctx,
        analyze: async (input) => {
          const run = await analyzeCrosspostSource(
            workflowCtx,
            {
              body: input.body,
              title: input.title,
              category: input.category,
              posted_on: input.postedOn,
            },
            { sourceId },
          );
          return { output: run.output };
        },
        generate: async (input) => {
          const run = await generateCrosspostDrafts(
            workflowCtx,
            {
              body: input.body,
              fact_sheet: input.factSheet,
              channels: input.channels.map((c) => ({
                channel_key: c.key,
                label: c.label,
                min_chars: c.minChars,
                max_chars: c.maxChars,
                max_hashtags: c.maxHashtags,
                cta_policy: c.ctaPolicy,
                guidance: c.guidance,
              })),
              style: input.style,
              photo_captions: input.photoCaptions,
            },
            { sourceId },
          );
          return { output: run.output, draftId: run.draftId };
        },
      },
      { sourceId, channelKeys: only ? [only] : undefined },
    );

    revalidatePath(`/crosspost/${sourceId}`);
    return result;
  });
}

export async function editDraftAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { supabase, ctx } = await requireUser();
    await editDraftBody(new SupabaseDb(supabase), ctx, {
      draftId: String(formData.get("draft_id") ?? ""),
      body: String(formData.get("body") ?? ""),
    });
    revalidatePath(`/crosspost/${String(formData.get("source_id") ?? "")}`);
  });
}

export async function approveDraftAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { supabase, ctx } = await requireApprover();
    await approveChannelDraft(new SupabaseDb(supabase), ctx, {
      draftId: String(formData.get("draft_id") ?? ""),
      // 要確認の理由を読んだうえで押すボタン（二段階にしない）
      acknowledgeReasons: formData.get("acknowledge") === "on",
    });
    revalidatePath(`/crosspost/${String(formData.get("source_id") ?? "")}`);
  });
}

export async function rejectDraftAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { supabase, ctx } = await requireApprover();
    await rejectChannelDraft(new SupabaseDb(supabase), ctx, {
      draftId: String(formData.get("draft_id") ?? ""),
      reason: String(formData.get("reason") ?? ""),
    });
    revalidatePath(`/crosspost/${String(formData.get("source_id") ?? "")}`);
  });
}

export async function reopenDraftAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { supabase, ctx } = await requireApprover();
    await reopenChannelDraft(
      new SupabaseDb(supabase),
      ctx,
      String(formData.get("draft_id") ?? ""),
    );
    revalidatePath(`/crosspost/${String(formData.get("source_id") ?? "")}`);
  });
}

export async function recordPublishedAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { supabase, ctx } = await requireApprover();
    const sourceId = String(formData.get("source_id") ?? "");
    await recordPublication(new SupabaseDb(supabase), ctx, {
      sourceId,
      draftId: String(formData.get("draft_id") ?? ""),
      postedUrl: String(formData.get("posted_url") ?? ""),
    });
    revalidatePath(`/crosspost/${sourceId}`);
  });
}

export async function saveStyleAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { supabase, ctx } = await requireApprover();
    await saveStyleVersion(new SupabaseDb(supabase), ctx, {
      structureNotes: String(formData.get("structure_notes") ?? ""),
      keepRules: String(formData.get("keep_rules") ?? ""),
      avoidRules: String(formData.get("avoid_rules") ?? ""),
      hardRules: String(formData.get("hard_rules") ?? ""),
    });
    revalidatePath("/crosspost/settings");
  });
}

export async function toggleChannelAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { supabase, ctx } = await requireApprover();
    const channelId = String(formData.get("channel_id") ?? "");
    const enabled = formData.get("enabled") === "on";
    if (!channelId) throw new Error("対象が指定されていません");

    const db = new SupabaseDb(supabase);
    await db.update("social_channels", channelId, { enabled });
    const { writeAuditLog } = await import("@/domain/audit/audit-log-service");
    await writeAuditLog(db, ctx, {
      action: "update",
      tableName: "social_channels",
      recordId: channelId,
      note: `媒体を${enabled ? "有効" : "非表示"}にした`,
    });
    revalidatePath("/crosspost/settings");
  });
}
