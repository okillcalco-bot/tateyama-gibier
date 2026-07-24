import type { Row } from "@/lib/db/port";

/**
 * 調査ギャップ・知識進捗エンジン（里山OS 設計書 9章）。
 *
 * - 分類群 × 季節の組み合わせで、必要サンプル数と取得済み数を比較する
 * - 有限の調査タスクは 0〜100% で達成可能にする
 * - 「生態系理解度」には100%を置かない（未知数として表示する）
 * - 希少種の不足は一般公開の募集にせず restricted タスクにする
 */

export const SEASONS = ["spring", "summer", "autumn", "winter"] as const;
export type Season = (typeof SEASONS)[number];
export const SEASON_LABELS: Record<Season, string> = {
  spring: "春（3-5月）",
  summer: "夏（6-8月）",
  autumn: "秋（9-11月）",
  winter: "冬（12-2月）",
};

export function seasonOf(dateIso: string): Season {
  const month = Number(dateIso.slice(5, 7));
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "autumn";
  return "winter";
}

export interface GapCell {
  taxonGroup: string;
  season: Season;
  required: number;
  observed: number;
  approved: number;
  coverage: number; // 0〜100（%）
  missing: number;
}

export interface GapSummary {
  cells: GapCell[];
  /** 季節カバー率（必要数を満たしたセルの割合） */
  seasonCoverage: number;
  /** レビュー完了率 */
  reviewCompletion: number;
  /** 証拠カバー率（直接証拠のある記録の割合） */
  evidenceCoverage: number;
  totalObserved: number;
}

const DIRECT_EVIDENCE = ["specimen", "stomach", "dna", "photo", "video", "audio"];

/**
 * 観察記録から分類群×季節のギャップを算出する。
 * requiredPerCell は運用で調整する前提の初期値（設計書: 必要サンプル数）。
 */
export function calculateGaps(
  observations: Row[],
  options: { taxonGroups?: string[]; requiredPerCell?: number } = {},
): GapSummary {
  const required = options.requiredPerCell ?? 3;
  const groups =
    options.taxonGroups ??
    [...new Set(observations.map((o) => (o.taxon_group as string) || "未分類"))].sort();

  const cells: GapCell[] = [];
  for (const group of groups) {
    for (const season of SEASONS) {
      const matched = observations.filter(
        (o) =>
          ((o.taxon_group as string) || "未分類") === group &&
          seasonOf(String(o.observed_at ?? "")) === season,
      );
      const approved = matched.filter((o) => o.review_status === "approved").length;
      cells.push({
        taxonGroup: group,
        season,
        required,
        observed: matched.length,
        approved,
        coverage: required > 0 ? Math.min(100, Math.round((matched.length / required) * 100)) : 100,
        missing: Math.max(0, required - matched.length),
      });
    }
  }

  const filled = cells.filter((c) => c.missing === 0).length;
  const reviewed = observations.filter((o) => o.review_status === "approved").length;
  const withEvidence = observations.filter((o) =>
    DIRECT_EVIDENCE.includes((o.evidence_type as string) ?? ""),
  ).length;

  return {
    cells,
    seasonCoverage: cells.length ? Math.round((filled / cells.length) * 100) : 0,
    reviewCompletion: observations.length
      ? Math.round((reviewed / observations.length) * 100)
      : 0,
    evidenceCoverage: observations.length
      ? Math.round((withEvidence / observations.length) * 100)
      : 0,
    totalObserved: observations.length,
  };
}

export interface SuggestedTask {
  title: string;
  taxonGroup: string;
  season: Season;
  priority: number;
  restricted: boolean;
  detail: string;
}

/**
 * ギャップから調査タスク案を作る（ルールベース。AIではない）。
 * 希少種を含む分類群は restricted にして一般公開の募集にしない。
 */
export function suggestTasks(
  summary: GapSummary,
  options: { sensitiveGroups?: string[]; limit?: number } = {},
): SuggestedTask[] {
  const sensitive = new Set(options.sensitiveGroups ?? []);
  return summary.cells
    .filter((cell) => cell.missing > 0)
    .map((cell) => ({
      title: `${cell.taxonGroup}の${SEASON_LABELS[cell.season]}調査（あと${cell.missing}件）`,
      taxonGroup: cell.taxonGroup,
      season: cell.season,
      // 不足が大きいほど優先度を上げる（0〜100）
      priority: Math.min(100, 40 + cell.missing * 15),
      restricted: sensitive.has(cell.taxonGroup),
      detail: `必要${cell.required}件に対し${cell.observed}件。写真または音声の証拠を添えて記録してください。`,
    }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, options.limit ?? 10);
}
