import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";

/** タスクサービス。タスクの作成・状態変更はここを通す。 */

export interface NewTask {
  title: string;
  description?: string;
  priority?: "low" | "normal" | "high" | "urgent";
  dueDate?: string | null;
  assigneeId?: string | null;
  module?: string;
  relatedTable?: string;
  relatedId?: string;
  sourceDraftId?: string;
}

export async function createTask(db: DbPort, ctx: AuditContext, input: NewTask): Promise<Row> {
  if (!input.title.trim()) {
    throw new Error("タスクのタイトルは必須です");
  }
  const task = await db.insert("tasks", {
    organization_id: ctx.organizationId,
    title: input.title.trim(),
    description: input.description ?? null,
    status: "open",
    priority: input.priority ?? "normal",
    due_date: input.dueDate ?? null,
    assignee_id: input.assigneeId ?? null,
    module: input.module ?? null,
    related_table: input.relatedTable ?? null,
    related_id: input.relatedId ?? null,
    source_draft_id: input.sourceDraftId ?? null,
    created_by: ctx.actorId,
  });

  await writeAuditLog(db, ctx, {
    action: "insert",
    tableName: "tasks",
    recordId: task.id as string,
    after: task,
  });

  return task;
}

export async function updateTaskStatus(
  db: DbPort,
  ctx: AuditContext,
  taskId: string,
  status: "open" | "in_progress" | "done" | "cancelled",
): Promise<Row> {
  const before = await db.findById("tasks", taskId);
  if (!before) throw new Error(`タスクが見つかりません: ${taskId}`);

  const after = await db.update("tasks", taskId, { status, updated_by: ctx.actorId });
  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "tasks",
    recordId: taskId,
    before,
    after,
  });
  return after;
}
