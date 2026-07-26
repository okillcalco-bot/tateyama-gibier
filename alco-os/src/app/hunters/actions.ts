"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getCurrentUser, canApprove } from "@/lib/auth";
import { runAction, runActionWith, type ActionResult, type ActionResultWith } from "@/lib/action-result";
import {
  importHunterProfilesCsv,
  revealBankAccount,
  saveHunterBankAccount,
  saveHunterProfile,
  type CsvRowResult,
} from "@/domain/hunters/hunter-profile-service";

/**
 * 捕獲者の追加情報と口座（B案 / 2026-07-26 確定）。
 *
 * - 追加情報の保存はログイン済みスタッフ
 * - **口座の保存・フル表示は owner / manager のみ**（監査ログ付き）
 * - LINEでは口座を扱わない。ここは職員が電話・対面で聞き取った内容を入れる画面
 */

export async function saveHunterProfileAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const supabase = await createSupabaseServerClient();
    const user = await getCurrentUser(supabase);
    if (!user) throw new Error("ログインが必要です");

    const hunterId = String(formData.get("hunter_id") ?? "");
    if (!hunterId) throw new Error("捕獲者を選んでください");

    const workerCard = String(formData.get("has_worker_card") ?? "");
    await saveHunterProfile(
      new SupabaseDb(supabase),
      { organizationId: user.organizationId, actorId: user.userId },
      {
        hunterId,
        birthDate: String(formData.get("birth_date") ?? "").trim() || null,
        postalCode: String(formData.get("postal_code") ?? "").trim() || null,
        address: String(formData.get("address") ?? "").trim() || null,
        phone: String(formData.get("phone") ?? "").trim() || null,
        activityArea: String(formData.get("activity_area") ?? "").trim() || null,
        hasWorkerCard: workerCard === "" ? null : workerCard === "あり",
        workerCardNumber: String(formData.get("worker_card_number") ?? "").trim() || null,
        note: String(formData.get("note") ?? "").trim() || null,
        source: "hearing",
      },
    );
    revalidatePath("/hunters");
  });
}

export async function saveBankAccountAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const supabase = await createSupabaseServerClient();
    const user = await getCurrentUser(supabase);
    if (!user) throw new Error("ログインが必要です");
    if (!(await canApprove(supabase))) {
      throw new Error("口座の登録には承認権限が必要です（管理者に依頼してください）");
    }

    const hunterId = String(formData.get("hunter_id") ?? "");
    if (!hunterId) throw new Error("捕獲者を選んでください");

    await saveHunterBankAccount(
      new SupabaseDb(supabase),
      { organizationId: user.organizationId, actorId: user.userId },
      {
        hunterId,
        bankName: String(formData.get("bank_name") ?? ""),
        bankBranch: String(formData.get("bank_branch") ?? ""),
        accountType: String(formData.get("account_type") ?? ""),
        accountNumber: String(formData.get("account_number") ?? ""),
        accountHolder: String(formData.get("account_holder") ?? ""),
      },
    );
    revalidatePath("/hunters");
  });
}

/** 口座のフル表示。誰がいつ見たかを監査ログに残す */
export async function revealBankAccountAction(
  hunterId: string,
): Promise<ActionResultWith<{ accountNumber: string; accountHolder: string }>> {
  return runActionWith(async () => {
    const supabase = await createSupabaseServerClient();
    const user = await getCurrentUser(supabase);
    if (!user) throw new Error("ログインが必要です");
    if (!(await canApprove(supabase))) {
      throw new Error("口座の表示には承認権限が必要です");
    }

    const hunter = await revealBankAccount(
      new SupabaseDb(supabase),
      { organizationId: user.organizationId, actorId: user.userId },
      hunterId,
    );
    return {
      accountNumber: String(hunter.account_number ?? ""),
      accountHolder: String(hunter.account_holder ?? ""),
    };
  });
}

export async function importProfilesCsvAction(
  formData: FormData,
): Promise<ActionResultWith<{ savedCount: number; results: CsvRowResult[] }>> {
  return runActionWith(async () => {
    const supabase = await createSupabaseServerClient();
    const user = await getCurrentUser(supabase);
    if (!user) throw new Error("ログインが必要です");
    if (!(await canApprove(supabase))) {
      throw new Error("一括取り込みには承認権限が必要です");
    }

    const csvText = String(formData.get("csv_text") ?? "").trim();
    if (!csvText) throw new Error("CSVの中身を貼り付けてください");

    return importHunterProfilesCsv(
      new SupabaseDb(supabase),
      { organizationId: user.organizationId, actorId: user.userId },
      csvText,
    );
  });
}
