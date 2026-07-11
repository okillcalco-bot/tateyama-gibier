"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getCurrentUser } from "@/lib/auth";
import { getProvider } from "@/ai/model-router";
import { generateSocialPosts } from "@/ai/workflows/generate-social-posts";
import { markChannelPosted } from "@/domain/social/social-service";
import { writeAuditLog } from "@/domain/audit/audit-log-service";
import type { ChannelKey } from "@/ai/schemas/social.schema";
import { runAction, type ActionResult } from "@/lib/action-result";

async function requireCtx() {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");
  return {
    db: new SupabaseDb(supabase),
    ctx: { organizationId: user.organizationId, actorId: user.userId },
  };
}

export async function createSocialProjectAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    const title = String(formData.get("title") ?? "").trim();
    const sourceText = String(formData.get("source_text") ?? "").trim();
    const channels = formData.getAll("channels").map(String).filter(Boolean);
    if (!title) throw new Error("タイトルを入力してください");
    if (!sourceText) throw new Error("一次データ（元の文章・文字起こし）を貼り付けてください");
    if (!channels.length) throw new Error("投稿先チャンネルを1つ以上選んでください");

    const project = await db.insert("social_projects", {
      organization_id: ctx.organizationId,
      title,
      source_kind: String(formData.get("source_kind") ?? "memo"),
      source_text: sourceText.slice(0, 20000),
      channels,
      status: "brief",
      created_by: ctx.actorId,
    });
    await writeAuditLog(db, ctx, {
      action: "insert",
      tableName: "social_projects",
      recordId: project.id as string,
      after: project,
    });
    revalidatePath("/social");
  });
}

export async function generateSocialPostsAction(projectId: string): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    const project = await db.findById("social_projects", projectId);
    if (!project) throw new Error("案件が見つかりません");

    await generateSocialPosts(
      { db, provider: getProvider(), organizationId: ctx.organizationId, userId: ctx.actorId },
      {
        title: project.title as string,
        source_kind: project.source_kind as string,
        source_text: project.source_text as string,
        channels: (project.channels as ChannelKey[]) ?? [],
      },
      { socialProjectId: projectId },
    );
    revalidatePath(`/social/${projectId}`);
    revalidatePath("/drafts");
  });
}

export async function markChannelPostedAction(
  projectId: string,
  channel: ChannelKey,
): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    await markChannelPosted(db, ctx, projectId, channel);
    revalidatePath(`/social/${projectId}`);
    revalidatePath("/social");
  });
}
