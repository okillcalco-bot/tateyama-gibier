import { describe, it, expect } from "vitest";
import { classifyVoiceMemo } from "@/ai/workflows/classify-voice-memo";
import { MockProvider } from "@/ai/providers/mock-provider";
import type { AiProvider } from "@/ai/types";
import { InMemoryDb } from "../helpers/in-memory-db";

const ORG = "org-1";
const USER = "user-1";

function makeContext(db: InMemoryDb, provider: AiProvider = new MockProvider()) {
  return { db, provider, organizationId: ORG, userId: USER };
}

describe("classifyVoiceMemo ワークフロー", () => {
  it("AI実行が ai_runs に記録され、結果が generated_drafts に draft として保存される", async () => {
    const db = new InMemoryDb();
    const result = await classifyVoiceMemo(
      makeContext(db),
      { raw_text: "田中さんに金曜までに連絡", source_type: "voice_transcript" },
      { memoId: "memo-1", today: "2026-07-04" },
    );

    // ai_runs 記録
    const runs = await db.findMany("ai_runs", { organization_id: ORG });
    expect(runs).toHaveLength(1);
    expect(runs[0].workflow).toBe("classify_voice_memo");
    expect(runs[0].status).toBe("succeeded");
    expect(runs[0].provider).toBe("mock");

    // ドラフト保存（承認前は必ず draft 止まり）
    const drafts = await db.findMany("generated_drafts", { organization_id: ORG });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].status).toBe("draft");
    expect(drafts[0].needs_human_review).toBe(true);
    expect(drafts[0].source_table).toBe("voice_memos");
    expect(drafts[0].source_id).toBe("memo-1");

    // 業務テーブル（tasks）にはまだ何も入らない
    const tasks = await db.findMany("tasks", {});
    expect(tasks).toHaveLength(0);

    expect(result.output.detected_category).toBe("task");
    expect(result.output.suggested_tasks.length).toBeGreaterThan(0);
  });

  it("AI出力がスキーマ不一致なら失敗を ai_runs に記録して例外を投げる", async () => {
    const db = new InMemoryDb();
    const broken = new MockProvider({
      classify_voice_memo: JSON.stringify({ summary: "カテゴリ欠落" }),
    });

    await expect(
      classifyVoiceMemo(makeContext(db, broken), {
        raw_text: "テスト",
        source_type: "text_memo",
      }),
    ).rejects.toThrow();

    const runs = await db.findMany("ai_runs", { status: "failed" });
    expect(runs).toHaveLength(1);
    expect(String(runs[0].error)).toContain("バリデーション");

    // 失敗時はドラフトを作らない
    const drafts = await db.findMany("generated_drafts", {});
    expect(drafts).toHaveLength(0);
  });

  it("プロバイダ障害時も ai_runs に failed を記録する", async () => {
    const db = new InMemoryDb();
    const failing = {
      name: "failing",
      complete: async () => {
        throw new Error("API接続エラー");
      },
    };

    await expect(
      classifyVoiceMemo(makeContext(db, failing), {
        raw_text: "テスト",
        source_type: "text_memo",
      }),
    ).rejects.toThrow("API接続エラー");

    const runs = await db.findMany("ai_runs", { status: "failed" });
    expect(runs).toHaveLength(1);
  });
});
