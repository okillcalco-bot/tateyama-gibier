"use server";

import { createClient } from "@supabase/supabase-js";
import { revalidatePath } from "next/cache";
import { env, isSupabaseConfigured } from "@/lib/env";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { createPledge, type SupportMethod } from "@/domain/satoyama/funding-service";
import { runAction, type ActionResult } from "@/lib/action-result";

/**
 * 公開の応援フォーム（ログイン不要）。
 * service role で書き込むが、受け付けるのは
 * 「公開済み・非制限クエストへの応援表明」だけに限定する。
 * 入金確認は必ず社内（/nature/gaps）で人が行う。
 */
export async function submitPledgeAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    if (!isSupabaseConfigured() || !env.supabaseServiceRoleKey) {
      throw new Error("現在応援を受け付けられません。お手数ですが直接ご連絡ください");
    }
    const slug = String(formData.get("slug") ?? "");
    if (!slug) throw new Error("応援先が不明です");

    const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: { persistSession: false },
    });

    // 公開ビュー経由でのみ対象を特定する（restricted は含まれない）
    const { data: quest } = await supabase
      .from("v_public_quests")
      .select("id, organization_id, title")
      .eq("public_slug", slug)
      .maybeSingle();
    if (!quest) throw new Error("このクエストは現在応援を受け付けていません");

    const db = new SupabaseDb(supabase);
    await createPledge(
      db,
      { organizationId: quest.organization_id as string, actorId: null },
      {
        taskId: quest.id as string,
        displayName: String(formData.get("display_name") ?? ""),
        realName: String(formData.get("real_name") ?? ""),
        email: String(formData.get("email") ?? ""),
        isPublic: formData.get("is_public") !== null,
        amountYen: Number(formData.get("amount_yen")),
        method: (String(formData.get("method") ?? "transfer") as SupportMethod),
        message: String(formData.get("message") ?? ""),
        messagePublic: formData.get("message_public") !== null,
      },
    );

    revalidatePath(`/support/${slug}`);
  });
}
