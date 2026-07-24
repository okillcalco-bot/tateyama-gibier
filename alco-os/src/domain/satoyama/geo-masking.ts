/**
 * 位置情報マスキング（里山OS 設計書 14章）。
 *
 * 絶対ルール:
 * - 原座標はサーバー側に留め、クライアントへ渡さない
 * - 公開用座標は原座標から都度生成する（公開テーブルへ複製しない）
 * - 希少種・営巣地・罠位置は一般公開で座標を出さない
 *
 * 精度はメッシュ丸め（緯度1度 ≒ 111km）。SQL側の mask_coordinate() と同じ規則。
 */

export const SENSITIVITY = {
  normal: "一般種",
  caution: "要注意種",
  sensitive: "希少種・営巣地（非公開）",
} as const;
export type Sensitivity = keyof typeof SENSITIVITY;

/** 閲覧者の権限段階。restricted は認定調査者・業務権限 */
export type ViewerScope = "public" | "members" | "restricted" | "owner";

/** 感度 × 閲覧権限 → 公開精度（km）。null は座標を出さない */
export function precisionKmFor(sensitivity: Sensitivity, scope: ViewerScope): number | null {
  if (scope === "owner" || scope === "restricted") return 0; // 0 = 原座標
  if (sensitivity === "sensitive") return null; // 非表示（members でも出さない）
  if (sensitivity === "caution") return scope === "members" ? 1 : 5;
  return scope === "members" ? 0.1 : 1;
}

/** メッシュ丸め。precisionKm=0 は原座標をそのまま返す */
export function maskCoordinate(value: number | null, precisionKm: number | null): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  if (precisionKm === null) return null;
  if (precisionKm <= 0) return value;
  const step = precisionKm / 111;
  return Math.round(value / step) * step;
}

export interface MaskedPoint {
  lat: number | null;
  lng: number | null;
  precisionLabel: string;
  hidden: boolean;
}

/** 観察記録の座標を閲覧権限に応じてマスクする。UIへ渡す前に必ず通すこと */
export function maskObservationPoint(
  input: { lat: number | null; lng: number | null; sensitivity: Sensitivity },
  scope: ViewerScope,
): MaskedPoint {
  const precision = precisionKmFor(input.sensitivity, scope);
  if (precision === null) {
    return { lat: null, lng: null, precisionLabel: "非公開（希少種保護）", hidden: true };
  }
  return {
    lat: maskCoordinate(input.lat, precision),
    lng: maskCoordinate(input.lng, precision),
    precisionLabel: precision <= 0 ? "原座標" : `約${precision}kmメッシュ`,
    hidden: false,
  };
}

/** 観察行の実効感度（個別上書き > 種マスタ > normal） */
export function effectiveSensitivity(
  observationSensitivity: string | null | undefined,
  taxonSensitivity: string | null | undefined,
): Sensitivity {
  const value = observationSensitivity || taxonSensitivity || "normal";
  return (["normal", "caution", "sensitive"].includes(value) ? value : "normal") as Sensitivity;
}

/**
 * エクスポート（CSV/GeoJSON）用の行整形。
 * 権限を適用し、原座標を絶対に出力しない（設計書 14章・22章の禁止事項）。
 */
export function toExportRow(
  row: {
    id: string;
    observed_at: string;
    species_name: string;
    taxon_group: string | null;
    count: number | null;
    evidence_type: string | null;
    confidence_grade: string | null;
    lat: number | null;
    lng: number | null;
    sensitivity: Sensitivity;
  },
  scope: ViewerScope,
): Record<string, string | number | null> {
  const point = maskObservationPoint(row, scope);
  return {
    id: row.id,
    observed_at: row.observed_at,
    species_name: row.species_name,
    taxon_group: row.taxon_group,
    count: row.count,
    evidence_type: row.evidence_type,
    confidence_grade: row.confidence_grade,
    lat: point.lat,
    lng: point.lng,
    location_precision: point.precisionLabel,
  };
}
