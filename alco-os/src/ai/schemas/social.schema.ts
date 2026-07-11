import { z } from "zod";

/** 投稿一括更新: 入力（一次データ） */
export const CHANNELS = {
  hp: "ホームページ",
  instagram: "Instagram",
  facebook: "Facebook（会社ページ）",
  youtube: "YouTube",
} as const;
export type ChannelKey = keyof typeof CHANNELS;

export const socialBriefSchema = z.object({
  title: z.string().min(1),
  source_kind: z.string().default("memo"), // memo / facebook / video / audio
  source_text: z.string().min(1),          // 一次データ（文字起こし含む）
  channels: z.array(z.enum(["hp", "instagram", "facebook", "youtube"])).min(1),
});
export type SocialBrief = z.infer<typeof socialBriefSchema>;

/** 投稿一括更新: 出力（チャンネル別原稿。依頼していないチャンネルは null） */
export const socialPostsOutputSchema = z.object({
  hp: z
    .object({
      title: z.string(),
      body: z.string(), // ブログ記事本文（見出し可）
    })
    .nullable()
    .default(null),
  instagram: z
    .object({
      caption: z.string(),
      hashtags: z.array(z.string()).default([]),
    })
    .nullable()
    .default(null),
  facebook: z
    .object({
      post_text: z.string(),
    })
    .nullable()
    .default(null),
  youtube: z
    .object({
      title: z.string(),
      description: z.string(),
      tags: z.array(z.string()).default([]),
    })
    .nullable()
    .default(null),
  missing_information: z.array(z.string()).default([]),
});
export type SocialPostsOutput = z.infer<typeof socialPostsOutputSchema>;
