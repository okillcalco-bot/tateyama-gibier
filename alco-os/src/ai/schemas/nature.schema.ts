import { z } from "zod";

/** 自然資本レポート生成の入力（DBの実データのみを渡す） */
export const natureReportInputSchema = z.object({
  site_name: z.string().min(1),
  site_description: z.string().default(""),
  client_purpose: z.string().default(""),   // 提出先・目的（自然共生サイト申請 / 企業提案 等）
  observations: z
    .array(
      z.object({
        id: z.string(),                     // 証跡ID（biodiversity_observations.id）
        observed_at: z.string(),
        species_name: z.string(),
        taxon_group: z.string().nullable(),
        note: z.string().nullable(),
      }),
    )
    .default([]),
  management_actions: z
    .array(
      z.object({
        id: z.string(),
        action_date: z.string(),
        action_type: z.string(),
        description: z.string().nullable(),
      }),
    )
    .default([]),
});
export type NatureReportInput = z.infer<typeof natureReportInputSchema>;

/**
 * 自然資本レポート出力。
 * ルール:
 * - AIは観察記録を創作しない。入力に含まれる観察のみ言及できる
 * - evidence_refs には入力の証跡IDのみを入れる
 * - 証跡不足は missing_evidence に明記する
 */
export const natureReportOutputSchema = z.object({
  summary: z.string(),
  ecological_value: z.string(),
  current_issues: z.string(),
  management_summary: z.string(),
  evidence_refs: z.array(z.string()).default([]),
  missing_evidence: z.array(z.string()).default([]),
  draft_proposal_text: z.string(),
});
export type NatureReportOutput = z.infer<typeof natureReportOutputSchema>;
