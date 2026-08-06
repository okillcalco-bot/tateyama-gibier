"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getCurrentUser } from "@/lib/auth";
import { jstToday } from "@/lib/jst";
import { getProvider } from "@/ai/model-router";
import { parseReceipt } from "@/ai/workflows/parse-receipt";
import { receiptOutputSchema } from "@/ai/schemas/receipt.schema";
import type { ImageInput } from "@/ai/types";
import { approveDraft, discardDraft } from "@/domain/drafts/draft-service";
import { createExpense, updateExpense, voidExpense } from "@/domain/accounting/expense-service";
import { runAction, type ActionResult } from "@/lib/action-result";

const STORAGE_BUCKET = "alco-os";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES: Record<string, ImageInput["mediaType"]> = {
  "image/jpeg": "image/jpeg",
  "image/jpg": "image/jpeg",
  "image/png": "image/png",
  "image/webp": "image/webp",
  "image/gif": "image/gif",
};

/**
 * レシート写真のアップロード → AI読み取り。
 * ここでは expenses に登録しない（人が画面で確認して登録する）。
 */
async function do_uploadReceipt(formData: FormData) {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");

  const photo = formData.get("photo");
  if (!(photo instanceof File) || photo.size === 0) {
    throw new Error("レシートの写真を選んでください");
  }
  if (photo.size > MAX_UPLOAD_BYTES) {
    throw new Error("写真が大きすぎます（10MBまで）。撮り直すか縮小してください");
  }
  const mediaType = ALLOWED_IMAGE_TYPES[photo.type];
  if (!mediaType) {
    throw new Error("対応していない画像形式です（JPEG / PNG / WebP / GIF）");
  }

  const hint = String(formData.get("hint") ?? "").trim();
  const db = new SupabaseDb(supabase);

  const buffer = Buffer.from(await photo.arrayBuffer());
  const ext = mediaType.split("/")[1];
  const path = `expenses/${user.organizationId}/${jstToday()}/${crypto.randomUUID()}.${ext}`;
  const { error: uploadError } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, buffer, { contentType: mediaType });
  if (uploadError) throw new Error(`写真のアップロードに失敗しました: ${uploadError.message}`);

  const file = await db.insert("files", {
    organization_id: user.organizationId,
    bucket: STORAGE_BUCKET,
    path,
    filename: photo.name,
    mime_type: mediaType,
    size_bytes: photo.size,
    module: "expenses",
    related_table: "expenses",
    created_by: user.userId,
  });

  // AIは候補を出すだけ。読み取りに失敗しても写真は残る（手入力で登録できる）
  await parseReceipt(
    {
      db,
      provider: getProvider(),
      organizationId: user.organizationId,
      userId: user.userId,
    },
    { hint, today: jstToday() },
    [{ mediaType, base64: buffer.toString("base64") }],
    { fileId: file.id as string },
  );

  revalidatePath("/expenses");
}

/** 人が確認して確定登録する。ここで初めて expenses に入る */
async function do_confirmExpense(formData: FormData) {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");

  const db = new SupabaseDb(supabase);
  const ctx = { organizationId: user.organizationId, actorId: user.userId };
  const draftId = String(formData.get("draft_id") ?? "").trim() || null;

  let aiSuggestion = null;
  let receiptFileId: string | null = null;
  if (draftId) {
    const draft = await db.findById("generated_drafts", draftId);
    if (!draft) throw new Error("読み取り結果が見つかりません");
    if (draft.draft_type !== "receipt_result") throw new Error("種類が違います");
    aiSuggestion = receiptOutputSchema.parse(draft.content);
    receiptFileId = (draft.source_id as string) ?? null;
  }

  await createExpense(db, ctx, {
    expenseDate: String(formData.get("expense_date") ?? ""),
    amount: Number(formData.get("amount")),
    vendor: String(formData.get("vendor") ?? ""),
    category: String(formData.get("category") ?? ""),
    paymentMethod: String(formData.get("payment_method") ?? ""),
    taxRate: formData.get("tax_rate") ? Number(formData.get("tax_rate")) : null,
    taxAmount: formData.get("tax_amount") ? Number(formData.get("tax_amount")) : null,
    invoiceNumber: String(formData.get("invoice_number") ?? ""),
    note: String(formData.get("note") ?? ""),
    items: aiSuggestion?.items ?? null,
    receiptFileId,
    aiSuggestion,
    aiDraftId: draftId,
  });

  // 読み取り結果は「確認済み」にする（承認の記録は draft-service が残す）
  if (draftId) await approveDraft(db, ctx, draftId);

  revalidatePath("/expenses");
}

/** 読み取り結果を使わない（重複・失敗）。写真とログは残る */
async function do_discardReceipt(draftId: string) {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");

  const db = new SupabaseDb(supabase);
  await discardDraft(db, { organizationId: user.organizationId, actorId: user.userId }, draftId);
  revalidatePath("/expenses");
}

/** 登録後の修正（金額の打ち間違いなど） */
async function do_updateExpense(formData: FormData) {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");

  const id = String(formData.get("id") ?? "");
  if (!id) throw new Error("対象が指定されていません");

  const db = new SupabaseDb(supabase);
  await updateExpense(db, { organizationId: user.organizationId, actorId: user.userId }, id, {
    expenseDate: String(formData.get("expense_date") ?? ""),
    amount: Number(formData.get("amount")),
    vendor: String(formData.get("vendor") ?? ""),
    category: String(formData.get("category") ?? ""),
    paymentMethod: String(formData.get("payment_method") ?? ""),
    invoiceNumber: String(formData.get("invoice_number") ?? ""),
    note: String(formData.get("note") ?? ""),
  });

  revalidatePath("/expenses");
}

/** 取消（消さずに残す） */
async function do_voidExpense(formData: FormData) {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");

  const id = String(formData.get("id") ?? "");
  if (!id) throw new Error("対象が指定されていません");

  const db = new SupabaseDb(supabase);
  await voidExpense(
    db,
    { organizationId: user.organizationId, actorId: user.userId },
    id,
    String(formData.get("reason") ?? ""),
  );

  revalidatePath("/expenses");
}

export async function uploadReceiptAction(formData: FormData): Promise<ActionResult> {
  return runAction(() => do_uploadReceipt(formData));
}
export async function confirmExpenseAction(formData: FormData): Promise<ActionResult> {
  return runAction(() => do_confirmExpense(formData));
}
export async function discardReceiptAction(draftId: string): Promise<ActionResult> {
  return runAction(() => do_discardReceipt(draftId));
}
export async function updateExpenseAction(formData: FormData): Promise<ActionResult> {
  return runAction(() => do_updateExpense(formData));
}
export async function voidExpenseAction(formData: FormData): Promise<ActionResult> {
  return runAction(() => do_voidExpense(formData));
}
