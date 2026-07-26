import type { DbPort, Row } from "@/lib/db/port";

/**
 * LINEの会話状態。
 * 「捕獲報告」を押したあと、続けて送られる写真・本文を報告の続きとして受け取る。
 * 期限（既定24時間）を過ぎたら通常のメッセージとして扱う。
 */

export type ConversationState =
  | "idle"
  | "awaiting_capture_photo"
  | "awaiting_capture_detail"
  /** 定型文（型）の記入まち。不足項目だけをまとめて聞いている */
  | "awaiting_capture_form"
  /** 体重の計測区分（センター / 処理施設 / 推定）を聞いている */
  | "awaiting_weight_kind"
  /** 体重の数値を聞いている */
  | "awaiting_weight_value";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface ActiveConversation {
  state: ConversationState;
  captureReportId: string | null;
}

export async function getConversation(
  db: DbPort,
  lineChannelId: string,
  lineUserId: string,
  now: Date = new Date(),
): Promise<ActiveConversation> {
  const rows = await db.findMany(
    "line_conversation_states",
    { line_channel_id: lineChannelId, line_user_id: lineUserId },
    1,
  );
  const row = rows[0];
  if (!row) return { state: "idle", captureReportId: null };

  const expiresAt = typeof row.expires_at === "string" ? Date.parse(row.expires_at) : NaN;
  if (!Number.isNaN(expiresAt) && expiresAt < now.getTime()) {
    return { state: "idle", captureReportId: null };
  }
  return {
    state: (row.state as ConversationState) ?? "idle",
    captureReportId: typeof row.capture_report_id === "string" ? row.capture_report_id : null,
  };
}

export async function setConversation(
  db: DbPort,
  params: {
    organizationId: string;
    lineChannelId: string;
    lineUserId: string;
    state: ConversationState;
    captureReportId?: string | null;
    ttlMs?: number;
    now?: Date;
  },
): Promise<Row> {
  const now = params.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (params.ttlMs ?? DEFAULT_TTL_MS)).toISOString();
  const patch = {
    state: params.state,
    capture_report_id: params.captureReportId ?? null,
    expires_at: params.state === "idle" ? null : expiresAt,
  };

  const rows = await db.findMany(
    "line_conversation_states",
    { line_channel_id: params.lineChannelId, line_user_id: params.lineUserId },
    1,
  );
  if (rows[0]) {
    return db.update("line_conversation_states", rows[0].id as string, patch);
  }
  return db.insert("line_conversation_states", {
    organization_id: params.organizationId,
    line_channel_id: params.lineChannelId,
    line_user_id: params.lineUserId,
    ...patch,
  });
}

export async function clearConversation(
  db: DbPort,
  params: { organizationId: string; lineChannelId: string; lineUserId: string },
): Promise<void> {
  await setConversation(db, { ...params, state: "idle", captureReportId: null });
}
