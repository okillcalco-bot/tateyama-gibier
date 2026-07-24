"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getCurrentUser } from "@/lib/auth";
import { getProvider } from "@/ai/model-router";
import { parseFieldNote } from "@/ai/workflows/parse-field-note";
import {
  createObservation,
  reviewObservation,
  createTaxon,
  type ReviewStatus,
  type VisibilityLevel,
} from "@/domain/satoyama/observation-service";
import { runAction, type ActionResult } from "@/lib/action-result";

const STORAGE_BUCKET = "alco-os";

async function requireCtx() {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");
  return {
    supabase,
    db: new SupabaseDb(supabase),
    ctx: { organizationId: user.organizationId, actorId: user.userId },
  };
}

/** かんたん投稿: 写真 + GPS + 種名（不明可）を3タップで登録 */
export async function quickObservationAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { supabase, db, ctx } = await requireCtx();

    // 写真アップロード（証跡。Storage は削除不可ポリシー）
    let photoFileId: string | null = null;
    const photo = formData.get("photo");
    if (photo instanceof File && photo.size > 0) {
      const ext = photo.name.split(".").pop() || "jpg";
      const path = `observations/${crypto.randomUUID()}.${ext}`;
      const { error } = await supabase.storage
        .from(STORAGE_BUCKET)
        .upload(path, photo, { contentType: photo.type || "image/jpeg" });
      if (error) throw new Error(`写真アップロード失敗: ${error.message}`);
      const file = await db.insert("files", {
        organization_id: ctx.organizationId,
        bucket: STORAGE_BUCKET,
        path,
        filename: photo.name,
        mime_type: photo.type || null,
        size_bytes: photo.size,
        module: "nature",
        related_table: "biodiversity_observations",
        created_by: ctx.actorId,
      });
      photoFileId = file.id as string;
    }

    // 種マスタの感度を引く（希少種なら自動で公開範囲を落とす）
    const taxonId = String(formData.get("taxon_id") ?? "") || null;
    let taxonSensitivity: string | null = null;
    let taxonGroup = String(formData.get("taxon_group") ?? "") || null;
    let speciesName = String(formData.get("species_name") ?? "").trim();
    if (taxonId) {
      const taxon = await db.findById("taxa", taxonId);
      if (taxon) {
        taxonSensitivity = (taxon.sensitivity as string) ?? null;
        taxonGroup = taxonGroup || ((taxon.taxon_group as string) ?? null);
        speciesName = speciesName || (taxon.common_name as string);
      }
    }

    await createObservation(db, ctx, {
      siteId: String(formData.get("site_id") ?? ""),
      observedAt: String(formData.get("observed_at") ?? "") || new Date().toISOString(),
      speciesName: speciesName || "不明",
      taxonId,
      taxonGroup,
      count: Number(formData.get("count")) || null,
      lat: Number(formData.get("lat")) || null,
      lng: Number(formData.get("lng")) || null,
      observer: String(formData.get("observer") ?? ""),
      note: String(formData.get("note") ?? ""),
      evidenceType: String(formData.get("evidence_type") ?? "sighting"),
      sourceType: "observed",
      visibilityLevel: (String(formData.get("visibility_level") ?? "members") as VisibilityLevel),
      taxonSensitivity,
      sensitivityOverride: String(formData.get("sensitivity") ?? "") || null,
      photoFileId,
    });

    revalidatePath("/nature");
    revalidatePath("/nature/quick");
  });
}

/** 現場メモ（音声の文字起こし・走り書き）をAIで構造化 → 候補はドラフトへ */
export async function parseFieldNoteAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    const siteId = String(formData.get("site_id") ?? "") || undefined;
    const rawText = String(formData.get("raw_text") ?? "").trim();
    if (!rawText) throw new Error("メモを入力してください");

    const [site, taxa] = await Promise.all([
      siteId ? db.findById("sites", siteId) : Promise.resolve(null),
      db.findMany("taxa", { organization_id: ctx.organizationId }, 200),
    ]);

    await parseFieldNote(
      { db, provider: getProvider(), organizationId: ctx.organizationId, userId: ctx.actorId },
      {
        raw_text: rawText.slice(0, 10000),
        site_name: (site?.name as string) ?? "",
        observed_at: String(formData.get("observed_at") ?? ""),
        known_taxa: taxa.map((t) => t.common_name as string),
      },
      { siteId },
    );

    revalidatePath("/drafts");
    revalidatePath("/nature/quick");
  });
}

export async function reviewObservationAction(
  observationId: string,
  status: ReviewStatus,
  note?: string,
): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    await reviewObservation(db, ctx, observationId, status, note);
    revalidatePath("/nature/review");
    revalidatePath("/nature");
  });
}

export async function createTaxonAction(formData: FormData): Promise<ActionResult> {
  return runAction(async () => {
    const { db, ctx } = await requireCtx();
    await createTaxon(db, ctx, {
      commonName: String(formData.get("common_name") ?? ""),
      scientificName: String(formData.get("scientific_name") ?? ""),
      taxonGroup: String(formData.get("taxon_group") ?? ""),
      redListStatus: String(formData.get("red_list_status") ?? ""),
      sensitivity: (String(formData.get("sensitivity") ?? "normal") as "normal" | "caution" | "sensitive"),
    });
    revalidatePath("/nature/quick");
    revalidatePath("/nature/gaps");
  });
}
