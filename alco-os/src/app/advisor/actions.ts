"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getCurrentUser } from "@/lib/auth";
import { getProvider } from "@/ai/model-router";
import { generateAdvisorBrief } from "@/ai/workflows/generate-advisor-brief";
import { writeAuditLog } from "@/domain/audit/audit-log-service";
import type { AdvisorCategory } from "@/ai/schemas/advisor.schema";
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

export async function createConsultationAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    const title = String(formData.get("title") ?? "").trim();
    const question = String(formData.get("question") ?? "").trim();
    if (!title) throw new Error("相談タイトルを入力してください");
    if (!question) throw new Error("相談内容を入力してください");

    const consultation = await db.insert("advisor_consultations", {
      organization_id: ctx.organizationId,
      category: String(formData.get("category") ?? "tax"),
      title,
      question: question.slice(0, 20000),
      status: "open",
      created_by: ctx.actorId,
    });
    await writeAuditLog(db, ctx, {
      action: "insert",
      tableName: "advisor_consultations",
      recordId: consultation.id as string,
      after: consultation,
    });
    revalidatePath("/advisor");
  });
}

export async function generateAdvisorBriefAction(consultationId: string): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    const consultation = await db.findById("advisor_consultations", consultationId);
    if (!consultation) throw new Error("相談が見つかりません");

    await generateAdvisorBrief(
      { db, provider: getProvider(), organizationId: ctx.organizationId, userId: ctx.actorId },
      {
        category: consultation.category as AdvisorCategory,
        title: consultation.title as string,
        question: consultation.question as string,
      },
      { consultationId },
    );
    revalidatePath(`/advisor/${consultationId}`);
    revalidatePath("/drafts");
  });
}

/** 実際に専門家へ相談した結果を記録してクローズ */
export async function closeConsultationAction(
  consultationId: string,
  expertNote: string,
): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    const before = await db.findById("advisor_consultations", consultationId);
    if (!before) throw new Error("相談が見つかりません");
    const after = await db.update("advisor_consultations", consultationId, {
      status: "closed",
      expert_note: expertNote.trim() || null,
    });
    await writeAuditLog(db, ctx, {
      action: "update",
      tableName: "advisor_consultations",
      recordId: consultationId,
      before,
      after,
      note: "専門家相談の結果を記録してクローズ",
    });
    revalidatePath(`/advisor/${consultationId}`);
    revalidatePath("/advisor");
  });
}
