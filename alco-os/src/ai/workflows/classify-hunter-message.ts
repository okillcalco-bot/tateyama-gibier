import {
  hunterMessageInputSchema,
  hunterMessageOutputSchema,
  type HunterMessageInput,
  type HunterMessageOutput,
} from "../schemas/hunter-message.schema";
import {
  HUNTER_MESSAGE_SYSTEM_PROMPT,
  buildHunterMessageUserPrompt,
  PROMPT_VERSION,
} from "../prompts/hunter-message.prompt";
import { detectSensitiveKeywords } from "./parse-field-note";
import { runWorkflow, type WorkflowContext, type WorkflowResult } from "./run-workflow";

/**
 * 捕獲者からのLINEメッセージ分類（docs/09 / docs/10）。
 *
 * ガードレール:
 * - 個体（individuals）・捕獲者台帳（hunters）へは書き込まない。
 *   出力は generated_drafts に入り、承認センターを通るまで業務データにならない
 * - 捕獲場所・罠位置は sensitive 相当。AIが sensitivity_flag=false を返しても
 *   サーバー側のキーワード検知（parse-field-note と共通）で true に上書きする
 * - ai_runs.input_summary に本文・氏名・電話番号を入れない（docs/05）
 */
export async function classifyHunterMessage(
  ctx: WorkflowContext,
  rawInput: HunterMessageInput,
  options: { messageId?: string; today?: string } = {},
): Promise<WorkflowResult<HunterMessageOutput>> {
  const input = hunterMessageInputSchema.parse(rawInput);
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const keywordHits = detectSensitiveKeywords(input.raw_text);
  const forceSensitive = keywordHits.length > 0 || input.has_location;

  // AIが安全側に倒し損ねた場合に備え、保存前に強制的に補正する
  const outputSchema = hunterMessageOutputSchema.transform((output) => {
    if (!forceSensitive) return output;
    const reason = input.has_location
      ? "位置情報が添付されています。捕獲場所・罠位置は非公開（docs/10）"
      : `保全リスク語を検知（${keywordHits.join("・")}）。公開範囲を要確認`;
    return {
      ...output,
      sensitivity_flag: true,
      sensitivity_reason: output.sensitivity_reason || reason,
    };
  });

  return runWorkflow(ctx, {
    workflow: "classify_hunter_message",
    promptVersion: PROMPT_VERSION,
    system: HUNTER_MESSAGE_SYSTEM_PROMPT,
    user: buildHunterMessageUserPrompt({ ...input, today }),
    outputSchema,
    // 個人情報（本文・氏名・電話）は入れない。文字数と位置情報の有無のみ
    inputSummary: `捕獲者LINE分類（本文${input.raw_text.length}字 / 位置情報${
      input.has_location ? "あり" : "なし"
    }）`,
    draft: {
      draftType: "hunter_message_result",
      sourceTable: "line_inbound_messages",
      sourceId: options.messageId,
      title: "捕獲者からの連絡",
    },
  });
}
