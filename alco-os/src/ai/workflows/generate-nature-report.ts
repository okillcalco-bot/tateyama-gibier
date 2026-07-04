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
 * プロンプトで禁止し、evidence_refs の検証は evidence-service が行う。
 */
export async function generateNatureReport(
  ctx: WorkflowContext,
  rawInput: NatureReportInput,
  options: { siteId?: string } = {},
): Promise<WorkflowResult<NatureReportOutput>> {
  const input = natureReportInputSchema.parse(rawInput);

  return runWorkflow(ctx, {
    workflow: "generate_nature_report",
    promptVersion: PROMPT_VERSION,
    system: NATURE_REPORT_SYSTEM_PROMPT,
    user: buildNatureReportUserPrompt(input),
    outputSchema: natureReportOutputSchema,
    inputSummary: `自然資本レポート生成: ${input.site_name}`,
    draft: {
      draftType: "nature_report",
      sourceTable: "sites",
      sourceId: options.siteId,
      title: `${input.site_name} レポートドラフト`,
    },
  });
}
