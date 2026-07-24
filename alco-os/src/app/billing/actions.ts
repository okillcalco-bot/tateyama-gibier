"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getCurrentUser } from "@/lib/auth";
import { loadIssuer } from "@/lib/issuer";
import {
  issueManualDocument,
  convertDocument,
  voidDocument,
  type DocType,
  type ManualItemInput,
} from "@/domain/billing/billing-service";
import { parseCsv, mapMisocaRows, importMisocaDocuments } from "@/domain/billing/misoca-import";
import {
  runAction,
  runActionWith,
  type ActionResult,
  type ActionResultWith,
} from "@/lib/action-result";

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

/** 自由入力の帳票発行（見積書・納品書・請求書・領収書）。成功時は帳票ID */
export async function createManualDocumentAction(
  formData: FormData,
): Promise<ActionResultWith<string>> {
  return runActionWith(async () => {
    const { supabase, db, ctx } = await requireCtx();
    const issuer = await loadIssuer(supabase);

    // 明細行: item_name_0, item_qty_0, item_price_0, item_amount_0 ... の形式
    const items: ManualItemInput[] = [];
    for (let i = 0; i < 20; i++) {
      const name = String(formData.get(`item_name_${i}`) ?? "");
      if (!name.trim()) continue;
      const qty = String(formData.get(`item_qty_${i}`) ?? "").trim();
      const price = Number(formData.get(`item_price_${i}`));
      const amount = Number(formData.get(`item_amount_${i}`));
      items.push({
        name,
        quantity: qty || "1",
        unitPrice: Number.isFinite(price) && price > 0 ? price : null,
        amount: Number.isFinite(amount) ? amount : 0,
      });
    }

    const doc = await issueManualDocument(db, ctx, {
      docType: String(formData.get("doc_type") ?? "quote") as DocType,
      title: String(formData.get("title") ?? ""),
      issueDate: String(formData.get("issue_date") ?? ""),
      dueDate: String(formData.get("due_date") ?? "") || null,
      taxRate: Number(formData.get("tax_rate") ?? 8),
      note: String(formData.get("note") ?? ""),
      customerName: String(formData.get("customer_name") ?? ""),
      customerAddress: String(formData.get("customer_address") ?? ""),
      items,
      issuer,
    });
    revalidatePath("/billing");
    return doc.id as string;
  });
}

/** 書類変換（見積→納品/請求、納品→請求、請求→領収）。成功時は新しい帳票ID */
export async function convertDocumentAction(
  sourceDocId: string,
  targetType: DocType,
): Promise<ActionResultWith<string>> {
  return runActionWith(async () => {
    const { db, ctx } = await requireCtx();
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    const doc = await convertDocument(db, ctx, sourceDocId, targetType, today);
    revalidatePath("/billing");
    return doc.id as string;
  });
}

export async function voidDocumentFromBillingAction(docId: string): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    await voidDocument(db, ctx, docId);
    revalidatePath("/billing");
  });
}

/** Misoca CSVインポート（書類一覧CSV。UTF-8 / Shift_JIS 両対応） */
export async function importMisocaCsvAction(
  formData: FormData,
): Promise<ActionResultWith<{ imported: number; duplicates: number; skipped: number }>> {
  return runActionWith(async () => {
    const { db, ctx } = await requireCtx();
    const docType = String(formData.get("doc_type") ?? "invoice") as DocType;
    const file = formData.get("csv");
    if (!(file instanceof File) || file.size === 0) {
      throw new Error("CSVファイルを選択してください");
    }
    if (file.size > 5 * 1024 * 1024) throw new Error("CSVが大きすぎます（5MBまで）");

    const buffer = await file.arrayBuffer();
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      try {
        text = new TextDecoder("shift_jis").decode(buffer);
      } catch {
        throw new Error(
          "文字コードを認識できません。ExcelやスプレッドシートでUTF-8のCSVとして保存し直してください",
        );
      }
    }

    const { docs, skipped } = mapMisocaRows(parseCsv(text));
    if (!docs.length) throw new Error("取り込める行がありませんでした（列名・日付・金額を確認）");
    const result = await importMisocaDocuments(db, ctx, docType, docs);
    revalidatePath("/billing");
    return { ...result, skipped };
  });
}
