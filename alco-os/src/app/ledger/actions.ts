"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getCurrentUser } from "@/lib/auth";
import {
  createSalesSlip,
  voidSalesSlip,
  type SlipCategory,
  type PaymentMethod,
} from "@/domain/ledger/ledger-service";
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

export async function createSalesSlipAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    await createSalesSlip(db, ctx, {
      saleDate: String(formData.get("sale_date") ?? ""),
      category: String(formData.get("category") ?? "retail") as SlipCategory,
      item: String(formData.get("item") ?? ""),
      quantity: Number(formData.get("quantity")) || null,
      amount: Number(formData.get("amount")),
      paymentMethod: String(formData.get("payment_method") ?? "cash") as PaymentMethod,
      staffName: String(formData.get("staff_name") ?? ""),
      note: String(formData.get("note") ?? ""),
      productId: String(formData.get("product_id") ?? "") || null,
    });
    revalidatePath("/ledger");
  });
}

export async function voidSalesSlipAction(slipId: string): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    await voidSalesSlip(db, ctx, slipId);
    revalidatePath("/ledger");
  });
}
