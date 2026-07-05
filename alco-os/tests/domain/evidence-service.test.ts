import { describe, it, expect } from "vitest";
import { checkReportEvidence } from "@/domain/nature/evidence-service";

describe("checkReportEvidence（証跡の実在チェック）", () => {
  const known = ["obs-1", "obs-2", "act-1"];

  it("実在する証跡IDのみ引用していれば valid", () => {
    const result = checkReportEvidence(
      { evidence_refs: ["obs-1", "act-1"], missing_evidence: [] },
      known,
    );
    expect(result.valid).toBe(true);
    expect(result.unknownRefs).toEqual([]);
  });

  it("存在しない証跡ID（AIの捏造の可能性）を検出する", () => {
    const result = checkReportEvidence(
      { evidence_refs: ["obs-1", "obs-999"], missing_evidence: [] },
      known,
    );
    expect(result.valid).toBe(false);
    expect(result.unknownRefs).toEqual(["obs-999"]);
  });

  it("不足証跡の自己申告を伝搬する", () => {
    const result = checkReportEvidence(
      { evidence_refs: [], missing_evidence: ["冬季の鳥類調査"] },
      known,
    );
    expect(result.missingEvidence).toEqual(["冬季の鳥類調査"]);
  });
});
