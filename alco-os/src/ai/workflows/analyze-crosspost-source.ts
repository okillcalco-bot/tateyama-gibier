import {
  factSheetInputSchema,
  factSheetOutputSchema,
  type FactSheetInput,
  type FactSheetOutput,
} from "../schemas/crosspost.schema";
import {
  FACT_SHEET_SYSTEM_PROMPT,
  FACT_SHEET_PROMPT_VERSION,
  buildFactSheetUserPrompt,
} from "../prompts/crosspost.prompt";
import { runWorkflow, type WorkflowContext, type WorkflowResult } from "./run-workflow";

/**
 * 元原稿から事実を取り出す（FB横展開 / 1回だけ実行）。
 * ここで固定した事実を全媒体で共有するため、媒体間で数値がぶれない。
 */
export async function analyzeCrosspostSource(
  ctx: WorkflowContext,
  rawInput: FactSheetInput,
  options: { sourceId?: string } = {},
): Promise<WorkflowResult<FactSheetOutput>> {
  const input = factSheetInputSchema.parse(rawInput);

  return runWorkflow(ctx, {
    workflow: "analyze_crosspost_source",
    promptVersion: FACT_SHEET_PROMPT_VERSION,
    system: FACT_SHEET_SYSTEM_PROMPT,
    user: buildFactSheetUserPrompt(input),
    outputSchema: factSheetOutputSchema,
    // 個人情報を含む原文は入れない（docs/05）
    inputSummary: `FB横展開の事実整理（本文${input.body.length}字）`,
    draft: {
      draftType: "crosspost_fact_sheet",
      sourceTable: "social_sources",
      sourceId: options.sourceId,
      title: input.title ?? "元投稿の事実整理",
    },
  });
}
