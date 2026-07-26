"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getCurrentUser, canApprove } from "@/lib/auth";
import { runAction, type ActionResult } from "@/lib/action-result";
import { writeAuditLog } from "@/domain/audit/audit-log-service";
import { blockLink, unblockLink, verifyLink } from "@/domain/hunters/hunter-link-service";
import { resolveLineChannels } from "@/lib/line/channels";
import { pushMessage, textMessage } from "@/lib/line/client";

/**
 * 捕獲者LINEの職員操作。
 *
 * - 紐付け・受け取らない設定は承認権限（owner / manager）が必要
 * - 返信送信はログイン済みスタッフが行える（必ず audit_logs に残す）
 * - AIが自動で送信することはない
 */

/** LINEユーザーを捕獲者に紐付ける（確認ずみにする） */
export async function verifyLinkAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const supabase = await createSupabaseServerClient();
    const user = await getCurrentUser(supabase);
    if (!user) throw new Error("ログインが必要です");
    if (!(await canApprove(supabase))) {
      throw new Error("この操作には承認権限が必要です（管理者に依頼してください）");
    }

    const linkId = String(formData.get("link_id") ?? "");
    const hunterId = String(formData.get("hunter_id") ?? "");
    if (!linkId) throw new Error("対象が指定されていません");
    if (!hunterId) throw new Error("捕獲者を選んでください");

    await verifyLink(
      new SupabaseDb(supabase),
      { organizationId: user.organizationId, actorId: user.userId },
      { linkId, hunterId },
    );
    revalidatePath("/line");
  });
}

/** 迷惑・誤送信などを受け取らないようにする */
export async function blockLinkAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const supabase = await createSupabaseServerClient();
    const user = await getCurrentUser(supabase);
    if (!user) throw new Error("ログインが必要です");
    if (!(await canApprove(supabase))) {
      throw new Error("この操作には承認権限が必要です（管理者に依頼してください）");
    }

    const linkId = String(formData.get("link_id") ?? "");
    if (!linkId) throw new Error("対象が指定されていません");

    await blockLink(
      new SupabaseDb(supabase),
      { organizationId: user.organizationId, actorId: user.userId },
      { linkId },
    );
    revalidatePath("/line");
  });
}

/** 「受け取らない」を解除する */
export async function unblockLinkAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const supabase = await createSupabaseServerClient();
    const user = await getCurrentUser(supabase);
    if (!user) throw new Error("ログインが必要です");
    if (!(await canApprove(supabase))) {
      throw new Error("この操作には承認権限が必要です（管理者に依頼してください）");
    }

    const linkId = String(formData.get("link_id") ?? "");
    if (!linkId) throw new Error("対象が指定されていません");

    await unblockLink(
      new SupabaseDb(supabase),
      { organizationId: user.organizationId, actorId: user.userId },
      linkId,
    );
    revalidatePath("/line");
  });
}

/**
 * 捕獲者へLINEで返信する。
 * webhook の replyToken は既に失効しているためプッシュ送信を使う。
 * 文面は職員が確認・編集したものだけを送る（AIの下書きをそのまま送らない）。
 */
export async function sendHunterReplyAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const supabase = await createSupabaseServerClient();
    const user = await getCurrentUser(supabase);
    if (!user) throw new Error("ログインが必要です");

    const messageId = String(formData.get("message_id") ?? "");
    const text = String(formData.get("reply_text") ?? "").trim();
    if (!messageId) throw new Error("対象のメッセージが指定されていません");
    if (!text) throw new Error("返信の文章を入力してください");

    const db = new SupabaseDb(supabase);
    const message = await db.findById("line_inbound_messages", messageId);
    if (!message) throw new Error("メッセージが見つかりません");

    const channel = resolveLineChannels().find((c) => c.key === "hunter");
    if (!channel) {
      throw new Error("捕獲者チャネルが未設定です（管理者に連絡してください）");
    }

    const result = await pushMessage(channel.accessToken, String(message.line_user_id), [
      textMessage(text),
    ]);
    if (!result.ok) {
      throw new Error(result.error ?? "送信に失敗しました");
    }

    const updated = await db.update("line_inbound_messages", messageId, {
      status: "handled",
      replied_at: new Date().toISOString(),
      replied_by: user.userId,
    });

    await writeAuditLog(
      db,
      { organizationId: user.organizationId, actorId: user.userId },
      {
        action: "update",
        tableName: "line_inbound_messages",
        recordId: messageId,
        after: updated,
        note: `捕獲者へLINEで返信（${text.length}字）`,
      },
    );

    revalidatePath("/line");
  });
}
