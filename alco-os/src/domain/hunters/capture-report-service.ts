import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";
import { buildWeightMemo } from "./weight-service";

/**
 * 捕獲報告サービス（改修指示書 2026-07-25）。
 *
 * 流れ:
 *   LINEで「捕獲報告」→ 受け皿(capture_reports)を作る → 写真・位置・本文を足す
 *   → 職員が /gibier/reports で確認 → 承認すると individuals に仮登録を作る
 *
 * 絶対ルール:
 * - AIは ai_suggestion に候補を書くだけ。確定値にしない
 * - individuals への書き込みは approveCaptureReport()（人間の承認）だけ。
 *   webhook・AIからは絶対に呼ばない
 * - 作る個体は既存の捕獲者フォーム（capture-form.html?hunter=）と同じ仮登録形式:
 *   label_id='仮-xxx' / serial_number=null / intake_status='搬入待ち'
 *   （スタッフが capture-form.html?receive= で個体番号を付けると null に戻る既存運用）
 * - 座標は原座標を保存するが、画面表示は必ず geo-masking を通す（docs/10）
 */

export type CaptureReportStatus = "pending" | "accepted" | "rejected";

export const CAPTURE_REPORT_STATUS_LABELS: Record<CaptureReportStatus, string> = {
  pending: "確認まち",
  accepted: "個体に登録ずみ",
  rejected: "取り消し",
};

/** 既存アプリと同じ仮登録の管理番号を作る（'仮-' + 時刻の36進数） */
export function buildTemporaryLabelId(now: Date = new Date()): string {
  return `仮-${now.getTime().toString(36).toUpperCase()}`;
}

export async function openCaptureReport(
  db: DbPort,
  params: {
    organizationId: string;
    hunterLineLinkId: string;
    hunterId: string | null;
    lineChannelId: string;
    lineUserId: string;
  },
): Promise<Row> {
  return db.insert("capture_reports", {
    organization_id: params.organizationId,
    hunter_line_link_id: params.hunterLineLinkId,
    hunter_id: params.hunterId,
    line_channel_id: params.lineChannelId,
    line_user_id: params.lineUserId,
    status: "pending",
  });
}

/** 写真を紐づける（files の行は infra 側で作る） */
export async function attachPhoto(db: DbPort, reportId: string, fileId: string): Promise<Row> {
  return db.update("capture_reports", reportId, { photo_file_id: fileId });
}

/** 位置情報を紐づける。原座標を保存し、表示時に geo-masking を通す */
export async function attachLocation(
  db: DbPort,
  reportId: string,
  lat: number,
  lng: number,
): Promise<Row> {
  return db.update("capture_reports", reportId, { capture_lat: lat, capture_lng: lng });
}

/** 本文とAIの読み取り候補を足す。候補は確定値にしない */
export async function attachDetail(
  db: DbPort,
  reportId: string,
  params: {
    rawText: string;
    aiSuggestion?: Record<string, unknown> | null;
    sourceDraftId?: string | null;
  },
): Promise<Row> {
  const current = await db.findById("capture_reports", reportId);
  const previous = typeof current?.raw_text === "string" ? current.raw_text : "";
  const rawText = previous ? `${previous}\n${params.rawText}` : params.rawText;

  return db.update("capture_reports", reportId, {
    raw_text: rawText,
    ai_suggestion: params.aiSuggestion ?? current?.ai_suggestion ?? null,
    source_draft_id: params.sourceDraftId ?? current?.source_draft_id ?? null,
  });
}

export interface ApproveCaptureReportInput {
  reportId: string;
  /** 職員が確認・修正した確定値。AIの候補をそのまま使わない */
  species: string;
  captureMethod?: string | null;
  captureDate?: string | null;
  hunterName: string;
  memo?: string | null;
  now?: Date;
}

/**
 * 捕獲報告を承認し、individuals に仮登録を作る。
 * **この関数だけが individuals へ書き込む。** 呼び出しは職員の明示操作のみ。
 */
