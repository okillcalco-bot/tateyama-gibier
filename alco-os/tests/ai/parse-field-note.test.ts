import { describe, it, expect } from "vitest";
import { parseFieldNote, detectSensitiveKeywords } from "@/ai/workflows/parse-field-note";
import { MockProvider } from "@/ai/providers/mock-provider";
import { InMemoryDb } from "../helpers/in-memory-db";

const ORG = "org-1";

describe("parse_field_note（現場メモのAI整理）", () => {
  it("メモを候補に構造化し、ドラフトとして保存する（確定しない）", async () => {
    const db = new InMemoryDb();
    const result = await parseFieldNote(
      { db, provider: new MockProvider(), organizationId: ORG, userId: "user-1" },
      {
        raw_text: "地点A、モウソウチク枯死7割、湿地の北側でアカガエルの卵塊3つ",
        site_name: "南房総里山",
        observed_at: "2026-04-10T09:00:00Z",
        known_taxa: ["ニホンアカガエル"],
      },
    );

    // 種は候補のまま（確定していない）
    expect(result.output.observations[0].species_candidates.length).toBeGreaterThan(1);
    expect(result.output.observations[0].needs_expert_review).toBe(true);

    const drafts = await db.findMany("generated_drafts", { status: "draft" });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].draft_type).toBe("field_note_result");
    // 観察記録そのものはまだ作られない（人が確定する）
    expect(await db.findMany("biodiversity_observations", {})).toHaveLength(0);
  });

  it("保全リスク語をサーバー側でも検知する", () => {
    expect(detectSensitiveKeywords("営巣を確認")).toContain("営巣");
    expect(detectSensitiveKeywords("くくり罠を設置")).toEqual(
      expect.arrayContaining(["罠", "くくり"]),
    );
    expect(detectSensitiveKeywords("カエルの卵塊3つ")).toEqual([]);
  });

  it("AIが sensitivity_flag=false を返しても、危険語があれば true に強制される", async () => {
    const db = new InMemoryDb();
    const provider = new MockProvider({
      parse_field_note: JSON.stringify({
        observations: [],
        resource_notes: [],
        management_notes: [],
        sensitivity_flag: false, // AIは安全と判断したが…
        sensitivity_reason: "",
        missing_information: [],
        summary: "",
      }),
    });

    const result = await parseFieldNote(
      { db, provider, organizationId: ORG, userId: "user-1" },
      { raw_text: "サシバの営巣木を発見。場所は◯◯の私有地", site_name: "", observed_at: "", known_taxa: [] },
    );

    // …サーバー側のキーワード検知で保護側に倒される
    expect(result.output.sensitivity_flag).toBe(true);
    expect(result.output.sensitivity_reason).toContain("営巣");
  });
});
