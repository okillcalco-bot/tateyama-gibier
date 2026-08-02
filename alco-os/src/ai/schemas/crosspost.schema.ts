import { z } from "zod";

/**
 * FB横展開システムのAI入出力（0029 / Phase 1）。
 *
 * 2段階に分ける:
 *   1. analyze_crosspost_source … 元原稿から事実を整理（1回だけ）
 *   2. generate_crosspost_drafts … 事実シートを渡して媒体別の下書き（バッチ）
 *
 * 分けた理由: 8媒体を一度に生成させると出力が長く、失敗したときに全部やり直しになる。
 * 事実の解釈を1回に固定することで、媒体間で数値や事実がぶれるのも防げる。
 */

// ── 1. 事実整理 ──

export const factSheetInputSchema = z.object({
  body: z.string().min(1, "原文は必須です"),
  title: z.string().optional(),
  category: z.string().optional(),
  posted_on: z.string().optional(),
});
export type FactSheetInput = z.infer<typeof factSheetInputSchema>;

export const factSheetOutputSchema = z.object({
  /** 元原稿にある事実（言い換えず、原文の表現を保つ） */
  facts: z.array(z.string()).default([]),
  /** 数値と単位。原文のまま */
  numbers: z.array(z.string()).default([]),
  /** そのまま残したい沖さんの言葉（迷い・違和感・問い） */
  voice_quotes: z.array(z.string()).default([]),
  /** どの媒体でも落としてはいけない事実 */
  must_keep: z.array(z.string()).default([]),
  /** 推測として書かれている部分（断定に変えてはいけない） */
  speculations: z.array(z.string()).default([]),
  /** 原文に出てくる人物・団体（実名の扱いを判断するため） */
  mentioned_people: z.array(z.string()).default([]),
  /** 投稿番号 #連番（見つからなければ null） */
  source_no: z.string().nullable().default(null),
  missing_information: z.array(z.string()).default([]),
});
export type FactSheetOutput = z.infer<typeof factSheetOutputSchema>;

// ── 2. 媒体別の下書き ──

export const channelDraftSchema = z.object({
  channel_key: z.string(),
  title: z.string().nullable().default(null),
  body: z.string(),
  hashtags: z.array(z.string()).default([]),
  link_guidance: z.string().nullable().default(null),
  cta: z.string().nullable().default(null),
  /** 写真の使用順（social_source_assets の並び順のindex） */
  photo_order: z.array(z.number().int()).default([]),
  /** 画像ごとの説明案 */
  photo_captions: z.array(z.string()).default([]),
  /** 動画ナレーション（Reels/Shorts） */
  narration: z.string().nullable().default(null),
  /** 注意事項（要確認の材料になる） */
  cautions: z.array(z.string()).default([]),
  /** 実名を伏せた場合、どこを変えたか */
  anonymized_notes: z.array(z.string()).default([]),
});
export type ChannelDraft = z.infer<typeof channelDraftSchema>;

export const crosspostDraftsInputSchema = z.object({
  body: z.string().min(1),
  fact_sheet: factSheetOutputSchema,
  channels: z
    .array(
      z.object({
        channel_key: z.string(),
        label: z.string(),
        min_chars: z.number().nullable(),
        max_chars: z.number().nullable(),
        max_hashtags: z.number(),
        cta_policy: z.string(),
        guidance: z.string(),
      }),
    )
    .min(1, "媒体を1つ以上指定してください"),
  style: z.object({
    structure_notes: z.string(),
    keep_rules: z.string(),
    avoid_rules: z.string(),
    hard_rules: z.string(),
  }),
  photo_captions: z.array(z.string()).default([]),
});
export type CrosspostDraftsInput = z.infer<typeof crosspostDraftsInputSchema>;

export const crosspostDraftsOutputSchema = z.object({
  drafts: z.array(channelDraftSchema).default([]),
  missing_information: z.array(z.string()).default([]),
  /** AIが気づいた懸念。**判定の最終権限はサーバー側の辞書** */
  sensitive_flags: z.array(z.string()).default([]),
  /** どこを削り、どこを残したか（人が確認するため） */
  style_notes: z.array(z.string()).default([]),
});
export type CrosspostDraftsOutput = z.infer<typeof crosspostDraftsOutputSchema>;
