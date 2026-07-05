import { describe, it, expect } from "vitest";
import { createTask, updateTaskStatus } from "@/domain/tasks/task-service";
import { InMemoryDb } from "../helpers/in-memory-db";

const ctx = { organizationId: "org-1", actorId: "user-1" };

describe("task-service", () => {
  it("タスク作成で監査ログが残る", async () => {
    const db = new InMemoryDb();
    const task = await createTask(db, ctx, { title: "見積を依頼する", priority: "high" });

    expect(task.status).toBe("open");
    const audits = await db.findMany("audit_logs", { table_name: "tasks" });
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe("insert");
  });

  it("空タイトルを拒否する", async () => {
    const db = new InMemoryDb();
    await expect(createTask(db, ctx, { title: "   " })).rejects.toThrow("必須");
  });

  it("状態変更で before/after が監査ログに残る", async () => {
    const db = new InMemoryDb();
    const task = await createTask(db, ctx, { title: "テスト" });
    await updateTaskStatus(db, ctx, task.id as string, "done");

    const audits = await db.findMany("audit_logs", { action: "update" });
    expect(audits).toHaveLength(1);
    expect((audits[0].before as { status: string }).status).toBe("open");
    expect((audits[0].after as { status: string }).status).toBe("done");
  });
});
