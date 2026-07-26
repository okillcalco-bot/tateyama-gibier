import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";

/**
 * 捕獲者とLINEユーザーの紐付けサービス。
 *
 * 絶対ルール:
 * - 既存 hunters テーブルは読み取りのみ。作成・更新・削除は行わない
 *   （206名の実データ。台帳の正は既存ジビエ基幹システム側）
 * - hunter_id を埋めるのは職員の明示操作のみ。AI・webhook では埋めない
 */

export type HunterLinkStatus = "pending" | "verified" | "blocked";

export const HUNTER_LINK_STATUS_LABELS: Record<HunterLinkStatus, string> = {
  pending: "確認まち",
  verified: "確認ずみ",
  blocked: "受け取らない",
};

export function isHunterLinkStatus(value: unknown): value is HunterLinkStatus {
  return value === "pending" || value === "verified" || value === "blocked";
}

/** チャネル + LINEユーザーIDでリンクを1件引く */
export async function findLinkByLineUser(
  db: DbPort,
  lineChannelId: string,
  lineUserId: string,
): Promise<Row | null> {
  const rows = await db.findMany(
    "hunter_line_links",
    { line_channel_id: lineChannelId, line_user_id: lineUserId },
    1,
  );
  return rows[0] ?? null;
}

/**
 * 未登録ユーザーの受け皿を作る（status = pending）。
 * hunter_id は null のまま。誰なのかの判断は職員が画面で行う。
 */
export async function createPendingLink(
  db: DbPort,
  params: {
    organizationId: string;
    lineChannelId: string;
    lineUserId: string;
    lineDisplayName?: string | null;
  },
): Promise<Row> {
  return db.insert("hunter_line_links", {
    organization_id: params.organizationId,
    hunter_id: null,
    line_channel_id: params.lineChannelId,
    line_user_id: params.lineUserId,
    line_display_name: params.lineDisplayName ?? null,
    status: "pending",
  });
}

/**
 * 職員が捕獲者を確定する（pending → verified）。
 * hunters 側は一切書き換えない。
 */
export async function verifyLink(
  db: DbPort,
  ctx: AuditContext,
  params: { linkId: string; hunterId: string; note?: string },
): Promise<Row> {
  const before = await db.findById("hunter_line_links", params.linkId);
  if (!before) throw new Error("連携が見つかりません");
  if (before.status === "blocked") {
    throw new Error("「受け取らない」に設定されています。先に解除してください");
  }
  if (!params.hunterId) throw new Error("捕獲者を選んでください");

  const after = await db.update("hunter_line_links", params.linkId, {
    hunter_id: params.hunterId,
    status: "verified",
    verified_at: new Date().toISOString(),
    verified_by: ctx.actorId,
    note: params.note ?? before.note ?? null,
  });

  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "hunter_line_links",
    recordId: params.linkId,
    before,
    after,
    note: "LINEと捕獲者を紐付け（確認ずみ）",
  });

  return after;
}

/** 迷惑・誤送信などを受け取らないようにする */
export async function blockLink(
  db: DbPort,
  ctx: AuditContext,
  params: { linkId: string; note?: string },
): Promise<Row> {
  const before = await db.findById("hunter_line_links", params.linkId);
  if (!before) throw new Error("連携が見つかりません");

  const after = await db.update("hunter_line_links", params.linkId, {
    status: "blocked",
    note: params.note ?? before.note ?? null,
  });

  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "hunter_line_links",
    recordId: params.linkId,
    before,
    after,
    note: "LINE連携を「受け取らない」に変更",
  });

  return after;
}

/** ブロック解除（確認まちへ戻す） */
export async function unblockLink(db: DbPort, ctx: AuditContext, linkId: string): Promise<Row> {
  const before = await db.findById("hunter_line_links", linkId);
  if (!before) throw new Error("連携が見つかりません");

  const after = await db.update("hunter_line_links", linkId, {
    status: before.hunter_id ? "verified" : "pending",
  });

  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "hunter_line_links",
    recordId: linkId,
    before,
    after,
    note: "LINE連携のブロックを解除",
  });

  return after;
}
