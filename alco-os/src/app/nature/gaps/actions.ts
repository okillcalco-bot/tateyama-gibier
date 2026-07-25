"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getCurrentUser } from "@/lib/auth";
import {
  createQuest,
  publishQuest,
  unpublishQuest,
  updateQuestProgress,
} from "@/domain/satoyama/quest-service";
import {
  confirmPledge,
  cancelPledge,
  recordPayout,
} from "@/domain/satoyama/funding-service";
import { runAction, type ActionResult } from "@/lib/action-result";

async function requireCtx() {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");
  return {
    supabase,
    db: new SupabaseDb(supabase),
    ctx: { organizationId: user.organizationId, actorId: user.userId },
  };
}

export async function createQuestAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    await createQuest(db, ctx, {
      title: String(formData.get("title") ?? ""),
      story: String(formData.get("story") ?? ""),
      siteId: String(formData.get("site_id") ?? "") || null,
      taxonGroup: String(formData.get("taxon_group") ?? "") || null,
      season: String(formData.get("season") ?? "") || null,
      method: String(formData.get("method") ?? "") || null,
      targetCount: Number(formData.get("target_count")) || 1,
      fundingGoalYen: Number(formData.get("funding_goal_yen")) || 0,
      rewardTitle: String(formData.get("reward_title") ?? "") || null,
      restricted: Boolean(formData.get("restricted")),
    });
    revalidatePath("/nature/gaps");
  });
}

export async function publishQuestAction(questId: string, publish: boolean): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    if (publish) await publishQuest(db, ctx, questId);
    else await unpublishQuest(db, ctx, questId);
    revalidatePath("/nature/gaps");
  });
}

export async function updateQuestProgressAction(
  questId: string,
  progressCount: number,
): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    await updateQuestProgress(db, ctx, questId, progressCount);
    revalidatePath("/nature/gaps");
  });
}

export async function confirmPledgeAction(pledgeId: string): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    await confirmPledge(db, ctx, pledgeId);
    revalidatePath("/nature/gaps");
  });
}

export async function cancelPledgeAction(
  pledgeId: string,
  status: "cancelled" | "refunded",
): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    await cancelPledge(db, ctx, pledgeId, status);
    revalidatePath("/nature/gaps");
  });
}

export async function recordPayoutAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    await recordPayout(db, ctx, {
      taskId: String(formData.get("task_id") ?? ""),
      payeeName: String(formData.get("payee_name") ?? ""),
      amountYen: Number(formData.get("amount_yen")),
      paidOn: String(formData.get("paid_on") ?? ""),
      purpose: String(formData.get("purpose") ?? ""),
    });
    revalidatePath("/nature/gaps");
  });
}
