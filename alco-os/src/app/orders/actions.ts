"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getCurrentUser } from "@/lib/auth";
import { updateOrderStatus, type OrderStatus } from "@/domain/orders/order-service";
import { writeAuditLog } from "@/domain/audit/audit-log-service";
import { issueDocument, voidDocument, type DocType } from "@/domain/billing/billing-service";
import { loadIssuer } from "@/lib/issuer";
import {
  runAction,
  runActionWith,
  type ActionResult,
  type ActionResultWith,
} from "@/lib/action-result";

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

// ── 帳票（請求書 / 納品書 / 領収書） ──

/** 帳票発行。成功時は帳票IDを返す（クライアントで印刷ページへ遷移） */
export async function issueDocumentAction(
  formData: FormData,
): Promise<ActionResultWith<string>> {
  return runActionWith(async () => {
    const supabase = await createSupabaseServerClient();
    const user = await getCurrentUser(supabase);
    if (!user) throw new Error("ログインが必要です");
    const db = new SupabaseDb(supabase);
    const issuer = await loadIssuer(supabase);

    const doc = await issueDocument(
      db,
      { organizationId: user.organizationId, actorId: user.userId },
      {
        orderId: String(formData.get("order_id") ?? ""),
        docType: String(formData.get("doc_type") ?? "invoice") as DocType,
        title: String(formData.get("title") ?? ""),
        issueDate: String(formData.get("issue_date") ?? ""),
        dueDate: String(formData.get("due_date") ?? "") || null,
        taxRate: Number(formData.get("tax_rate") ?? 8),
        note: String(formData.get("note") ?? ""),
        issuer,
      },
    );
    revalidatePath("/orders");
    return doc.id as string;
  });
}

export async function voidDocumentAction(docId: string): Promise<ActionResult> {
  return runAction(async () => {
    const supabase = await createSupabaseServerClient();
    const user = await getCurrentUser(supabase);
    if (!user) throw new Error("ログインが必要です");
    const db = new SupabaseDb(supabase);
    await voidDocument(db, { organizationId: user.organizationId, actorId: user.userId }, docId);
    revalidatePath("/orders");
  });
}

/** 発行者情報の保存（org_settings のキーを upsert。既存アプリと共用） */
export async function saveIssuerSettingsAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const supabase = await createSupabaseServerClient();
    const user = await getCurrentUser(supabase);
    if (!user) throw new Error("ログインが必要です");

    const entries: Record<string, string> = {
      org_name: String(formData.get("org_name") ?? "").trim(),
      org_postal: String(formData.get("org_postal") ?? "").trim(),
      org_address: String(formData.get("org_address") ?? "").trim(),
      org_phone: String(formData.get("org_phone") ?? "").trim(),
      invoice_number: String(formData.get("invoice_number") ?? "").trim(),
      org_bank_info: String(formData.get("org_bank_info") ?? "").trim(),
    };
    const { error } = await supabase
      .from("org_settings")
      .upsert(
        Object.entries(entries).map(([key, value]) => ({ key, value })),
        { onConflict: "key" },
      );
    if (error) throw new Error(`設定の保存に失敗: ${error.message}`);

    const db = new SupabaseDb(supabase);
    await writeAuditLog(
      db,
      { organizationId: user.organizationId, actorId: user.userId },
      {
        action: "update",
        tableName: "org_settings",
        after: entries,
        note: "帳票の発行者情報を更新",
      },
    );
    revalidatePath("/orders");
  });
}
