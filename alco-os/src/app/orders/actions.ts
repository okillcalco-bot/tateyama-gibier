"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getCurrentUser } from "@/lib/auth";
import { updateOrderStatus, type OrderStatus } from "@/domain/orders/order-service";
import { runAction, type ActionResult } from "@/lib/action-result";

export async function updateOrderStatusAction(
  orderId: string,
  status: OrderStatus,
): Promise<ActionResult> {
  return runAction(async () => {
    const supabase = await createSupabaseServerClient();
    const user = await getCurrentUser(supabase);
    if (!user) throw new Error("ログインが必要です");
    const db = new SupabaseDb(supabase);
    await updateOrderStatus(
      db,
      { organizationId: user.organizationId, actorId: user.userId },
      orderId,
      status,
    );
    revalidatePath("/orders");
  });
}
