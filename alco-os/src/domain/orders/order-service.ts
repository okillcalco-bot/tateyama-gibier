import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";

/**
 * 受注サービス（タノム型の受注バックオフィス）。
 *
 * orders / order_items は既存ジビエ基幹のテーブル
 * （order-portal.html が顧客側から insert する）。
 * ALCO OS はステータス管理・集計のみ行い、スキーマは変更しない（docs/09）。
 */

/** order-portal.html のバッジ表示と同じ語彙を使う（勝手に増やさない） */
export const ORDER_STATUSES = ["受注", "確認済", "発送済", "納品完了", "キャンセル"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** 旧デフォルト「受付」は「受注」と同義として扱う */
export function normalizeOrderStatus(status: string | null | undefined): string {
  return status === "受付" || !status ? "受注" : status;
}

export async function updateOrderStatus(
  db: DbPort,
  ctx: AuditContext,
  orderId: string,
  status: OrderStatus,
): Promise<Row> {
  if (!ORDER_STATUSES.includes(status)) {
    throw new Error(`不正なステータスです: ${status}`);
  }
  const before = await db.findById("orders", orderId);
  if (!before) throw new Error(`注文が見つかりません: ${orderId}`);

  const after = await db.update("orders", orderId, {
    status,
    updated_at: new Date().toISOString(),
  });
  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "orders",
    recordId: orderId,
    before,
    after,
    note: `受注ステータス変更: ${normalizeOrderStatus(before.status as string)} → ${status}`,
  });
  return after;
}
