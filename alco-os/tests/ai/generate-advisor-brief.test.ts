import { describe, it, expect } from "vitest";
import { generateAdvisorBrief } from "@/ai/workflows/generate-advisor-brief";
import { approveDraft } from "@/domain/drafts/draft-service";
import { MockProvider } from "@/ai/providers/mock-provider";
import { InMemoryDb } from "../helpers/in-memory-db";

const ORG = "org-1";
const CTX = { organizationId: ORG, actorId: "user-1" };

describe("generate_advisor_brief（士業相談の一次整理）", () => {
  it("生成 → 承認 → advisor_consultations に確定保存される", async () => {
    const db = new InMemoryDb();
    const consultation = await db.insert("advisor_consultations", {
      organization_id: ORG,
      category: "tax",
      title: "解体体験の消費税区分",
      question: "体験料5000円に持ち帰り肉が付く。税区分をどうすべきか。",
      status: "open",
    });

    const result = await generateAdvisorBrief(
      { db, provider: new MockProvider(), organizationId: ORG, userId: "user-1" },
      {
        category: "tax",
        title: consultation.title as string,
        question: consultation.question as string,
      },
      { consultationId: consultation.id as string },
    );
    expect(result.output.questions_for_expert.length).toBeGreaterThan(0);
    expect(result.output.recommended_expert).toBeTruthy();

    const [draft] = await db.findMany("generated_drafts", { status: "draft" });
    expect(draft.draft_type).toBe("advisor_brief");
    await approveDraft(db, CTX, draft.id as string);

    const updated = await db.findById("advisor_consultations", consultation.id as string);
    expect(updated?.status).toBe("approved");
    expect(updated?.approved_content).toBeTruthy();
  });

  it("スキーマ不適合（urgency不正）の出力は保存拒否され失敗が記録される", async () => {
    const db = new InMemoryDb();
    const provider = new MockProvider({
      generate_advisor_brief: JSON.stringify({
        issue_summary: "x",
        general_guidance: "y",
        recommended_expert: "税理士",
        urgency: "超至急", // 不正
      }),
    });
    await expect(
      generateAdvisorBrief({ db, provider, organizationId: ORG, userId: "user-1" }, {
        category: "tax",
        title: "t",
        question: "q",
      }),
    ).rejects.toThrow();
    expect(await db.findMany("generated_drafts", {})).toHaveLength(0);
    expect(await db.findMany("ai_runs", { status: "failed" })).toHaveLength(1);
  });
});
