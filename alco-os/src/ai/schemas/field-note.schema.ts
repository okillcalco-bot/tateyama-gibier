import { z } from "zod";

/** 現場メモ（音声・文章）の構造化: 入力 */
export const fieldNoteBriefSchema = z.object({
  raw_text: z.string().min(1), // 音声の文字起こし or 手入力メモ
  site_name: z.string().default(""),
  observed_at: z.string().default(""), // ISO（端末の日時）
  known_taxa: z.array(z.string()).default([]), // 種マスタの和名（候補はこの中から優先）
});
export type FieldNoteBrief = z.infer<typeof fieldNoteBriefSchema>;

/**
 * 現場メモの構造化: 出力。
 * AIは「候補」を返すだけで確定しない（設計書 19章 AIガードレール）。
 */
export const fieldNoteOutputSchema = z.object({
  observations: z
    .array(
      z.object({
        species_candidates: z.array(z.string()).default([]), // 確定しない。複数可・不明可
        taxon_group: z.string().default(""),
        count: z.number().nullable().default(null),
        evidence_type: z.string().default(""), // sighting / track / photo / audio / stomach 等
        habitat_note: z.string().default(""),
        raw_phrase: z.string().default(""), // 根拠となった発話部分（説明可能性）
        identification_certainty: z.string().default("ai_only"),
        needs_expert_review: z.boolean().default(true),
      }),
    )
    .default([]),
  resource_notes: z
    .array(
      z.object({
        target: z.string(), // 竹林 / 堅果 / 農作物 等
        metric: z.string(), // 枯死率 / タケノコ本数 / 食痕 等
        value: z.string(),
        raw_phrase: z.string().default(""),
      }),
    )
    .default([]),
  management_notes: z.array(z.string()).default([]), // 草刈り・整備など人間活動
  /** 希少種・営巣地・罠位置など、公開すると保全リスクがある内容を含むか */
  sensitivity_flag: z.boolean().default(false),
  sensitivity_reason: z.string().default(""),
  missing_information: z.array(z.string()).default([]),
  summary: z.string().default(""),
});
export type FieldNoteOutput = z.infer<typeof fieldNoteOutputSchema>;
