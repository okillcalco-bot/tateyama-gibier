"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getCurrentUser } from "@/lib/auth";
import {
  createBoardPost,
  archiveBoardPost,
  setCustomerTier,
  type Audience,
  type CustomerTier,
} from "@/domain/board/board-service";
import { writeAuditLog } from "@/domain/audit/audit-log-service";
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

export async function createBoardPostAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { supabase, db, ctx } = await requireCtx();
    const audience = String(formData.get("audience") ?? "staff") as Audience;

    // 精肉DBリンク: 投稿時点の在庫（products.stock_qty が正 — docs/09）を添付
    let inventorySnapshot: unknown[] | null = null;
    if (audience === "customer" && formData.get("attach_inventory")) {
      const { data } = await supabase
        .from("products")
        .select("name, category, unit, price, stock_qty")
        .gt("stock_qty", 0)
        .is("deleted_at", null)
        .order("category")
        .order("name")
        .limit(100);
      inventorySnapshot = data ?? [];
    }

    await createBoardPost(db, ctx, {
      audience,
      title: String(formData.get("title") ?? ""),
      body: String(formData.get("body") ?? ""),
      manualTags: String(formData.get("tags") ?? "")
        .split(/[,、\s]+/)
        .filter(Boolean),
      targetRoles: formData.getAll("target_roles").map(String).filter(Boolean),
      targetTiers: formData.getAll("target_tiers").map(String).filter(Boolean) as CustomerTier[],
      inventorySnapshot,
      pinned: Boolean(formData.get("pinned")),
    });
    revalidatePath("/board");
    revalidatePath("/");
  });
}

export async function archiveBoardPostAction(postId: string): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    await archiveBoardPost(db, ctx, postId);
    revalidatePath("/board");
    revalidatePath("/");
  });
}

export async function setCustomerTierAction(
  customerId: string,
  tier: CustomerTier,
): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    await setCustomerTier(db, ctx, customerId, tier);
    revalidatePath("/board");
  });
}

/** スタッフの役割設定（既存 staff.role を更新。宛先の絞り込みに使う） */
export async function setStaffRoleAction(staffId: string, role: string): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    const before = await db.findById("staff", staffId);
    if (!before) throw new Error("スタッフが見つかりません");
    const after = await db.update("staff", staffId, { role: role.trim() || null });
    await writeAuditLog(db, ctx, {
      action: "update",
      tableName: "staff",
      recordId: staffId,
      before,
      after,
      note: `役割を「${role.trim() || "なし"}」に設定`,
    });
    revalidatePath("/board");
    revalidatePath("/hr");
  });
}
