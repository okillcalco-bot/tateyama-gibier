import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";

/**
 * 捕獲報告の写真と種別（要望3 / 0024）。
 *
 * 市役所提出の台紙に「全体 / 尻尾を切る前 / 切った後」を並べるため、
 * 1件の報告に複数の写真を種別つきで持たせる。
 *
 * 種別は職員が画面で選ぶ（AIに推定させない）。
 * 捕獲者は順番どおりに送れないことが多いので、既定は unsorted（未仕分け）。
 */

export type PhotoKind = "unsorted" | "whole" | "tail_before" | "tail_after" | "other";

export const PHOTO_KIND_LABELS: Record<PhotoKind, string> = {
  unsorted: "未仕分け",
  whole: "全体",
  tail_before: "尻尾を切る前",
  tail_after: "尻尾を切った後",
  other: "その他",
};

/** 台紙に並べる順番 */
export const PHOTO_KIND_ORDER: PhotoKind[] = ["whole", "tail_before", "tail_after", "other"];

export function isPhotoKind(value: unknown): value is PhotoKind {
  return (
    value === "unsorted" ||
    value === "whole" ||
    value === "tail_before" ||
    value === "tail_after" ||
    value === "other"
  );
}

/** 受信した写真を報告に足す（webhookから呼ぶ。種別は未仕分け） */
export async function attachReportPhoto(
  db: DbPort,
  params: {
    organizationId: string;
    captureReportId: string;
    fileId: string;
    photoKind?: PhotoKind;
  },
): Promise<Row | null> {
  const existing = await db.findMany(
    "capture_report_photos",
    { capture_report_id: params.captureReportId, file_id: params.fileId },
    1,
  );
  if (existing[0]) return existing[0];

  const all = await db.findMany(
    "capture_report_photos",
    { capture_report_id: params.captureReportId },
    100,
  );

  return db.insert("capture_report_photos", {
    organization_id: params.organizationId,
    capture_report_id: params.captureReportId,
    file_id: params.fileId,
    photo_kind: params.photoKind ?? "unsorted",
    sort_order: all.length,
  });
}

/** 職員が写真の種別を決める */
export async function setPhotoKind(
  db: DbPort,
  ctx: AuditContext,
  params: { photoId: string; photoKind: PhotoKind },
): Promise<Row> {
  const before = await db.findById("capture_report_photos", params.photoId);
  if (!before) throw new Error("写真が見つかりません");

  const after = await db.update("capture_report_photos", params.photoId, {
    photo_kind: params.photoKind,
  });

  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "capture_report_photos",
    recordId: params.photoId,
    before,
    after,
    note: `写真の種別を「${PHOTO_KIND_LABELS[params.photoKind]}」にした`,
  });

  return after;
}

export interface ReportPhoto {
  id: string;
  fileId: string;
  photoKind: PhotoKind;
  sortOrder: number;
}

export function toReportPhoto(row: Row): ReportPhoto {
  const kind = row.photo_kind;
  return {
    id: String(row.id),
    fileId: String(row.file_id),
    photoKind: isPhotoKind(kind) ? kind : "unsorted",
    sortOrder: typeof row.sort_order === "number" ? row.sort_order : 0,
  };
}

/** 台紙用に並べ替える（全体 → 切る前 → 切った後 → その他。未仕分けは出さない） */
export function orderForCityForm(photos: ReportPhoto[]): ReportPhoto[] {
  return photos
    .filter((photo) => photo.photoKind !== "unsorted")
    .sort((a, b) => {
      const diff =
        PHOTO_KIND_ORDER.indexOf(a.photoKind) - PHOTO_KIND_ORDER.indexOf(b.photoKind);
      return diff !== 0 ? diff : a.sortOrder - b.sortOrder;
    });
}

/**
 * 市役所提出に足りているか。
 * フェーズ3の決定で **必要なのは尻尾切除前・切除後の2枚**（全体写真は不要）。
 * whole は既存データのために種別としては残す（後方互換）。
 */
export const REQUIRED_PHOTO_KINDS: PhotoKind[] = ["tail_before", "tail_after"];

export function missingCityFormPhotos(photos: ReportPhoto[]): PhotoKind[] {
  return REQUIRED_PHOTO_KINDS.filter(
    (kind) => !photos.some((photo) => photo.photoKind === kind),
  );
}
