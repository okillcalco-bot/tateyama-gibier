import {
  natureReportInputSchema,
  natureReportOutputSchema,
  type NatureReportInput,
  type NatureReportOutput,
} from "../schemas/nature.schema";
import {
  NATURE_REPORT_SYSTEM_PROMPT,
  buildNatureReportUserPrompt,
  PROMPT_VERSION,
} from "../prompts/nature-report.prompt";
import { runWorkflow, type WorkflowContext, type WorkflowResult } from "./run-workflow";

/**
 * 自然資本レポートドラフト生成。
 * 入力はDBの実データ（観察記録・管理作業）のみ。AIによる観察の創作は
 * プロンプトで禁止し、さらに evidence_refs が入力に実在するIDのみで
 * 構成されているかをスキーマ検証で強制する。
 * 捏造IDを含む出力はドラフト保存自体が拒否され、ai_runs に failed が残る。
 */
export async function generateNatureReport(
  ctx: WorkflowContext,
  rawInput: NatureReportInput,
  options: { siteId?: string } = {},
): Promise<WorkflowResult<NatureReportOutput>> {
  const input = natureReportInputSchema.parse(rawInput);

  const knownEvidenceIds = new Set([
    ...input.observations.map((o) => o.id),
    ...input.management_actions.map((m) => m.id),
  ]);
  const outputSchema = natureReportOutputSchema.superRefine((output, ctx2) => {
    const unknown = output.evidence_refs.filter((ref) => !knownEvidenceIds.has(ref));
    if (unknown.length > 0) {
      ctx2.addIssue({
        code: "custom",
        path: ["evidence_refs"],
        message: `入力に存在しない証跡ID（捏造の可能性）: ${unknown.join(", ")}`,
      });
    }
  });

  return runWorkflow(ctx, {
    workflow: "generate_nature_report",
    promptVersion: PROMPT_VERSION,
    system: NATURE_REPORT_SYSTEM_PROMPT,
    user: buildNatureReportUserPrompt(input),
    outputSchema,
    inputSummary: `自然資本レポート生成: ${input.site_name}`,
    draft: {
      draftType: "nature_report",
      sourceTable: "sites",
      sourceId: options.siteId,
      title: `${input.site_name} レポートドラフト`,
    },
  });
}
