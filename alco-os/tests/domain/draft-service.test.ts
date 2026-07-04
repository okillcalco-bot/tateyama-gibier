import { describe, it, expect, beforeEach } from "vitest";
import { approveDraft, discardDraft } from "@/domain/drafts/draft-service";
import { classifyVoiceMemo } from "@/ai/workflows/classify-voice-memo";
import { MockProvider } from "@/ai/providers/mock-provider";
import { InMemoryDb } from "../helpers/in-memory-db";

const ORG = "org-1";
const ctx = { organizationId: ORG, actorId: "user-1" };

describe("ドラフト承認フロー（ALCO OS 中核ルール）", () => {
  let db: InMemoryDb;
  let draftId: string;
  let memoId: string;

  beforeEach(async () => {
    db = new InMemoryDb();
    const memo = await db.insert("voice_memos", {
      organization_id: ORG,
      raw_text: "田中さんに連絡",
      status: "classified",
    });
    memoId = memo.id as string;
    const result = await classifyVoiceMemo(
      { db, provider: new MockProvider(), organizationId: ORG, userId: "user-1" },
      { raw_text: "田中さんに連絡", source_type: "voice_transcript" },
      { memoId },
    );
    draftId = result.draftId;
  });

  it("承認すると提案タスクが tasks に作成され、監査ログが残る", async () => {
    const { createdRecords } = await approveDraft(db, ctx, draftId);

    expect(createdRecords.length).toBeGreaterThan(0);
    const tasks = await db.findMany("tasks", { organization_id: ORG });
    expect(tasks.length).toBe(createdRecords.length);
    expect(tasks[0].source_draft_id).toBe(draftId);
    expect(tasks[0].status).toBe("open");

    // ドラフトが approved になる
    const draft = await db.findById("generated_drafts", draftId);
    expect(draft?.status).toBe("approved");
    expect(draft?.reviewed_by).toBe("user-1");

    // 元メモが processed になる
    const memo = await db.findById("voice_memos", memoId);
    expect(memo?.status).toBe("processed");

    // 監査ログ: タスク作成 + 承認
    const audits = await db.findMany("audit_logs", { organization_id: ORG });
    expect(audits.some((a) => a.action === "approve" && a.record_id === draftId)).toBe(true);
    expect(audits.some((a) => a.action === "insert" && a.table_name === "tasks")).toBe(true);
  });

  it("承認前はタスクが作成されない", async () => {
    const tasks = await db.findMany("tasks", {});
    expect(tasks).toHaveLength(0);
  });

  it("同じドラフトを二重承認できない", async () => {
    await approveDraft(db, ctx, draftId);
    await expect(approveDraft(db, ctx, draftId)).rejects.toThrow("承認できません");
    // タスクが増えていないこと
    const tasks = await db.findMany("tasks", {});
    const first = tasks.length;
    expect(first).toBeGreaterThan(0);
  });

  it("破棄するとタスクは作成されず、監査ログが残る", async () => {
    await discardDraft(db, ctx, draftId);

    const tasks = await db.findMany("tasks", {});
    expect(tasks).toHaveLength(0);

    const draft = await db.findById("generated_drafts", draftId);
    expect(draft?.status).toBe("discarded");

    const audits = await db.findMany("audit_logs", { action: "discard" });
    expect(audits).toHaveLength(1);
  });

  it("破棄済みドラフトは承認できない", async () => {
    await discardDraft(db, ctx, draftId);
    await expect(approveDraft(db, ctx, draftId)).rejects.toThrow();
  });
});
