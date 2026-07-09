import type { DbPort, Row } from "@/lib/db/port";
import { writeAuditLog, type AuditContext } from "@/domain/audit/audit-log-service";

/**
 * シフトサービス（HRMOS勤怠のシフト管理を参考にした最小構成）。
 *
 * 予定は既存ジビエ基幹の `shifts` テーブルに書く（organization_id を持たない
 * 既存スキーマのまま使う。スキーマ変更禁止 — docs/09 参照）。
 * パターン・希望は ALCO OS 側の shift_patterns / shift_requests に持つ。
 * 実績は punch.html が書く `attendance` を読み取り専用で参照する。
 */

export interface NewShiftPattern {
  name: string;
  shortLabel?: string;
  startTime: string; // "08:30"
  endTime: string;
  breakMinutes?: number;
  color?: string;
  sortOrder?: number;
}

export async function createShiftPattern(
  db: DbPort,
  ctx: AuditContext,
  input: NewShiftPattern,
): Promise<Row> {
  if (!input.name.trim()) throw new Error("パターン名は必須です");
  if (!input.startTime || !input.endTime) throw new Error("開始・終了時刻は必須です");

  const pattern = await db.insert("shift_patterns", {
    organization_id: ctx.organizationId,
    name: input.name.trim(),
    short_label: input.shortLabel?.trim() || input.name.trim().slice(0, 2),
    start_time: input.startTime,
    end_time: input.endTime,
    break_minutes: input.breakMinutes ?? 60,
    color: input.color || "#3B82F6",
    sort_order: input.sortOrder ?? 0,
    is_active: true,
    created_by: ctx.actorId,
  });
  await writeAuditLog(db, ctx, {
    action: "insert",
    tableName: "shift_patterns",
    recordId: pattern.id as string,
    after: pattern,
  });
  return pattern;
}

export async function setShiftPatternActive(
  db: DbPort,
  ctx: AuditContext,
  patternId: string,
  isActive: boolean,
): Promise<Row> {
  const before = await db.findById("shift_patterns", patternId);
  if (!before) throw new Error(`パターンが見つかりません: ${patternId}`);
  const after = await db.update("shift_patterns", patternId, { is_active: isActive });
  await writeAuditLog(db, ctx, {
    action: "update",
    tableName: "shift_patterns",
    recordId: patternId,
    before,
    after,
  });
  return after;
}

export interface ShiftAssignment {
  staffId: string;
  date: string; // "2026-07-10"
  shiftType: string; // パターン名 or 自由入力
  startTime?: string | null;
  endTime?: string | null;
  note?: string;
}

/**
 * シフト割当。同一スタッフ・同一日は1件に保つ（既存行があれば上書き）。
 * shifts は既存テーブルのため organization_id を付けないことに注意。
 */
export async function assignShift(
  db: DbPort,
  ctx: AuditContext,
  input: ShiftAssignment,
): Promise<Row> {
  if (!input.staffId) throw new Error("スタッフを選択してください");
  if (!input.date) throw new Error("日付は必須です");
  if (!input.shiftType.trim()) throw new Error("シフト種別は必須です");

  const patch = {
    shift_type: input.shiftType.trim(),
    start_time: input.startTime || null,
    end_time: input.endTime || null,
    note: input.note ?? "",
  };

  const existing = await db.findMany("shifts", { staff_id: input.staffId, date: input.date }, 1);
  let shift: Row;
  if (existing.length > 0) {
    shift = await db.update("shifts", existing[0].id as string, patch);
    await writeAuditLog(db, ctx, {
      action: "update",
      tableName: "shifts",
      recordId: shift.id as string,
      before: existing[0],
      after: shift,
    });
  } else {
    shift = await db.insert("shifts", { staff_id: input.staffId, date: input.date, ...patch });
    await writeAuditLog(db, ctx, {
      action: "insert",
      tableName: "shifts",
      recordId: shift.id as string,
      after: shift,
    });
  }
  return shift;
}

/** シフト取消（物理削除。shifts はソフトデリート列を持たない既存スキーマ） */
export async function removeShift(db: DbPort, ctx: AuditContext, shiftId: string): Promise<void> {
  const before = await db.findById("shifts", shiftId);
  if (!before) throw new Error(`シフトが見つかりません: ${shiftId}`);
  await db.delete("shifts", shiftId);
  await writeAuditLog(db, ctx, {
    action: "delete",
    tableName: "shifts",
    recordId: shiftId,
    before,
  });
}

export interface NewShiftRequest {
  staffId: string;
  workDate: string;
  preference: "ok" | "ng" | "partial";
  startTime?: string | null;
  endTime?: string | null;
  note?: string;
}

export async function createShiftRequest(
  db: DbPort,
  ctx: AuditContext,
  input: NewShiftRequest,
): Promise<Row> {
  if (!input.staffId) throw new Error("スタッフを選択してください");
  if (!input.workDate) throw new Error("日付は必須です");

  return db.insert("shift_requests", {
    organization_id: ctx.organizationId,
    staff_id: input.staffId,
    work_date: input.workDate,
    preference: input.preference,
    start_time: input.startTime || null,
    end_time: input.endTime || null,
    note: input.note || null,
    status: "open",
    created_by: ctx.actorId,
  });
}

/** 希望をシフトに反映済みにする（割当そのものは assignShift で行う） */
export async function markShiftRequestReflected(
  db: DbPort,
  ctx: AuditContext,
  requestId: string,
): Promise<Row> {
  const before = await db.findById("shift_requests", requestId);
  if (!before) throw new Error(`希望が見つかりません: ${requestId}`);
  return db.update("shift_requests", requestId, { status: "reflected" });
}
