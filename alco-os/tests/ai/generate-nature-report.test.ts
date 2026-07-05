import { describe, it, expect } from "vitest";
import { generateNatureReport } from "@/ai/workflows/generate-nature-report";
import { MockProvider } from "@/ai/providers/mock-provider";
import { InMemoryDb } from "../helpers/in-memory-db";

const ORG = "org-1";

const baseInput = {
  site_name: "南房総里山未来拠点",
  site_description: "湿地・雑木林",
  client_purpose: "自然共生サイト認証申請",
  observations: [
    {
      id: "obs-1",
      observed_at: "2026-05-10",
      species_name: "ニホンアカガエル",
      taxon_group: "両生類",
      note: "卵塊3つ",
    },
  ],
  management_actions: [
    { id: "act-1", action_date: "2026-05-20", action_type: "草刈り", description: null },
  ],
};

function makeReport(evidenceRefs: string[]) {
  return JSON.stringify({
    summary: "概況",
    ecological_value: "価値",
    current_issues: "課題",
    management_summary: "管理状況",
    evidence_refs: evidenceRefs,
    missing_evidence: ["冬季の鳥類調査"],
    draft_proposal_text: "提案文",
  });
}

describe("generateNatureReport（証跡の実在チェック強制）", () => {
  it("実在する証跡IDのみ引用した出力はドラフト保存される", async () => {
    const db = new InMemoryDb();
    const provider = new MockProvider({
      generate_nature_report: makeReport(["obs-1", "act-1"]),
    });

    const result = await generateNatureReport(
      { db, provider, organizationId: ORG, userId: "user-1" },
      baseInput,
      { siteId: "site-1" },
    );

    expect(result.output.evidence_refs).toEqual(["obs-1", "act-1"]);
    const drafts = await db.findMany("generated_drafts", { status: "draft" });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].draft_type).toBe("nature_report");
  });

  it("実在しない証跡ID（捏造）を含む出力は保存拒否され、失敗が記録される", async () => {
    const db = new InMemoryDb();
    const provider = new MockProvider({
      generate_nature_report: makeReport(["obs-1", "obs-999"]),
    });

    await expect(
      generateNatureReport({ db, provider, organizationId: ORG, userId: "user-1" }, baseInput),
    ).rejects.toThrow();

    const failed = await db.findMany("ai_runs", { status: "failed" });
    expect(failed).toHaveLength(1);
    expect(String(failed[0].error)).toContain("obs-999");

    const drafts = await db.findMany("generated_drafts", {});
    expect(drafts).toHaveLength(0);
  });

  it("証跡引用なし（missing_evidence の自己申告のみ）でも保存できる", async () => {
    const db = new InMemoryDb();
    const provider = new MockProvider({ generate_nature_report: makeReport([]) });

    const result = await generateNatureReport(
      { db, provider, organizationId: ORG, userId: "user-1" },
      baseInput,
    );
    expect(result.output.missing_evidence).toContain("冬季の鳥類調査");
  });
});
