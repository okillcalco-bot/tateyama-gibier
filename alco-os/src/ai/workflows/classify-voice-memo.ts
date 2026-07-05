import {
  voiceMemoInputSchema,
  voiceMemoOutputSchema,
  type VoiceMemoInput,
  type VoiceMemoOutput,
} from "../schemas/voice-memo.schema";
import {
  VOICE_MEMO_SYSTEM_PROMPT,
  buildVoiceMemoUserPrompt,
  PROMPT_VERSION,
} from "../prompts/voice-memo.prompt";
import { runWorkflow, type WorkflowContext, type WorkflowResult } from "./run-workflow";

/**
 * 音声メモ分類ワークフロー。
 * 元メモ（voice_memos）は変更せず、分類結果を generated_drafts に保存する。
 * タスク等への反映は人間承認後に draft-service が行う。
 */
export async function classifyVoiceMemo(
  ctx: WorkflowContext,
  rawInput: VoiceMemoInput,
  options: { memoId?: string; today?: string } = {},
): Promise<WorkflowResult<VoiceMemoOutput>> {
  const input = voiceMemoInputSchema.parse(rawInput);
  const today = options.today ?? new Date().toISOString().slice(0, 10);

  return runWorkflow(ctx, {
    workflow: "classify_voice_memo",
    promptVersion: PROMPT_VERSION,
    system: VOICE_MEMO_SYSTEM_PROMPT,
    user: buildVoiceMemoUserPrompt({ ...input, today }),
    outputSchema: voiceMemoOutputSchema,
    inputSummary: `メモ分類: ${input.title ?? input.raw_text.slice(0, 40)}`,
    draft: {
      draftType: "voice_memo_result",
      sourceTable: "voice_memos",
      sourceId: options.memoId,
      title: input.title ?? "音声メモ分類結果",
    },
  });
}
