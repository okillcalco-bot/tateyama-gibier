import { z } from "zod";

/**
 * 捕獲者からのLINEメッセージ分類（classify_hunter_message）。
 *
 * AIは「何の連絡か」を仕分けし、職員向けの下書きを作るだけ。
 * 個体（individuals）・捕獲者台帳（hunters）へは一切書き込まない。
 * 反映は generated_drafts → 人間承認 → draft-service のみ。
 */

export const hunterMessageInputSchema = z.object({
  /** 受信本文 */
  raw_text: z.string().min(1, "本文は必須です"),
  /** 照合済み捕獲者名（未照合なら undefined）。個人情報のため要約には入れない */
  hunter_name: z.string().optional(),
  /** 位置情報メッセージを伴うか */
  has_location: z.boolean().default(false),
  /** 判定基準日（YYYY-MM-DD） */
  today: z.string().optional(),
});
export type HunterMessageInput = z.infer<typeof hunterMessageInputSchema>;

/**
 * 連絡の種類（リッチメニューの5項目に対応。改修指示書 2026-07-25）。
 * - capture_report    : 捕獲報告（獲物の報告）
 * - delivery_notice   : 搬入連絡（これから持ち込む）
 * - acceptance_status : 受入状況の問い合わせ
 * - payment_status    : 買取・支払いの問い合わせ
 * - help              : 使い方の質問
 * - other             : 上記以外
 *
 * 後方互換（0021 時点の実装で保存されたドラフト用。新規では使わない）:
 * - pickup_consult / acceptance_info
 */
export const hunterIntentSchema = z.enum([
  "capture_report",
  "delivery_notice",
  "acceptance_status",
  "payment_status",
  "help",
  "other",
  "pickup_consult",
  "acceptance_info",
]);
export type HunterIntent = z.infer<typeof hunterIntentSchema>;

export const HUNTER_INTENT_LABELS: Record<HunterIntent, string> = {
  capture_report: "捕獲報告",
  delivery_notice: "搬入連絡",
  acceptance_status: "受入状況の問い合わせ",
  payment_status: "買取状況の問い合わせ",
  help: "使い方の質問",
  other: "その他",
  // 後方互換（旧実装のドラフト表示用）
  pickup_consult: "現場引取の相談（旧）",
  acceptance_info: "受入方法の問い合わせ（旧）",
};

/** AIが読み取った内容。読み取れなければ null（推測で埋めない） */
export const hunterExtractedSchema = z.object({
  species: z.string().nullable().default(null),        // イノシシ / シカ など（原文どおり）
  capture_method: z.string().nullable().default(null), // くくり罠 / 箱罠 / 銃猟（原文どおり）
  capture_date_text: z.string().nullable().default(null), // 原文の表現のまま（例: きのうの夕方）
  head_count: z.number().int().nullable().default(null),
  desired_datetime_text: z.string().nullable().default(null), // 原文の表現のまま（例: 明日の朝イチ）
  place_text: z.string().nullable().default(null),     // 原文の地名表現。座標には変換しない
  phone_text: z.string().nullable().default(null),
});

export const hunterMessageOutputSchema = z.object({
  summary: z.string(),
  detected_intent: hunterIntentSchema,
  extracted: hunterExtractedSchema.default({
    species: null,
    capture_method: null,
    capture_date_text: null,
    head_count: null,
    desired_datetime_text: null,
    place_text: null,
    phone_text: null,
  }),
  /** 職員が承認したうえで送る返信の下書き（自動送信はしない） */
  suggested_reply: z.string().default(""),
  /** 承認後に作るタスクの候補 */
  suggested_tasks: z
    .array(
      z.object({
        title: z.string().min(1),
        due_date: z.string().nullable().default(null),
        priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
      }),
    )
    .default([]),
  /** 判断に足りない情報（捏造せずここに列挙させる） */
  missing_fields: z.array(z.string()).default([]),
  /** 捕獲場所・罠位置など、公開してはいけない情報を含むか */
  sensitivity_flag: z.boolean().default(false),
  sensitivity_reason: z.string().default(""),
  confidence: z.number().min(0).max(1),
  needs_human_review: z.boolean().default(true),
  warnings: z.array(z.string()).default([]),
});
export type HunterMessageOutput = z.infer<typeof hunterMessageOutputSchema>;
