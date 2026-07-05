import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getProvider } from "@/ai/model-router";
import { classifyVoiceMemo } from "@/ai/workflows/classify-voice-memo";

/**
 * 受信箱の共通取り込み処理。
 * /api/inbox（汎用）と /api/line（LINE Bot）の両方から使う。
 * 外部からのテキストをメモとして保存し、AI分類（→承認待ちドラフト）まで行う。
 * 承認なしにタスク等へ反映しない中核ルールはワークフロー側で担保される。
 */

export interface InboxResult {
  memoId: string;
  classified: boolean;
  category: string | null;
}

export async function ingestInboxText(params: {
  text: string;
  title?: string;
  source: string; // inbox / line / email / shortcut など
}): Promise<InboxResult> {
  if (!env.supabaseServiceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY 未設定");
  }
  const text = params.text.trim().slice(0, 20_000);
  if (!text) throw new Error("text は必須です");

  const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey);
  const { data: org, error: orgError } = await supabase
    .from("organizations")
    .select("id")
    .eq("slug", "alco")
    .single();
  if (orgError || !org) throw new Error("組織が見つかりません");

  const db = new SupabaseDb(supabase);
  const title = (params.title?.trim() || `受信箱（${params.source}）`).slice(0, 120);

  const memo = await db.insert("voice_memos", {
    organization_id: org.id,
    title,
    raw_text: text,
    source_type: "text_memo",
    status: "new",
  });

  // AI分類（失敗しても取り込みは成功。UIの再分類ボタンで救済可能）
  let classified = false;
  let category: string | null = null;
  try {
    const result = await classifyVoiceMemo(
      { db, provider: getProvider(), organizationId: org.id as string, userId: null },
      { title, raw_text: text, source_type: "text_memo" },
      { memoId: memo.id as string },
    );
    await db.update("voice_memos", memo.id as string, { status: "classified" });
    classified = true;
    category = result.output.detected_category;
  } catch {
    // ai_runs に失敗記録済み
  }

  return { memoId: memo.id as string, classified, category };
}
