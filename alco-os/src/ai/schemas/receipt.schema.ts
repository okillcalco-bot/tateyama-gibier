import { z } from "zod";

/** レシート読み取り: 入力（画像はワークフロー側で渡す） */
export const receiptBriefSchema = z.object({
  hint: z.string().default(""), // 「軽トラの燃料」など、撮った人のひとこと
  today: z.string().default(""), // 端末の日付（年が印字されていないレシートの補完に使う）
});
export type ReceiptBrief = z.infer<typeof receiptBriefSchema>;

/**
 * レシート読み取り: 出力。
 * **AIは候補を出すだけ**で、確定は人が画面で行う（docs/00-philosophy）。
 * 読めなかった項目は null にし、勝手に埋めない。
 */
export const receiptOutputSchema = z.object({
  expense_date: z.string().nullable().default(null), // YYYY-MM-DD
  amount: z.number().nullable().default(null), // 税込の支払総額
  vendor: z.string().default(""), // 店名・会社名
  category: z.string().default(""), // 消耗品費 / 旅費交通費 / 燃料費 等
  payment_method: z.string().default(""), // 現金 / クレジット 等
  tax_rate: z.number().nullable().default(null), // 10 / 8 / 0
  tax_amount: z.number().nullable().default(null),
  invoice_number: z.string().default(""), // 適格請求書の登録番号 T+13桁
  items: z
    .array(z.object({ name: z.string(), amount: z.number().nullable().default(null) }))
    .default([]),
  /** 読み取れなかった・自信がない項目（人が必ず確認する） */
  uncertain_fields: z.array(z.string()).default([]),
  note: z.string().default(""),
});
export type ReceiptOutput = z.infer<typeof receiptOutputSchema>;
