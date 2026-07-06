import { z } from "zod";

/** メディア共通ブリーフ（プレゼン・動画の入力） */
export const mediaBriefSchema = z.object({
  title: z.string().min(1),
  target_audience: z.string().default(""),
  duration_minutes: z.number().int().positive().default(15),
  format: z.string().default(""),
  key_messages: z.string().default(""),      // 聴講者に思ってもらいたいこと・気づき
  source_material: z.string().default(""),   // まとめたい資料（原文）
  photo_filenames: z.array(z.string()).default([]), // 添付済み写真のファイル名
});
export type MediaBrief = z.infer<typeof mediaBriefSchema>;

/** プレゼン構成の出力 */
export const presentationOutputSchema = z.object({
  title: z.string(),                 // 表紙タイトル
  subtitle: z.string().default(""),
  total_minutes: z.number(),
  slides: z
    .array(
      z.object({
        title: z.string(),
        bullets: z.array(z.string()).default([]),
        speaker_notes: z.string().default(""),  // 話す内容（口語）
        minutes: z.number().default(1),          // このスライドの時間配分
        photo_filename: z.string().nullable().default(null), // 添付写真から割付（実在名のみ）
      }),
    )
    .min(1),
  key_message_recap: z.array(z.string()).default([]), // 締めで押すポイント
  qa_prep: z.array(z.string()).default([]),           // 想定Q&A
  missing_information: z.array(z.string()).default([]),
});
export type PresentationOutput = z.infer<typeof presentationOutputSchema>;

/** YouTube動画プランの出力 */
export const videoPlanOutputSchema = z.object({
  title_candidates: z.array(z.string()).min(1), // タイトル案（クリックされる順）
  description: z.string(),                      // 概要欄（ハッシュタグ含む）
  tags: z.array(z.string()).default([]),
  target_duration_minutes: z.number(),
  script: z
    .array(
      z.object({
        section: z.string(),                    // オープニング / 本編1 / まとめ 等
        narration: z.string(),                  // ナレーション原稿（口語）
        seconds: z.number().default(30),
        visual: z.string().default(""),         // 画面の指示（テロップ・カット割り）
        asset_filename: z.string().nullable().default(null), // 使う素材（実在名のみ）
      }),
    )
    .min(1),
  chapters: z
    .array(z.object({ time: z.string(), label: z.string() }))
    .default([]),                                // 概要欄チャプター（0:00 形式）
  thumbnail_text: z.array(z.string()).default([]), // サムネイル文言案
  cta: z.string().default(""),                     // 行動喚起（チャンネル登録・問合せ等）
  missing_information: z.array(z.string()).default([]),
});
export type VideoPlanOutput = z.infer<typeof videoPlanOutputSchema>;
