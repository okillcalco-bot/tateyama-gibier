/**
 * 信頼度モデル（里山OS 設計書 8章）。
 *
 * 単一のAI確率ではなく、要素を分解して保存・表示する（説明可能性）。
 * 表示文言は「現時点の証拠充足度」。100点でも真理を意味しない。
 *
 * 重みは WEIGHTS で一元管理し、変更時は VERSION を上げる
 * （設計書: 算出式はバージョンを保存すること）。
 */

export const CONFIDENCE_VERSION = "confidence-1.0.0";

/** 証拠の直接性: 胃内容物・標本 > 写真・動画 > 痕跡 > 目視 > 聞き取り */
export const EVIDENCE_DIRECTNESS: Record<string, number> = {
  specimen: 100, // 標本
  stomach: 100, // 胃内容物
  dna: 100,
  video: 85,
  photo: 80,
  audio: 70,
  track: 55, // 痕跡（足跡・食痕・糞）
  sighting: 45, // 目視のみ
  hearsay: 20, // 聞き取り
  literature: 60, // 文献（地域適合性で減点される）
};

/** 同定の確実性 */
export const IDENTIFICATION_CERTAINTY: Record<string, number> = {
  dna: 100,
  expert: 90, // 専門家確認
  multiple_photos: 75,
  single_photo: 60,
  ai_only: 35, // AI候補のみ
  unknown: 20,
};

const WEIGHTS = {
  evidenceDirectness: 0.3,
  identificationCertainty: 0.3,
  independentRepeats: 0.15,
  literatureSupport: 0.1,
  localFit: 0.1,
  reviewState: 0.05,
} as const;

export interface ConfidenceInput {
  evidenceType?: string | null;
  identification?: keyof typeof IDENTIFICATION_CERTAINTY | string | null;
  /** 異なる地点・時期・観察者による独立した再現回数 */
  independentRepeats?: number;
  /** 文献の裏付けがあるか */
  hasLiterature?: boolean;
  /** 対象地域・季節への適合（館山・対象個体群に近いか） */
  localFit?: boolean;
  reviewStatus?: "pending" | "approved" | "rejected" | "disputed" | string | null;
}

export interface ConfidenceResult {
  score: number; // 0〜100
  grade: "A" | "B" | "C" | "D" | "E";
  factors: Record<string, number>;
  version: string;
  label: string;
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

export function scoreToGrade(score: number): ConfidenceResult["grade"] {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 50) return "C";
  if (score >= 30) return "D";
  return "E";
}

/** 証拠充足度の算出。要素ごとの点数も返す（UIで根拠として表示する） */
export function evaluateConfidence(input: ConfidenceInput): ConfidenceResult {
  const factors = {
    evidenceDirectness: EVIDENCE_DIRECTNESS[input.evidenceType ?? ""] ?? 30,
    identificationCertainty: IDENTIFICATION_CERTAINTY[input.identification ?? ""] ?? 35,
    // 独立反復は3回で満点（1回=40, 2回=70, 3回以上=100）
    independentRepeats: [0, 40, 70, 100][Math.min(input.independentRepeats ?? 0, 3)],
    literatureSupport: input.hasLiterature ? 100 : 40,
    localFit: input.localFit === false ? 30 : 80,
    reviewState:
      input.reviewStatus === "approved"
        ? 100
        : input.reviewStatus === "disputed"
          ? 20
          : input.reviewStatus === "rejected"
            ? 0
            : 50,
  };

  const score = clamp(
    Math.round(
      Object.entries(WEIGHTS).reduce(
        (sum, [key, weight]) => sum + factors[key as keyof typeof factors] * weight,
        0,
      ),
    ),
  );

  return {
    score,
    grade: scoreToGrade(score),
    factors,
    version: CONFIDENCE_VERSION,
    label: "現時点の証拠充足度",
  };
}

/** 要素名の日本語ラベル（UI表示用） */
export const FACTOR_LABELS: Record<string, string> = {
  evidenceDirectness: "証拠の直接性",
  identificationCertainty: "同定の確実性",
  independentRepeats: "独立反復",
  literatureSupport: "文献整合性",
  localFit: "時空間適合性",
  reviewState: "レビュー状態",
};
