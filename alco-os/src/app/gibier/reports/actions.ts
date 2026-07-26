"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getCurrentUser, canApprove } from "@/lib/auth";
import { runAction, type ActionResult } from "@/lib/action-result";
import { writeAuditLog } from "@/domain/audit/audit-log-service";
import {
  approveCaptureReport,
  rejectCaptureReport,
} from "@/domain/hunters/capture-report-service";
import {
  ACCEPTANCE_NOTE_KEY,
  ACCEPTING_KEY,
} from "@/domain/hunters/gibier-status-service";
import { isPhotoKind, setPhotoKind } from "@/domain/hunters/capture-photo-service";
import { isWeightMeasure } from "@/domain/hunters/weight-service";
import { issueShareLink, revokeShareLink } from "@/domain/hunters/capture-share-service";

/**
 * 捕獲報告の確認（職員）。
 *
 * - 承認・取り消し・受入可否の切り替えは承認権限（owner / manager）が必要
 * - individuals へ書き込むのは approveCaptureReport() だけ。AIからは呼ばれない
 */

async function requireApprover() {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");
  if (!(await canApprove(supabase))) {
    throw new Error("この操作には承認権限が必要です（管理者に依頼してください）");
  }
  return { supabase, user };
}

/** 承認して個体（仮登録）を作る */
export async function approveCaptureReportAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { supabase, user } = await requireApprover();

    const reportId = String(formData.get("report_id") ?? "");
    const species = String(formData.get("species") ?? "").trim();
    const captureMethod = String(formData.get("capture_method") ?? "").trim();
    const captureDate = String(formData.get("capture_date") ?? "").trim();
    const hunterName = String(formData.get("hunter_name") ?? "").trim();
    const memo = String(formData.get("memo") ?? "").trim();

    if (!reportId) throw new Error("対象が指定されていません");
    if (!species) throw new Error("獣種を選んでください");

    // 捕獲票の様式に必要な項目と体重を、承認前に報告へ反映する
    const weightRaw = String(formData.get("weight_kg") ?? "").trim();
    const weightMeasure = String(formData.get("weight_measure") ?? "").trim();
    const formPatch: Record<string, unknown> = {
      sex: String(formData.get("sex") ?? "").trim() || null,
      is_juvenile: String(formData.get("is_juvenile") ?? "") === "幼獣",
      body_length_cm: Number(formData.get("body_length_cm")) || null,
      trap_number: String(formData.get("trap_number") ?? "").trim() || null,
      bait_type: String(formData.get("bait_type") ?? "").trim() || null,
      trap_set_date: String(formData.get("trap_set_date") ?? "").trim() || null,
      finishing_method: String(formData.get("finishing_method") ?? "").trim() || null,
      disposal_method: String(formData.get("disposal_method") ?? "").trim() || null,
    };
    if (weightRaw) formPatch.weight_kg = Number(weightRaw) || null;
    if (isWeightMeasure(weightMeasure)) formPatch.weight_measure = weightMeasure;
    await new SupabaseDb(supabase).update("capture_reports", reportId, formPatch);
    if (!hunterName) {
      throw new Error("捕獲者名がありません。先に「捕獲者LINE」で紐付けてください");
    }

    await approveCaptureReport(
      new SupabaseDb(supabase),
      { organizationId: user.organizationId, actorId: user.userId },
      {
        reportId,
        species,
        captureMethod: captureMethod || null,
        captureDate: captureDate || null,
        hunterName,
        memo: memo || "LINEの捕獲報告から作成",
      },
    );
    revalidatePath("/gibier/reports");
  });
}

/** 取り消し（重複・誤送信など）。個体は作らない */
export async function rejectCaptureReportAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { supabase, user } = await requireApprover();

    const reportId = String(formData.get("report_id") ?? "");
    const reason = String(formData.get("reason") ?? "").trim();
    if (!reportId) throw new Error("対象が指定されていません");

    await rejectCaptureReport(
      new SupabaseDb(supabase),
      { organizationId: user.organizationId, actorId: user.userId },
      { reportId, reason: reason || undefined },
    );
    revalidatePath("/gibier/reports");
  });
}

/** 当日の受入可否を切り替える（捕獲者の「受入状況」への回答になる） */
export async function saveAcceptanceStatusAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { supabase, user } = await requireApprover();

    const accepting = String(formData.get("accepting") ?? "").trim();
    const note = String(formData.get("note") ?? "").trim();
    if (accepting !== "受入可" && accepting !== "受入停止") {
      throw new Error("「受け入れできます」か「受け入れを止める」を選んでください");
    }

    const entries = [
      { key: ACCEPTING_KEY, value: accepting },
      { key: ACCEPTANCE_NOTE_KEY, value: note },
    ];
    const { error } = await supabase.from("org_settings").upsert(entries, { onConflict: "key" });
    if (error) throw new Error(`保存に失敗しました: ${error.message}`);

    await writeAuditLog(
      new SupabaseDb(supabase),
      { organizationId: user.organizationId, actorId: user.userId },
      {
        action: "update",
        tableName: "org_settings",
        after: { accepting, note },
        note: `本日の受入可否を「${accepting}」に変更`,
      },
    );
    revalidatePath("/gibier/reports");
  });
}

/** 写真の種別（全体 / 尻尾を切る前 / 切った後 など）を職員が決める */
export async function setPhotoKindAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const supabase = await createSupabaseServerClient();
    const user = await getCurrentUser(supabase);
    if (!user) throw new Error("ログインが必要です");

    const photoId = String(formData.get("photo_id") ?? "");
    const photoKind = String(formData.get("photo_kind") ?? "");
    if (!photoId) throw new Error("対象の写真が指定されていません");
    if (!isPhotoKind(photoKind)) throw new Error("写真の種類を選んでください");

    await setPhotoKind(
      new SupabaseDb(supabase),
      { organizationId: user.organizationId, actorId: user.userId },
      { photoId, photoKind },
    );
    revalidatePath("/gibier/reports");
  });
}

/** 捕獲票の共有リンクを再発行する（前のリンクはその場で無効になる） */
export async function reissueShareLinkAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { supabase, user } = await requireApprover();
    const reportId = String(formData.get("report_id") ?? "");
    if (!reportId) throw new Error("対象が指定されていません");

    await issueShareLink(new SupabaseDb(supabase), reportId, {
      ctx: { organizationId: user.organizationId, actorId: user.userId },
    });
    revalidatePath("/gibier/reports");
  });
}

/** 捕獲票の共有リンクを無効にする */
export async function revokeShareLinkAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { supabase, user } = await requireApprover();
    const reportId = String(formData.get("report_id") ?? "");
    if (!reportId) throw new Error("対象が指定されていません");

    await revokeShareLink(
      new SupabaseDb(supabase),
      { organizationId: user.organizationId, actorId: user.userId },
      reportId,
    );
    revalidatePath("/gibier/reports");
  });
}
