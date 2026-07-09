import { describe, it, expect } from "vitest";
import {
  createShiftPattern,
  assignShift,
  removeShift,
  createShiftRequest,
  markShiftRequestReflected,
} from "@/domain/workforce/shift-service";
import { InMemoryDb } from "../helpers/in-memory-db";

const CTX = { organizationId: "org-1", actorId: "user-1" };

describe("shift-service（HRMOS型シフト管理の軸）", () => {
  it("パターン登録は監査ログ付きで保存される", async () => {
    const db = new InMemoryDb();
    const pattern = await createShiftPattern(db, CTX, {
      name: "日勤",
      shortLabel: "日",
      startTime: "08:30",
      endTime: "17:30",
      breakMinutes: 60,
    });
    expect(pattern.name).toBe("日勤");
    expect(await db.findMany("audit_logs", { table_name: "shift_patterns" })).toHaveLength(1);
  });

  it("同一スタッフ・同一日のシフトは上書きされ、二重登録されない", async () => {
    const db = new InMemoryDb();
    await assignShift(db, CTX, { staffId: "staff-1", date: "2026-07-15", shiftType: "日勤" });
    await assignShift(db, CTX, {
      staffId: "staff-1",
      date: "2026-07-15",
      shiftType: "早番",
      startTime: "06:00",
      endTime: "15:00",
    });

    const shifts = await db.findMany("shifts", { staff_id: "staff-1", date: "2026-07-15" });
    expect(shifts).toHaveLength(1);
    expect(shifts[0].shift_type).toBe("早番");
    // 既存ジビエ基幹の shifts には organization_id を書かない（スキーマ変更禁止）
    expect(shifts[0]).not.toHaveProperty("organization_id");
  });

  it("シフト削除は監査ログ（before付き）を残す", async () => {
    const db = new InMemoryDb();
    const shift = await assignShift(db, CTX, {
      staffId: "staff-1",
      date: "2026-07-16",
      shiftType: "日勤",
    });
    await removeShift(db, CTX, shift.id as string);

    expect(await db.findMany("shifts", {})).toHaveLength(0);
    const logs = await db.findMany("audit_logs", { action: "delete" });
    expect(logs).toHaveLength(1);
  });

  it("希望シフトは open で登録され、反映済みにできる", async () => {
    const db = new InMemoryDb();
    const request = await createShiftRequest(db, CTX, {
      staffId: "staff-2",
      workDate: "2026-07-20",
      preference: "ng",
      note: "通院",
    });
    expect(request.status).toBe("open");

    const reflected = await markShiftRequestReflected(db, CTX, request.id as string);
    expect(reflected.status).toBe("reflected");
  });
});
