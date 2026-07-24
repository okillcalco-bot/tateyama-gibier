import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";
import { evaluateConfidence, type ConfidenceInput } from "./confidence";
import { effectiveSensitivity, type Sensitivity } from "./geo-masking";

/**
 * 観察記録サービス（里山OS の中核）。
 *
 * 設計憲章の実装:
 * - AIは候補のみ: ai_suggestion に保持し、確定値（species_name等）は人が入れる
 * - 希少種は自動保護: sensitivity=sensitive なら visibility を restricted に落とす
 * - 証拠と推定の分離: source_type を必ず持たせる
 * - レビュー: pending → approved/rejected/disputed（承認は監査ログに残す）
 */

export const REVIEW_STATUSES = ["pending", "approved", "rejected", "disputed"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const SOURCE_TYPES = ["observed", "ai_suggested", "literature", "expert", "hearsay"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const VISIBILITY_LEVELS = ["public", "members", "restricted"] as const;
export type VisibilityLevel = (typeof VISIBILITY_LEVELS)[number];

export interface NewObservation {
  siteId: string;
  observedAt: string;
  speciesName: string;
  taxonId?: string | null;
  taxonGroup?: string | null;
  count?: number | null;
  lat?: number | null;
  lng?: number | null;
  observer?: string;
  note?: string;
  evidenceType?: string | null;
  sourceType?: SourceType;
  visibilityLevel?: VisibilityLevel;
  /** 種マスタの感度（呼び出し側で taxa から引く）。個別上書きがあれば sensitivityOverride */
  taxonSensitivity?: string | null;
  sensitivityOverride?: string | null;
  photoFileId?: string | null;
  /** AI候補（確定値と分離して保存する） */
  aiSuggestion?: unknown;
  confidence?: ConfidenceInput;
}

/**
 * 希少種の自動保護。
 * sensitive は一般公開できない（設計書 14章・19章）。members 指定でも restricted に落とす。
 */
export function enforceVisibility(
  requested: VisibilityLevel,
  sensitivity: Sensitivity,
): VisibilityLevel {
  if (sensitivity === "sensitive") return "restricted";
  if (sensitivity === "caution" && requested === "public") return "members";
  return requested;
}

export async function createObservation(
  db: DbPort,
  ctx: AuditContext,
  input: NewObservation,
): Promise<Row> {
  if (!input.siteId) throw new Error("対象地を選んでください");
  if (!input.speciesName.trim()) throw new Error("種名（わからなければ「不明」）を入力してください");
  if (!input.observedAt) throw new Error("観察日時を入力してください");

  const sensitivity = effectiveSensitivity(input.sensitivityOverride, input.taxonSensitivity);
  const visibility = enforceVisibility(input.visibilityLevel ?? "members", sensitivity);
  const confidence = evaluateConfidence({
    evidenceType: input.evidenceType,
    ...(input.confidence ?? {}),
    reviewStatus: "pending",
  });

  const observation = await db.insert("biodiversity_observations", {
    organization_id: ctx.organizationId,
    site_id: input.siteId,
    observed_at: input.observedAt,
    species_name: input.speciesName.trim(),
    taxon_id: input.taxonId ?? null,
    taxon_group: input.taxonGroup ?? null,
    count: input.count ?? null,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    observer: input.observer?.trim() || null,
    note: input.note?.trim() || null,
    evidence_type: input.evidenceType ?? null,
    source_type: input.sourceType ?? "observed",
    review_status: "pending",
    visibility_level: visibility,
    sensitivity: input.sensitivityOverride ?? null,
    confidence_score: confidence.score,
    confidence_grade: confidence.grade,
    confidence_factors: { ...confidence.factors, version: confidence.version },
    ai_suggestion: input.aiSuggestion ?? null,
    photo_file_id: input.photoFileId ?? null,
    created_by: ctx.actorId,
  });

  await writeAuditLog(db, ctx, {
    action: "insert",
    tableName: "biodiversity_observations",
    recordId: observation.id as string,
    after: observation,
    note: `観察記録（${input.speciesName}・${visibility}${sensitivity === "sensitive" ? "・希少種保護適用" : ""}）`,
  });
  return observation;
}

/** レビュー（承認・差し戻し・異議）。信頼度はレビュー状態を反映して再計算する */
export async function reviewObservation(
  db: DbPort,
  ctx: AuditContext,
  observationId: string,
  status: ReviewStatus,
  note?: string,
): Promise<Row> {
  if (!REVIEW_STATUSES.includes(status)) throw new Error(`不正なレビュー状態: ${status}`);
  const before = await db.findById("biodiversity_observations", observationId);
  if (!before) throw new Error(`観察記録が見つかりません: ${observationId}`);

  const factors = (before.confidence_factors ?? {}) as Record<string, unknown>;
  const confidence = evaluateConfidence({
    evidenceType: before.evidence_type as string,
    identification: factors.identification as string,
    hasLiterature: factors.literatureSupport === 100,
    reviewStatus: status,
  });

  const after = await db.update("biodiversity_observations", observationId, {
    review_status: status,
    reviewed_by: ctx.actorId,
    reviewed_at: new Date().toISOString(),
    review_note: note?.trim() || null,
    confidence_score: confidence.score,
    confidence_grade: confidence.grade,
    confidence_factors: { ...confidence.factors, version: confidence.version },
  });

  await writeAuditLog(db, ctx, {
    action: status === "approved" ? "approve" : "update",
    tableName: "biodiversity_observations",
    recordId: observationId,
    before,
    after,
    note: `観察レビュー: ${status}${note ? `（${note}）` : ""}`,
  });
  return after;
}

/** 証拠の追加（写真・胃内容物・文献など。削除はしない＝データは資産） */
export async function addEvidence(
  db: DbPort,
  ctx: AuditContext,
  input: {
    relatedTable: "biodiversity_observations" | "ecological_interactions";
    relatedId: string;
    evidenceType: string;
    description?: string;
    citation?: string;
    fileId?: string | null;
    recordedAt?: string | null;
  },
): Promise<Row> {
  if (!input.evidenceType.trim()) throw new Error("証拠の種類を選んでください");
  const evidence = await db.insert("evidence", {
    organization_id: ctx.organizationId,
    related_table: input.relatedTable,
    related_id: input.relatedId,
    evidence_type: input.evidenceType,
    description: input.description?.trim() || null,
    citation: input.citation?.trim() || null,
    file_id: input.fileId ?? null,
    recorded_at: input.recordedAt ?? null,
    created_by: ctx.actorId,
  });
  await writeAuditLog(db, ctx, {
    action: "insert",
    tableName: "evidence",
    recordId: evidence.id as string,
    after: evidence,
  });
  return evidence;
}

/** 種マスタの登録（希少度を持つ） */
export async function createTaxon(
  db: DbPort,
  ctx: AuditContext,
  input: {
    commonName: string;
    scientificName?: string;
    taxonGroup?: string;
    redListStatus?: string;
    sensitivity?: Sensitivity;
  },
): Promise<Row> {
  if (!input.commonName.trim()) throw new Error("和名は必須です");
  const taxon = await db.insert("taxa", {
    organization_id: ctx.organizationId,
    common_name: input.commonName.trim(),
    scientific_name: input.scientificName?.trim() || null,
    taxon_group: input.taxonGroup?.trim() || null,
    red_list_status: input.redListStatus?.trim() || null,
    sensitivity: input.sensitivity ?? "normal",
    created_by: ctx.actorId,
  });
  await writeAuditLog(db, ctx, {
    action: "insert",
    tableName: "taxa",
    recordId: taxon.id as string,
    after: taxon,
  });
  return taxon;
}
