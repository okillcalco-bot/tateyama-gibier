import {
  receiptBriefSchema,
  receiptOutputSchema,
  type ReceiptBrief,
  type ReceiptOutput,
} from "../schemas/receipt.schema";
import {
  RECEIPT_SYSTEM_PROMPT,
  buildReceiptUserPrompt,
  PROMPT_VERSION,
} from "../prompts/receipt.prompt";
import type { ImageInput } from "../types";
import { runWorkflow, type WorkflowContext, type WorkflowResult } from "./run-workflow";

/**
 * レシート写真 → 経費の候補。
 *
 * ルール（docs/00-philosophy）:
 * - AIは候補を出すだけ。expenses への登録は人が画面で確認してから行う
 * - 読めた項目でも「日付・金額・取引先」が欠けていれば必ず要確認にする
 *   （電帳法の検索要件になる3項目なので、空のまま登録させない）
 */

/** 確定登録の前に人が必ず見るべき項目を、AIの申告に頼らず補う */
export function withRequiredFieldChecks(output: ReceiptOutput): ReceiptOutput {
  const missing: string[] = [];
  if (!output.expense_date) missing.push("expense_date");
  if (output.amount === null || output.amount <= 0) missing.push("amount");
  if (!output.vendor.trim()) missing.push("vendor");
  if (missing.length === 0) return output;
  return {
    ...output,
    uncertain_fields: [...new Set([...output.uncertain_fields, ...missing])],
  };
}

export async function parseReceipt(
  ctx: WorkflowContext,
  rawInput: ReceiptBrief,
  images: ImageInput[],
  options: { fileId?: string } = {},
): Promise<WorkflowResult<ReceiptOutput>> {
  if (images.length === 0) throw new Error("レシートの写真がありません");
  const input = receiptBriefSchema.parse(rawInput);

  const outputSchema = receiptOutputSchema.transform(withRequiredFieldChecks);

  return runWorkflow(ctx, {
    workflow: "parse_receipt",
    promptVersion: PROMPT_VERSION,
    system: RECEIPT_SYSTEM_PROMPT,
    user: buildReceiptUserPrompt(input),
    outputSchema,
    images,
    // 金額・店名はここに書かない（ai_runs は一覧で見えるため要約のみ）
    inputSummary: `レシート読み取り（${input.hint || "メモなし"}）`,
    draft: {
      draftType: "receipt_result",
      sourceTable: "files",
      sourceId: options.fileId,
      title: "レシートの読み取り結果",
    },
  });
}
