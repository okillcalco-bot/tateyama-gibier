import { z } from "zod";

/** 音声メモ分類ワークフローの入力 */
export const voiceMemoInputSchema = z.object({
  title: z.string().optional(),
  raw_text: z.string().min(1, "メモ本文は必須です"),
  source_type: z.enum(["voice_transcript", "text_memo", "meeting_note", "field_note"]),
});
export type VoiceMemoInput = z.infer<typeof voiceMemoInputSchema>;

export const memoCategorySchema = z.enum([
  "task",
  "meeting_minutes",
  "grant_material",
  "nature_record",
  "gibier_operation",
  "crm_follow_up",
  "roka_project",
  "idea",
  "personal_reminder",
  "unclear",
]);
export type MemoCategory = z.infer<typeof memoCategorySchema>;

export const suggestedTaskSchema = z.object({
  title: z.string().min(1),
  due_date: z.string().nullable(),        // YYYY-MM-DD or null
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
});

/** 音声メモ分類ワークフローの出力（AIはこの形のJSONを返す） */
export const voiceMemoOutputSchema = z.object({
  summary: z.string(),
  detected_category: memoCategorySchema,
  suggested_tasks: z.array(suggestedTaskSchema).default([]),
  nature_records: z
    .array(z.object({ species_name: z.string(), note: z.string().optional() }))
    .default([]),
  generated_draft: z.string().default(""),
  confidence: z.number().min(0).max(1),
  needs_human_review: z.boolean().default(true),
  warnings: z.array(z.string()).default([]),
});
export type VoiceMemoOutput = z.infer<typeof voiceMemoOutputSchema>;
