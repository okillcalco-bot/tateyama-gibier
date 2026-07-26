"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getCurrentUser, canApprove } from "@/lib/auth";
import { runAction, type ActionResult } from "@/lib/action-result";
import { blockLink, unblockLink, verifyLink } from "@/domain/hunters/hunter-link-service";
import { sendHunterReply } from "@/domain/hunters/hunter-chat-service";
import {
  disableGroup,
  enableGroupNotify,
  renameGroup,
} from "@/domain/hunters/staff-group-service";
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
 * 捕獲者へLINEで返信する（要望1 / 0024）。
 *
 * webhook の replyToken は失効しているためプッシュ送信を使う。
 * 文面は職員が確認・編集したものだけを送る（AIの下書きをそのまま送らない）。
 * 送信者と送信時刻は line_outbound_messages に必ず残る（複数職員前提）。
 */
export async function sendHunterReplyAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const supabase = await createSupabaseServerClient();
    const user = await getCurrentUser(supabase);
    if (!user) throw new Error("ログインが必要です");

    const linkId = String(formData.get("link_id") ?? "");
    const inReplyToId = String(formData.get("message_id") ?? "").trim();
    const text = String(formData.get("reply_text") ?? "").trim();
    if (!linkId) throw new Error("送信先が指定されていません");
    if (!text) throw new Error("返信の文章を入力してください");

    const channel = resolveLineChannels().find((c) => c.key === "hunter");
    if (!channel) {
      throw new Error("捕獲者チャネルが未設定です（管理者に連絡してください）");
    }

    await sendHunterReply(
      {
        db: new SupabaseDb(supabase),
        ctx: { organizationId: user.organizationId, actorId: user.userId },
        send: async ({ lineUserId, text: body }) =>
          pushMessage(channel.accessToken, lineUserId, [textMessage(body)]),
      },
      { linkId, inReplyToId: inReplyToId || null, body: text },
    );

    revalidatePath("/line");
  });
}

/** スタッフグループへの搬入連絡の通知を開始する */
export async function enableGroupNotifyAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const supabase = await createSupabaseServerClient();
    const user = await getCurrentUser(supabase);
    if (!user) throw new Error("ログインが必要です");
    if (!(await canApprove(supabase))) {
      throw new Error("この操作には承認権限が必要です（管理者に依頼してください）");
    }

    const groupId = String(formData.get("group_id") ?? "");
    if (!groupId) throw new Error("対象が指定されていません");

    await enableGroupNotify(
      new SupabaseDb(supabase),
      { organizationId: user.organizationId, actorId: user.userId },
      groupId,
    );
    revalidatePath("/line");
  });
}

/** 通知を止める（グループ解除） */
export async function disableGroupNotifyAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const supabase = await createSupabaseServerClient();
    const user = await getCurrentUser(supabase);
    if (!user) throw new Error("ログインが必要です");
    if (!(await canApprove(supabase))) {
      throw new Error("この操作には承認権限が必要です（管理者に依頼してください）");
    }

    const groupId = String(formData.get("group_id") ?? "");
    if (!groupId) throw new Error("対象が指定されていません");

    await disableGroup(new SupabaseDb(supabase), {
      groupId,
      ctx: { organizationId: user.organizationId, actorId: user.userId },
    });
    revalidatePath("/line");
  });
}

/** グループに分かりやすい名前を付ける */
export async function renameGroupAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const supabase = await createSupabaseServerClient();
    const user = await getCurrentUser(supabase);
    if (!user) throw new Error("ログインが必要です");

    const groupId = String(formData.get("group_id") ?? "");
    const label = String(formData.get("label") ?? "");
    if (!groupId) throw new Error("対象が指定されていません");

    await renameGroup(
      new SupabaseDb(supabase),
      { organizationId: user.organizationId, actorId: user.userId },
      { groupId, label },
    );
    revalidatePath("/line");
  });
}
