import {
  advisorBriefSchema,
  advisorOutputSchema,
  type AdvisorBrief,
  type AdvisorOutput,
} from "../schemas/advisor.schema";
import {
  ADVISOR_SYSTEM_PROMPT,
  buildAdvisorUserPrompt,
  PROMPT_VERSION,
} from "../prompts/advisor.prompt";
import { runWorkflow, type WorkflowContext, type WorkflowResult } from "./run-workflow";

/**
 * 士業相談の一次整理: 論点・一般的な考え方・専門家への質問リストを生成。
 * 出力は法的助言ではなく「専門家に相談する準備」。承認後も社外提出はしない。
 */
export async function generateAdvisorBrief(
  ctx: WorkflowContext,
  rawInput: AdvisorBrief,
  options: { consultationId?: string } = {},
): Promise<WorkflowResult<AdvisorOutput>> {
  const input = advisorBriefSchema.parse(rawInput);

  return runWorkflow(ctx, {
    workflow: "generate_advisor_brief",
    promptVersion: PROMPT_VERSION,
    system: ADVISOR_SYSTEM_PROMPT,
    user: buildAdvisorUserPrompt(input),
    outputSchema: advisorOutputSchema,
    inputSummary: `士業相談の整理: ${input.title}（${input.category}）`,
    draft: {
      draftType: "advisor_brief",
      sourceTable: "advisor_consultations",
      sourceId: options.consultationId,
      title: `${input.title} 相談整理`,
    },
  });
}
