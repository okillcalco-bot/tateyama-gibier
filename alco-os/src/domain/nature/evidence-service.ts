import type { NatureReportOutput } from "@/ai/schemas/nature.schema";

/**
 * 証跡サービス。
 * AI生成レポートが「実在する証跡IDのみ」を引用していることを検証する。
 * AIの引用捏造（存在しない観察への言及）をシステム側で遮断する最後の砦。
 */

export interface EvidenceCheckResult {
  valid: boolean;
  /** 入力データに存在しない証跡ID（= AIの捏造の可能性） */
  unknownRefs: string[];
  /** レポートが自己申告した不足証跡 */
  missingEvidence: string[];
}

export function checkReportEvidence(
  report: Pick<NatureReportOutput, "evidence_refs" | "missing_evidence">,
  knownEvidenceIds: string[],
): EvidenceCheckResult {
  const known = new Set(knownEvidenceIds);
  const unknownRefs = report.evidence_refs.filter((ref) => !known.has(ref));
  return {
    valid: unknownRefs.length === 0,
    unknownRefs,
    missingEvidence: report.missing_evidence,
  };
}
