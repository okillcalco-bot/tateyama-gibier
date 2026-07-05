"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getCurrentUser } from "@/lib/auth";
import { updateTaskStatus } from "@/domain/tasks/task-service";
import { runAction, type ActionResult } from "@/lib/action-result";

/** タスクの状態変更（未着手 / 対応中 / 完了）。監査ログ付き。 */
export async function setTaskStatusAction(
  taskId: string,
  status: "open" | "in_progress" | "done",
): Promise<ActionResult> {
  return runAction(async () => {
    const supabase = await createSupabaseServerClient();
    const user = await getCurrentUser(supabase);
    if (!user) throw new Error("ログインが必要です");

    await updateTaskStatus(
      new SupabaseDb(supabase),
      { organizationId: user.organizationId, actorId: user.userId },
      taskId,
      status,
    );

    revalidatePath("/tasks");
    revalidatePath("/");
  });
}
