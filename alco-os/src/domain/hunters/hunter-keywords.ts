/**
 * リッチメニューのキーワード分岐（改修指示書 2026-07-25）。
 *
 * リッチメニューは2×3の6分割。うち5マスがテキスト送信、1マスが電話（tel: URI）。
 * 電話はLINEアプリが直接発信するため webhook には届かない。
 *
 * AIに頼らず、まず文字列で確実に振り分ける（現場が止まらないことを優先）。
 * 旧実装（「搬入します」等）も後方互換で受ける。
 */

export type HunterMenuIntent =
  | "capture_report" // 捕獲報告
  | "delivery_notice" // 搬入連絡
  | "acceptance_status" // 受入状況
  | "payment_status" // 買取状況
  | "help"; // 使い方

export const HUNTER_MENU_LABELS: Record<HunterMenuIntent, string> = {
  capture_report: "捕獲報告",
  delivery_notice: "搬入連絡",
  acceptance_status: "受入状況",
  payment_status: "買取状況",
  help: "使い方",
};

/** リッチメニューの各マスが送るテキスト（LINE管理画面の設定と一致させること） */
export const RICH_MENU_TEXTS: Record<HunterMenuIntent, string> = {
  capture_report: "捕獲報告",
  delivery_notice: "搬入連絡",
  acceptance_status: "受入状況",
  payment_status: "買取状況",
  help: "使い方",
};

/**
 * 表記ゆれの吸収表。
 * 先頭が新指示書の正式キーワード、以降は後方互換（旧実装・手打ち）。
 */
const KEYWORDS: { intent: HunterMenuIntent; words: string[] }[] = [
  {
    intent: "capture_report",
    words: ["捕獲報告", "捕獲の報告", "捕獲しました", "捕獲報告する", "捕獲"],
  },
  {
    intent: "delivery_notice",
    words: [
      "搬入連絡",
      "搬入します", // 旧実装のキーワード
      "搬入したい",
      "搬入",
      "現場引取を相談します", // 旧実装のキーワード
      "現場引取",
      "引取相談",
    ],
  },
  {
    intent: "acceptance_status",
    words: ["受入状況", "受け入れ状況", "受入状態", "今日受け入れ", "受入できますか"],
  },
  {
    intent: "payment_status",
    words: ["買取状況", "買い取り状況", "買取", "支払状況", "支払い状況", "入金"],
  },
  {
    intent: "help",
    words: ["使い方", "つかいかた", "ヘルプ", "受入方法", "受け入れ方法", "案内"],
  },
];

/** 全角空白・記号・絵文字まわりのゆれを落とす */
export function normalizeKeyword(text: string): string {
  return text
    .trim()
    .replace(/[\s　]/g, "")
    .replace(/[。、．，!！?？:：・…]/g, "")
    .replace(/[【】「」（）()[\]]/g, "");
}

/**
 * テキストからメニュー操作を判定する。
 * 完全一致を優先し、次に「メニュー語で始まる・含む」を見る。
 * どれにも当たらなければ null（= 自由文としてAI分類へ回す）。
 */
export function matchMenuKeyword(text: string): HunterMenuIntent | null {
  const normalized = normalizeKeyword(text);
  if (!normalized) return null;

  for (const { intent, words } of KEYWORDS) {
    if (words.some((word) => normalized === normalizeKeyword(word))) return intent;
  }
  // 「捕獲報告です」「搬入連絡お願いします」のような言い添えを拾う。
  // 短い語（「捕獲」「買取」など）の誤爆を避けるため、2文字語は完全一致のみ。
  for (const { intent, words } of KEYWORDS) {
    if (
      words.some((word) => {
        const w = normalizeKeyword(word);
        return w.length >= 3 && normalized.includes(w);
      })
    ) {
      return intent;
    }
  }
  return null;
}
