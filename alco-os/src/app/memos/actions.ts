"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getCurrentUser } from "@/lib/auth";
import { getProvider } from "@/ai/model-router";
import { classifyVoiceMemo } from "@/ai/workflows/classify-voice-memo";
import { approveDraft, discardDraft } from "@/domain/drafts/draft-service";

/**
 * 音声メモの登録とAI分類。
 * フロー: voice_memos に原文保存 → AI分類 → generated_drafts に保存（ここで止まる）。
 * タスク等への反映は /drafts での人間承認後のみ。
 */
export async function createAndClassifyMemo(formData: FormData) {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");

  const rawText = String(formData.get("raw_text") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim() || null;
  const sourceType = String(formData.get("source_type") ?? "text_memo");
  if (!rawText) throw new Error("メモ本文を入力してください");

  const db = new SupabaseDb(supabase);

  // 1. 原文を保存（以後、原文は変更しない）
  const memo = await db.insert("voice_memos", {
    organization_id: user.organizationId,
    title,
    raw_text: rawText,
    source_type: sourceType,
    status: "new",
    created_by: user.userId,
  });

  // 2. AI分類 → ドラフト保存（ai_runs 記録込み）
  await classifyVoiceMemo(
    {
      db,
      provider: getProvider(),
      organizationId: user.organizationId,
      userId: user.userId,
    },
    {
      title: title ?? undefined,
      raw_text: rawText,
      source_type: sourceType as "voice_transcript" | "text_memo" | "meeting_note" | "field_note",
    },
    { memoId: memo.id as string },
  );

  await db.update("voice_memos", memo.id as string, { status: "classified" });

  revalidatePath("/memos");
  revalidatePath("/drafts");
}

/** ドラフト承認: 提案タスクの作成などの反映は draft-service が行う */
export async function approveDraftAction(draftId: string) {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");

  await approveDraft(new SupabaseDb(supabase), {
    organizationId: user.organizationId,
    actorId: user.userId,
  }, draftId);

  revalidatePath("/drafts");
  revalidatePath("/tasks");
}

/** ドラフト破棄 */
export async function discardDraftAction(draftId: string) {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");

  await discardDraft(new SupabaseDb(supabase), {
    organizationId: user.organizationId,
    actorId: user.userId,
  }, draftId);

  revalidatePath("/drafts");
}
