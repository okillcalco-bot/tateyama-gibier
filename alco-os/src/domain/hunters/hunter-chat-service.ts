import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";

/**
 * 職員 → 捕獲者へのチャット返信（要望1 / 0024）。
 *
 * webhook の replyToken は失効しているため、返信はすべてプッシュ送信になる。
 *
 * ルール:
 * - 送信できるのは「確認ずみ（verified）」または「確認まち（pending）」の相手だけ。
 *   受け取らない設定（blocked）へは送らない
 * - 送信者（sent_by）と送信時刻を必ず残す。複数職員が使う前提
 * - 送信の成否も記録する（届かなかったことが後から分かるように）
 * - AIが書いた文章を自動送信しない。文面は職員が確定したものだけ
 * - DbPort にのみ依存する（送信そのものは呼び出し側から注入する）
 */

export const MAX_REPLY_LENGTH = 1000;

export interface SendReplyInput {
  linkId: string;
  /** 返信対象の受信メッセージ。お知らせだけ送る場合は省略 */
  inReplyToId?: string | null;
  body: string;
  now?: Date;
}

export type SendMessage = (params: {
  lineUserId: string;
  text: string;
}) => Promise<{ ok: boolean; error?: string }>;

export interface HunterChatDeps {
  db: DbPort;
  ctx: AuditContext;
  send: SendMessage;
}

/** スレッド表示用の1行（受信・送信を時系列に混ぜる） */
export interface ThreadEntry {
  id: string;
  direction: "inbound" | "outbound";
  body: string | null;
  at: string;
  /** 送信者の profiles.id（受信は null） */
  actorId: string | null;
  messageType: string | null;
  status: string | null;
}

export async function sendHunterReply(
  deps: HunterChatDeps,
  input: SendReplyInput,
): Promise<Row> {
  const { db, ctx } = deps;
  const body = input.body.trim();
  if (!body) throw new Error("返信の文章を入力してください");
  if (body.length > MAX_REPLY_LENGTH) {
    throw new Error(`長すぎます（${MAX_REPLY_LENGTH}文字まで）`);
  }

  const link = await db.findById("hunter_line_links", input.linkId);
  if (!link) throw new Error("送信先が見つかりません");
  if (link.status === "blocked") {
    throw new Error("「受け取らない」に設定されている相手には送信できません");
  }
  const lineUserId = typeof link.line_user_id === "string" ? link.line_user_id : "";
  if (!lineUserId) throw new Error("送信先のLINEユーザーが分かりません");

  const now = (input.now ?? new Date()).toISOString();
  const result = await deps.send({ lineUserId, text: body });

  const outbound = await db.insert("line_outbound_messages", {
    organization_id: ctx.organizationId,
    hunter_line_link_id: input.linkId,
    line_channel_id: link.line_channel_id,
    line_user_id: lineUserId,
    body,
    in_reply_to_id: input.inReplyToId ?? null,
    status: result.ok ? "sent" : "failed",
    error: result.ok ? null : (result.error ?? "送信に失敗しました"),
    sent_at: now,
    sent_by: ctx.actorId,
  });

  // 失敗も履歴に残したうえで、呼び出し側にエラーを返す
  await writeAuditLog(db, ctx, {
    action: "insert",
    tableName: "line_outbound_messages",
    recordId: outbound.id as string,
    after: outbound,
    note: result.ok
      ? `捕獲者へ返信（${body.length}字）`
      : `捕獲者への返信に失敗（${body.length}字）`,
  });

  if (!result.ok) {
    throw new Error(result.error ?? "送信に失敗しました");
  }

  // 返信対象があれば対応ずみにする（既存の replied_at / replied_by を活用）
  if (input.inReplyToId) {
    const before = await db.findById("line_inbound_messages", input.inReplyToId);
    if (before) {
      const after = await db.update("line_inbound_messages", input.inReplyToId, {
        status: "handled",
        replied_at: now,
        replied_by: ctx.actorId,
      });
      await writeAuditLog(db, ctx, {
        action: "update",
        tableName: "line_inbound_messages",
        recordId: input.inReplyToId,
        before,
        after,
        note: "返信して対応ずみにした",
      });
    }
  }

  return outbound;
}

/** 1人分の会話を時系列で組み立てる（古い順） */
export function buildThread(inbound: Row[], outbound: Row[]): ThreadEntry[] {
  const entries: ThreadEntry[] = [];

  for (const row of inbound) {
    entries.push({
      id: String(row.id),
      direction: "inbound",
      body: typeof row.body === "string" ? row.body : null,
      at: String(row.received_at ?? row.created_at ?? ""),
      actorId: null,
      messageType: typeof row.message_type === "string" ? row.message_type : null,
      status: typeof row.status === "string" ? row.status : null,
    });
  }
  for (const row of outbound) {
    entries.push({
      id: String(row.id),
      direction: "outbound",
      body: typeof row.body === "string" ? row.body : null,
      at: String(row.sent_at ?? row.created_at ?? ""),
      actorId: typeof row.sent_by === "string" ? row.sent_by : null,
      messageType: "text",
      status: typeof row.status === "string" ? row.status : null,
    });
  }

  return entries.sort((a, b) => a.at.localeCompare(b.at));
}
