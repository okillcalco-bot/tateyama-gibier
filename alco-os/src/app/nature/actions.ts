"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getCurrentUser } from "@/lib/auth";
import { getProvider } from "@/ai/model-router";
import { generateNatureReport } from "@/ai/workflows/generate-nature-report";
import { writeAuditLog } from "@/domain/audit/audit-log-service";
import { runAction, type ActionResult } from "@/lib/action-result";

const STORAGE_BUCKET = "alco-os";

/** 対象地の新規登録 */
async function do_createSite(formData: FormData) {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("対象地名を入力してください");

  const db = new SupabaseDb(supabase);
  const site = await db.insert("sites", {
    organization_id: user.organizationId,
    name,
    site_type: String(formData.get("site_type") ?? "") || null,
    address: String(formData.get("address") ?? "").trim() || null,
    area_ha: Number(formData.get("area_ha")) || null,
    oecm_status: String(formData.get("oecm_status") ?? "") || "none",
    description: String(formData.get("description") ?? "").trim() || null,
    created_by: user.userId,
  });

  await writeAuditLog(db, { organizationId: user.organizationId, actorId: user.userId }, {
    action: "insert",
    tableName: "sites",
    recordId: site.id as string,
    after: site,
  });

  revalidatePath("/nature");
}

/**
 * 生物観察記録の登録（写真・GPS付き）。
 * 写真は Storage（非公開バケット）へ保存し、files 台帳に記録して
 * observation.photo_file_id で紐付ける = 証跡の最小単位。
 */
async function do_addObservation(siteId: string, formData: FormData) {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");

  const speciesName = String(formData.get("species_name") ?? "").trim();
  if (!speciesName) throw new Error("種名を入力してください");

  const db = new SupabaseDb(supabase);
  const lat = Number(formData.get("lat")) || null;
  const lng = Number(formData.get("lng")) || null;

  const observation = await db.insert("biodiversity_observations", {
    organization_id: user.organizationId,
    site_id: siteId,
    observed_at: String(formData.get("observed_at") ?? "") || new Date().toISOString(),
    species_name: speciesName,
    taxon_group: String(formData.get("taxon_group") ?? "") || null,
    count: Number(formData.get("count")) || null,
    observer: user.displayName,
    lat,
    lng,
    note: String(formData.get("note") ?? "").trim() || null,
    created_by: user.userId,
  });

  // 写真アップロード（任意）
  const photo = formData.get("photo");
  if (photo instanceof File && photo.size > 0) {
    const ext = photo.name.split(".").pop() || "jpg";
    const path = `observations/${siteId}/${observation.id}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(path, photo, { contentType: photo.type || "image/jpeg" });
    if (uploadError) throw new Error(`写真アップロード失敗: ${uploadError.message}`);

    const file = await db.insert("files", {
      organization_id: user.organizationId,
      bucket: STORAGE_BUCKET,
      path,
      filename: photo.name,
      mime_type: photo.type || null,
      size_bytes: photo.size,
      module: "nature",
      related_table: "biodiversity_observations",
      related_id: observation.id,
      captured_at: new Date().toISOString(),
      gps_lat: lat,
      gps_lng: lng,
      created_by: user.userId,
    });
    await db.update("biodiversity_observations", observation.id as string, {
      photo_file_id: file.id,
    });
  }

  await writeAuditLog(db, { organizationId: user.organizationId, actorId: user.userId }, {
    action: "insert",
    tableName: "biodiversity_observations",
    recordId: observation.id as string,
    after: observation,
  });

  revalidatePath(`/nature/${siteId}`);
}

/** 管理作業履歴の登録 */
async function do_addManagementAction(siteId: string, formData: FormData) {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");

  const actionType = String(formData.get("action_type") ?? "").trim();
  if (!actionType) throw new Error("作業種別を入力してください");

  const db = new SupabaseDb(supabase);
  const action = await db.insert("management_actions", {
    organization_id: user.organizationId,
    site_id: siteId,
    action_date: String(formData.get("action_date") ?? "") || new Date().toISOString().slice(0, 10),
    action_type: actionType,
    description: String(formData.get("description") ?? "").trim() || null,
    hours: Number(formData.get("hours")) || null,
    created_by: user.userId,
  });

  await writeAuditLog(db, { organizationId: user.organizationId, actorId: user.userId }, {
    action: "insert",
    tableName: "management_actions",
    recordId: action.id as string,
    after: action,
  });

  revalidatePath(`/nature/${siteId}`);
}

/**
 * レポートドラフト生成。
 * DB上の観察記録・管理作業のみを入力とし、出力の証跡引用は
 * ワークフロー側のスキーマ検証で実在チェックされる（捏造IDは保存拒否）。
 */
async function do_generateNatureReportAction(siteId: string, clientPurpose: string) {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");

  const db = new SupabaseDb(supabase);
  const site = await db.findById("sites", siteId);
  if (!site) throw new Error("対象地が見つかりません");

  const observations = await db.findMany("biodiversity_observations", { site_id: siteId }, 500);
  const actions = await db.findMany("management_actions", { site_id: siteId }, 500);

  await generateNatureReport(
    { db, provider: getProvider(), organizationId: user.organizationId, userId: user.userId },
    {
      site_name: site.name as string,
      site_description: (site.description as string) ?? "",
      client_purpose: clientPurpose,
      observations: observations.map((o) => ({
        id: o.id as string,
        observed_at: String(o.observed_at),
        species_name: o.species_name as string,
        taxon_group: (o.taxon_group as string) ?? null,
        note: (o.note as string) ?? null,
      })),
      management_actions: actions.map((m) => ({
        id: m.id as string,
        action_date: String(m.action_date),
        action_type: m.action_type as string,
        description: (m.description as string) ?? null,
      })),
    },
    { siteId },
  );

  revalidatePath(`/nature/${siteId}`);
  revalidatePath("/drafts");
}

// ── 公開 server actions（エラーは ActionResult で返す） ──

export async function createSite(formData: FormData): Promise<ActionResult> {
  return runAction(() => do_createSite(formData));
}

export async function addObservation(siteId: string, formData: FormData): Promise<ActionResult> {
  return runAction(() => do_addObservation(siteId, formData));
}

export async function addManagementAction(
  siteId: string,
  formData: FormData,
): Promise<ActionResult> {
  return runAction(() => do_addManagementAction(siteId, formData));
}

export async function generateNatureReportAction(
  siteId: string,
  clientPurpose: string,
): Promise<ActionResult> {
  return runAction(() => do_generateNatureReportAction(siteId, clientPurpose));
}
