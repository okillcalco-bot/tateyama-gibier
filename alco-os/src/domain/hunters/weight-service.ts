import type { DbPort, Row } from "@/lib/db/port";
import { normalizeKeyword } from "./hunter-keywords";

/**
 * 体重の3パターン（要望・2026-07-26）。
 *
 *   center    = ジビエセンターで計測
 *   facility  = 処理施設で計測
 *   estimated = どちらにも持ち込まず推定
 *
 * 推定であることは提出書類に必ず明記する（既存 cityFormPrint は
 * individuals.memo を「その他特記事項」に印字するため、承認時に memo へ入れる）。
 */

export type WeightMeasure = "center" | "facility" | "estimated";

export const WEIGHT_MEASURE_LABELS: Record<WeightMeasure, string> = {
  center: "ジビエセンターで計量",
  facility: "処理施設で計量",
  estimated: "推定（だいたいの重さ）",
};

/** 捕獲者に見せる選択肢（1タップで送れる短い文言） */
export const WEIGHT_MEASURE_CHOICES: { measure: WeightMeasure; label: string; text: string }[] = [
  { measure: "center", label: "センターで計量", text: "センターで計量" },
  { measure: "facility", label: "処理施設で計量", text: "処理施設で計量" },
  { measure: "estimated", label: "だいたいの重さ", text: "だいたいの重さ" },
];

export function isWeightMeasure(value: unknown): value is WeightMeasure {
  return value === "center" || value === "facility" || value === "estimated";
}

const MEASURE_WORDS: { measure: WeightMeasure; words: string[] }[] = [
  {
    measure: "center",
    words: ["センターで計量", "センター計量", "センターで測った", "センター", "ジビエセンター"],
  },
  {
    measure: "facility",
    words: ["処理施設で計量", "処理施設計量", "処理施設で測った", "処理施設", "施設で計量"],
  },
  {
    measure: "estimated",
    words: ["だいたいの重さ", "だいたい", "推定", "およそ", "測っていない", "はかっていない"],
  },
];

/**
 * 送られてきた文から計測区分を読む。分からなければ null。
 *
 * 部分一致は2文字語（「推定」など）まで許す。この関数は
 * 「体重をどこで測りましたか」と聞いた直後にしか呼ばれないため、
 * 短い語での誤爆が起きにくい。
 */
export function matchWeightMeasure(text: string): WeightMeasure | null {
  const normalized = normalizeKeyword(text);
  if (!normalized) return null;
  for (const { measure, words } of MEASURE_WORDS) {
    if (words.some((word) => normalized === normalizeKeyword(word))) return measure;
  }
  for (const { measure, words } of MEASURE_WORDS) {
    if (words.some((word) => normalizeKeyword(word).length >= 2 && normalized.includes(normalizeKeyword(word)))) {
      return measure;
    }
  }
  return null;
}

/**
 * 「45」「45kg」「４５キロ」「約45」などから数値を読む。
 * 読めなければ null（推測で埋めない）。
 */
export function parseWeightKg(text: string): number | null {
  const normalized = text
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．]/g, ".");
  const match = normalized.match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0 || value > 500) return null;
  return value;
}

export async function setWeightMeasure(
  db: DbPort,
  reportId: string,
  measure: WeightMeasure,
): Promise<Row> {
  return db.update("capture_reports", reportId, { weight_measure: measure });
}

export async function setWeightValue(db: DbPort, reportId: string, weightKg: number): Promise<Row> {
  return db.update("capture_reports", reportId, { weight_kg: weightKg });
}

/** 提出書類・画面に出す一行。推定なら必ずその旨を書く */
export function describeWeight(
  weightKg: number | null | undefined,
  measure: string | null | undefined,
): string {
  if (weightKg === null || weightKg === undefined) {
    return isWeightMeasure(measure) ? `${WEIGHT_MEASURE_LABELS[measure]}（数値未入力）` : "未入力";
  }
  if (!isWeightMeasure(measure)) return `${weightKg} kg`;
  if (measure === "estimated") return `${weightKg} kg（推定値）`;
  return `${weightKg} kg（${WEIGHT_MEASURE_LABELS[measure]}）`;
}

/**
 * 承認時に individuals.memo へ入れる注記。
 * 既存の捕獲票（cityFormPrint）が memo を「その他特記事項」に印字するため、
 * 推定であることが既存様式にもそのまま出る。
 */
export function buildWeightMemo(
  weightKg: number | null | undefined,
  measure: string | null | undefined,
): string {
  if (!isWeightMeasure(measure)) return "";
  if (measure === "estimated") {
    return weightKg
      ? `体重${weightKg}kgは推定値です（計量していません）`
      : "体重は推定です（計量していません）";
  }
  return `体重は${WEIGHT_MEASURE_LABELS[measure]}`;
}
