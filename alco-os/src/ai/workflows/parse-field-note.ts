import {
  fieldNoteBriefSchema,
  fieldNoteOutputSchema,
  type FieldNoteBrief,
  type FieldNoteOutput,
} from "../schemas/field-note.schema";
import {
  FIELD_NOTE_SYSTEM_PROMPT,
  buildFieldNoteUserPrompt,
  PROMPT_VERSION,
} from "../prompts/field-note.prompt";
import { runWorkflow, type WorkflowContext, type WorkflowResult } from "./run-workflow";

/**
 * 現場メモ → 観察記録の候補（里山OS 設計書 13章）。
 *
 * AIガードレール（19章）:
 * - 種名を確定しない。候補が1つでも needs_expert_review を落とさない
 * - 希少種の可能性があれば sensitivity_flag を強制的に true にする
 *   （AIが false を返しても、キーワードに反応してサーバー側で上書きする）
 */

/** 保全リスクを示すキーワード。AI判断に依存せずサーバー側でも検知する */
const SENSITIVE_KEYWORDS = [
  "営巣", "巣", "抱卵", "繁殖地", "産卵",
  "希少", "絶滅", "レッドリスト", "天然記念物",
  "罠", "わな", "くくり", "箱わな", "捕獲地点",
  "私有地", "個人宅",
];

export function detectSensitiveKeywords(text: string): string[] {
  return SENSITIVE_KEYWORDS.filter((word) => text.includes(word));
}

export async function parseFieldNote(
  ctx: WorkflowContext,
  rawInput: FieldNoteBrief,
  options: { siteId?: string } = {},
): Promise<WorkflowResult<FieldNoteOutput>> {
  const input = fieldNoteBriefSchema.parse(rawInput);
  const keywordHits = detectSensitiveKeywords(input.raw_text);

  // AIが安全側に倒し損ねた場合に備え、保存前に強制的に補正する
  const outputSchema = fieldNoteOutputSchema.transform((output) => {
    if (keywordHits.length === 0) return output;
    return {
      ...output,
      sensitivity_flag: true,
      sensitivity_reason:
        output.sensitivity_reason ||
        `保全リスク語を検知（${keywordHits.join("・")}）。公開範囲を要確認`,
    };
  });

  return runWorkflow(ctx, {
    workflow: "parse_field_note",
    promptVersion: PROMPT_VERSION,
    system: FIELD_NOTE_SYSTEM_PROMPT,
    user: buildFieldNoteUserPrompt(input),
    outputSchema,
    inputSummary: `現場メモ構造化（${input.site_name || "地点未指定"}）`,
    draft: {
      draftType: "field_note_result",
      sourceTable: "sites",
      sourceId: options.siteId,
      title: `現場メモの候補（${input.site_name || "地点未指定"}）`,
    },
  });
}
