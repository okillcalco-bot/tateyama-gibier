"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getCurrentUser } from "@/lib/auth";
import {
  createShiftPattern,
  setShiftPatternActive,
  assignShift,
  removeShift,
  createShiftRequest,
  markShiftRequestReflected,
} from "@/domain/workforce/shift-service";
import { runAction, type ActionResult } from "@/lib/action-result";

async function requireCtx() {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");
  const db = new SupabaseDb(supabase);
  return { db, ctx: { organizationId: user.organizationId, actorId: user.userId } };
}

export async function createShiftPatternAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    await createShiftPattern(db, ctx, {
      name: String(formData.get("name") ?? ""),
      shortLabel: String(formData.get("short_label") ?? ""),
      startTime: String(formData.get("start_time") ?? ""),
      endTime: String(formData.get("end_time") ?? ""),
      breakMinutes: Number(formData.get("break_minutes")) || 60,
      color: String(formData.get("color") ?? "") || undefined,
    });
    revalidatePath("/hr");
  });
}

export async function toggleShiftPatternAction(
  patternId: string,
  isActive: boolean,
): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    await setShiftPatternActive(db, ctx, patternId, isActive);
    revalidatePath("/hr");
  });
}

export async function assignShiftAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    const extraDates = String(formData.get("extra_dates") ?? "")
      .split(/[,、\s]+/)
      .map((d) => d.trim())
      .filter(Boolean);
    const dates = [String(formData.get("date") ?? "").trim(), ...extraDates].filter(Boolean);
    if (!dates.length) throw new Error("日付を入力してください");
    for (const date of dates) {
      await assignShift(db, ctx, {
        staffId: String(formData.get("staff_id") ?? ""),
        date,
        shiftType: String(formData.get("shift_type") ?? ""),
        startTime: String(formData.get("start_time") ?? "") || null,
        endTime: String(formData.get("end_time") ?? "") || null,
        note: String(formData.get("note") ?? ""),
      });
    }
    revalidatePath("/hr");
  });
}

export async function removeShiftAction(shiftId: string): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    await removeShift(db, ctx, shiftId);
    revalidatePath("/hr");
  });
}

export async function createShiftRequestAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    await createShiftRequest(db, ctx, {
      staffId: String(formData.get("staff_id") ?? ""),
      workDate: String(formData.get("work_date") ?? ""),
      preference: (String(formData.get("preference") ?? "ok") as "ok" | "ng" | "partial") || "ok",
      startTime: String(formData.get("start_time") ?? "") || null,
      endTime: String(formData.get("end_time") ?? "") || null,
      note: String(formData.get("note") ?? ""),
    });
    revalidatePath("/hr");
  });
}

export async function reflectShiftRequestAction(requestId: string): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    await markShiftRequestReflected(db, ctx, requestId);
    revalidatePath("/hr");
  });
}
