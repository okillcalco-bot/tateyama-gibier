import type { DbPort, Row } from "@/lib/db/port";

/**
 * 監査ログサービス。
 * 重要な業務変更（承認・破棄・削除・確定・エクスポート）は必ずここを通す。
 * 監査ログの削除・改変機能は実装しない。
 */

export interface AuditContext {
  organizationId: string;
  actorId: string | null;
}

export type AuditAction = "insert" | "update" | "delete" | "approve" | "discard" | "export";

export async function writeAuditLog(
  db: DbPort,
  ctx: AuditContext,
  params: {
    action: AuditAction;
    tableName: string;
    recordId?: string;
    before?: Row | null;
    after?: Row | null;
    note?: string;
  },
): Promise<void> {
  await db.insert("audit_logs", {
    organization_id: ctx.organizationId,
    actor_id: ctx.actorId,
    action: params.action,
    table_name: params.tableName,
    record_id: params.recordId ?? null,
    before: params.before ?? null,
    after: params.after ?? null,
    note: params.note ?? null,
  });
}
