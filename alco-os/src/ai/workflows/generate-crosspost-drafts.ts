import {
  crosspostDraftsInputSchema,
  crosspostDraftsOutputSchema,
  type CrosspostDraftsInput,
  type CrosspostDraftsOutput,
} from "../schemas/crosspost.schema";
import {
  DRAFTS_PROMPT_VERSION,
  buildDraftsSystemPrompt,
  buildDraftsUserPrompt,
} from "../prompts/crosspost.prompt";
import { runWorkflow, type WorkflowContext, type WorkflowResult } from "./run-workflow";

/**
 * 媒体別の下書きを作る（FB横展開 / 媒体を2〜3件ずつのバッチで呼ぶ）。
 *
 * 出力は generated_drafts（draft_type: crosspost_ai_output）に入る**証跡**。
 * ここで作られた文章がそのまま公開されることはない。
 * 人が編集した本文を承認スナップショットとして別途固定する（domain 側）。
 */
export async function generateCrosspostDrafts(
  ctx: WorkflowContext,
  rawInput: CrosspostDraftsInput,
  options: { sourceId?: string } = {},
): Promise<WorkflowResult<CrosspostDraftsOutput>> {
  const input = crosspostDraftsInputSchema.parse(rawInput);
  const requested = input.channels.map((c) => c.channel_key);

  // 頼んでいない媒体が混ざっていたら落とす（勝手に増やさせない）
  const outputSchema = crosspostDraftsOutputSchema.transform((output) => ({
    ...output,
    drafts: output.drafts.filter((draft) => requested.includes(draft.channel_key)),
  }));

  return runWorkflow(ctx, {
    workflow: "generate_crosspost_drafts",
    promptVersion: DRAFTS_PROMPT_VERSION,
    system: buildDraftsSystemPrompt(input.style),
    user: buildDraftsUserPrompt(input),
    outputSchema,
    inputSummary: `FB横展開の下書き生成（${requested.join(" / ")}）`,
    draft: {
      draftType: "crosspost_ai_output",
      sourceTable: "social_sources",
      sourceId: options.sourceId,
      title: `媒体別の下書き（${requested.join(" / ")}）`,
    },
  });
}
