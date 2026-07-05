"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getCurrentUser } from "@/lib/auth";
import { getProvider } from "@/ai/model-router";
import { generateGrantDraft } from "@/ai/workflows/generate-grant-draft";
import { writeAuditLog } from "@/domain/audit/audit-log-service";

/** 補助金案件の新規登録 */
export async function createGrantProject(formData: FormData) {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("案件名を入力してください");

  const db = new SupabaseDb(supabase);
  const project = await db.insert("grant_projects", {
    organization_id: user.organizationId,
    name,
    target_business: String(formData.get("target_business") ?? "").trim() || null,
    requested_amount: Number(formData.get("requested_amount")) || null,
    status: "preparing",
    note: String(formData.get("note") ?? "").trim() || null,
    created_by: user.userId,
  });

  await writeAuditLog(db, { organizationId: user.organizationId, actorId: user.userId }, {
    action: "insert",
    tableName: "grant_projects",
    recordId: project.id as string,
    after: project,
  });

  revalidatePath("/grants");
}

/** 要件の一括追加（1行1要件で貼り付け） */
export async function addRequirements(grantProjectId: string, formData: FormData) {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");

  const lines = String(formData.get("requirements") ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error("要件を入力してください");

  const db = new SupabaseDb(supabase);
  const existing = await db.findMany("grant_requirements", { grant_project_id: grantProjectId });
  let sortOrder = existing.length;
  for (const line of lines) {
    await db.insert("grant_requirements", {
      organization_id: user.organizationId,
      grant_project_id: grantProjectId,
      requirement_text: line,
      sort_order: ++sortOrder,
    });
  }

  revalidatePath(`/grants/${grantProjectId}`);
}

/** 要件の充足状態トグル（null → 充足 → 未充足 → null） */
export async function setRequirementMet(
  requirementId: string,
  grantProjectId: string,
  isMet: boolean | null,
) {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");

  const db = new SupabaseDb(supabase);
  await db.update("grant_requirements", requirementId, { is_met: isMet });
  revalidatePath(`/grants/${grantProjectId}`);
}

/**
 * 申請書ドラフト生成。
 * DB上の案件・要件・経費のみを入力にする。生成物は generated_drafts に
 * draft として保存され、/drafts での承認後に grant_documents へ確定する。
 */
export async function generateGrantDraftAction(grantProjectId: string) {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");

  const db = new SupabaseDb(supabase);
  const project = await db.findById("grant_projects", grantProjectId);
  if (!project) throw new Error("案件が見つかりません");

  const opportunity = project.opportunity_id
    ? await db.findById("grant_opportunities", project.opportunity_id as string)
    : null;
  const requirements = await db.findMany("grant_requirements", {
    grant_project_id: grantProjectId,
  });
  const budgetItems = await db.findMany("grant_budget_items", {
    grant_project_id: grantProjectId,
  });

  // 確定している事実のみを渡す（充足確認済みの要件 + 根拠メモ）
  const knownFacts = [
    ...(project.note ? [`案件メモ: ${project.note}`] : []),
    ...requirements
      .filter((r) => r.is_met === true)
      .map(
        (r) =>
          `要件充足: ${r.requirement_text}${r.evidence_note ? `（根拠: ${r.evidence_note}）` : ""}`,
      ),
  ];

  await generateGrantDraft(
    { db, provider: getProvider(), organizationId: user.organizationId, userId: user.userId },
    {
      grant_name: (opportunity?.name as string) ?? (project.name as string),
      raw_requirements: (opportunity?.raw_requirements as string) ?? "",
      business_summary: `${project.name}（対象事業: ${project.target_business ?? "未指定"}）`,
      known_facts: knownFacts,
      budget_items: budgetItems.map((item) => ({
        category: item.category as string,
        item_name: item.item_name as string,
        amount: Number(item.amount) || 0,
      })),
    },
    { grantProjectId },
  );

  revalidatePath(`/grants/${grantProjectId}`);
  revalidatePath("/drafts");
}