export async function approveCaptureReport(
  db: DbPort,
  ctx: AuditContext,
  input: ApproveCaptureReportInput,
): Promise<{ report: Row; individual: Row }> {
  const report = await db.findById("capture_reports", input.reportId);
  if (!report) throw new Error("捕獲報告が見つかりません");
  if (report.status !== "pending") {
    throw new Error(`この報告はすでに処理ずみです（${report.status}）`);
  }
  if (report.individual_id) {
    throw new Error("この報告はすでに個体に登録されています");
  }
  if (!input.species.trim()) throw new Error("獣種を選んでください");
  if (!input.hunterName.trim()) throw new Error("捕獲者名が必要です");

  const now = input.now ?? new Date();

  // 推定体重であることを memo に残す。既存 cityFormPrint が memo を
  // 「その他特記事項」に印字するため、既存の捕獲票にもそのまま出る
  const weightMemo = buildWeightMemo(
    typeof report.weight_kg === "number" ? report.weight_kg : null,
    typeof report.weight_measure === "string" ? report.weight_measure : null,
  );
  const memo = [input.memo ?? "LINEの捕獲報告から作成", weightMemo]
    .filter(Boolean)
    .join(" / ");

  // 既存アプリ（capture-form.html?hunter=）の仮登録と同じ形で作る
  const individual = await db.insert("individuals", {
    label_id: buildTemporaryLabelId(now),
    serial_number: null,
    intake_status: "搬入待ち",
    species: input.species.trim(),
    capture_method: input.captureMethod ?? null,
    capture_date: input.captureDate ?? now.toISOString().slice(0, 10),
    hunter_name: input.hunterName.trim(),
    capture_lat: report.capture_lat ?? null,
    capture_lng: report.capture_lng ?? null,
    // 体重は値のみ既存カラムへ。計測区分は memo で伝える（既存スキーマを変えない）
    weight_total: typeof report.weight_kg === "number" ? report.weight_kg : null,
    // 捕獲票の様式に必要な項目（職員が /gibier/reports で入力したもの）
    sex: report.sex ?? null,
    is_juvenile: report.is_juvenile ?? null,
    body_length_cm: report.body_length_cm ?? null,
    trap_number: report.trap_number ?? null,
    bait_type: report.bait_type ?? null,
    trap_set_date: report.trap_set_date ?? null,
    finishing_method: report.finishing_method ?? null,
    disposal_method: report.disposal_method ?? null,
    memo,
  });

  const updated = await db.update("capture_reports", input.reportId, {
    status: "accepted",
    individual_id: individual.id,
    species: input.species.trim(),
    capture_method: input.captureMethod ?? report.capture_method ?? null,
    capture_date: input.captureDate ?? report.capture_date ?? null,
    reviewed_by: ctx.actorId,
    reviewed_at: now.toISOString(),
  });

  await writeAuditLog(db, ctx, {
    action: "insert",
    tableName: "individuals",
    recordId: individual.id as string,
    after: individual,
    note: `LINEの捕獲報告を承認して仮登録を作成（capture_reports: ${input.reportId}）`,
  });
  await writeAuditLog(db, ctx, {
    action: "approve",
    tableName: "capture_reports",
    recordId: input.reportId,
    before: report,
    after: updated,
    note: "捕獲報告を承認",
  });

  return { report: updated, individual };
}

/** 取り消し（重複・誤送信など）。individuals には何も作らない */
export async function rejectCaptureReport(
  db: DbPort,
  ctx: AuditContext,
  params: { reportId: string; reason?: string },
): Promise<Row> {
  const report = await db.findById("capture_reports", params.reportId);
  if (!report) throw new Error("捕獲報告が見つかりません");
  if (report.status !== "pending") {
    throw new Error(`この報告はすでに処理ずみです（${report.status}）`);
  }

  const updated = await db.update("capture_reports", params.reportId, {
    status: "rejected",
    note: params.reason ?? report.note ?? null,
    reviewed_by: ctx.actorId,
    reviewed_at: new Date().toISOString(),
  });

  await writeAuditLog(db, ctx, {
    action: "discard",
    tableName: "capture_reports",
    recordId: params.reportId,
    before: report,
    after: updated,
    note: params.reason ? `捕獲報告を取り消し: ${params.reason}` : "捕獲報告を取り消し",
  });

  return updated;
}
