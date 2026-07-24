import { z } from "zod";

/** 士業相談: 分野 */
export const ADVISOR_CATEGORIES = {
  tax: "税務・経理",
  labor: "労務・雇用",
  legal: "契約・法務",
  ip: "知財（商標・特許）",
  gov: "行政手続・許認可",
  other: "その他",
} as const;
export type AdvisorCategory = keyof typeof ADVISOR_CATEGORIES;

export const advisorBriefSchema = z.object({
  category: z.enum(["tax", "labor", "legal", "ip", "gov", "other"]),
  title: z.string().min(1),
  question: z.string().min(1), // 状況・困りごと（一次データ）
});
export type AdvisorBrief = z.infer<typeof advisorBriefSchema>;

/**
 * 士業相談の出力。
 * 「答え」ではなく「専門家に相談する準備」を整えることが目的。
 */
export const advisorOutputSchema = z.object({
  issue_summary: z.string(),                          // 論点整理（何が問題か）
  general_guidance: z.string(),                       // 一般的な考え方（一般情報として）
  key_facts_needed: z.array(z.string()).default([]),  // 確認すべき事実
  documents_to_prepare: z.array(z.string()).default([]), // 準備する書類
  questions_for_expert: z.array(z.string()).default([]), // 専門家に聞くべき質問
  recommended_expert: z.string(),                     // 相談先（税理士/社労士/弁護士/弁理士/行政書士など）
  urgency: z.enum(["low", "medium", "high"]).default("medium"), // 急ぎ度
  urgency_reason: z.string().default(""),
  missing_information: z.array(z.string()).default([]),
});
export type AdvisorOutput = z.infer<typeof advisorOutputSchema>;
