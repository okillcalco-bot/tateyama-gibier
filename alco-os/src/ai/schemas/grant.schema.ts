import { z } from "zod";

/** 補助金ドラフト生成の入力 */
export const grantDraftInputSchema = z.object({
  grant_name: z.string().min(1),
  raw_requirements: z.string().default(""),
  business_summary: z.string().min(1, "事業概要は必須です"),
  known_facts: z.array(z.string()).default([]),   // 確定している事実のみ渡す
  budget_items: z
    .array(z.object({ category: z.string(), item_name: z.string(), amount: z.number() }))
    .default([]),
});
export type GrantDraftInput = z.infer<typeof grantDraftInputSchema>;

/**
 * 補助金ドラフト生成の出力。
 * ルール: AIは事実・数字・引用を捏造しない。不足情報は missing_information に列挙する。
 */
export const grantDraftOutputSchema = z.object({
  outline: z.array(z.string()),
  draft_text: z.string(),
  missing_information: z.array(z.string()).default([]),
  risk_notes: z.array(z.string()).default([]),
  reviewer_checklist: z.array(z.string()).default([]),
});
export type GrantDraftOutput = z.infer<typeof grantDraftOutputSchema>;
