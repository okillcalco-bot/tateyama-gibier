"use server";

import { revalidatePath } from "next/cache";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SupabaseDb } from "@/lib/db/supabase-db";
import { getCurrentUser } from "@/lib/auth";
import { getProvider } from "@/ai/model-router";
import { generatePresentation, generateVideoPlan } from "@/ai/workflows/generate-media-plan";
import { writeAuditLog } from "@/domain/audit/audit-log-service";
import { runAction, type ActionResult } from "@/lib/action-result";

const STORAGE_BUCKET = "alco-os";

/** メディア案件（プレゼン / YouTube動画）の新規登録。写真・素材も同時アップロード */
async function do_createMediaProject(formData: FormData) {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");

  const kind = String(formData.get("kind") ?? "presentation");
  const title = String(formData.get("title") ?? "").trim();
  if (!title) throw new Error("案件名を入力してください");

  const db = new SupabaseDb(supabase);
  const project = await db.insert("media_projects", {
    organization_id: user.organizationId,
    kind,
    title,
    target_audience: String(formData.get("target_audience") ?? "").trim() || null,
    duration_minutes: Number(formData.get("duration_minutes")) || 15,
    format: String(formData.get("format") ?? "").trim() || null,
    key_messages: String(formData.get("key_messages") ?? "").trim() || null,
    source_material: String(formData.get("source_material") ?? "").trim() || null,
    status: "brief",
    created_by: user.userId,
  });

  // 写真・素材のアップロード（AIはファイル名で割付するため、表示名は原名を保持）
  const photos = formData.getAll("photos");
  let index = 0;
  for (const photo of photos) {
    if (!(photo instanceof File) || photo.size === 0) continue;
    index += 1;
    const ext = photo.name.split(".").pop() || "jpg";
    const path = `media/${project.id}/${index}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from(STORAGE_BUCKET)
      .upload(path, photo, { contentType: photo.type || "application/octet-stream" });
    if (uploadError) throw new Error(`素材アップロード失敗: ${uploadError.message}`);
    await db.insert("files", {
      organization_id: user.organizationId,
      bucket: STORAGE_BUCKET,
      path,
      filename: photo.name,
      mime_type: photo.type || null,
      size_bytes: photo.size,
      module: "media",
      related_table: "media_projects",
      related_id: project.id,
      created_by: user.userId,
    });
  }

  await writeAuditLog(db, { organizationId: user.organizationId, actorId: user.userId }, {
    action: "insert",
    tableName: "media_projects",
    recordId: project.id as string,
    after: project,
  });

  revalidatePath("/media");
}

/** AI生成（構成 / 台本）。結果は承認待ちドラフトになる */
async function do_generateMediaPlan(projectId: string) {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");

  const db = new SupabaseDb(supabase);
  const project = await db.findById("media_projects", projectId);
  if (!project) throw new Error("案件が見つかりません");

  const assets = await db.findMany(
    "files",
    { related_table: "media_projects", related_id: projectId },
    100,
  );

  const brief = {
    title: project.title as string,
    target_audience: (project.target_audience as string) ?? "",
    duration_minutes: Number(project.duration_minutes) || 15,
    format: (project.format as string) ?? "",
    key_messages: (project.key_messages as string) ?? "",
    source_material: (project.source_material as string) ?? "",
    photo_filenames: assets
      .filter((file) => !file.deleted_at)
      .map((file) => file.filename as string),
  };

  const ctx = {
    db,
    provider: getProvider(),
    organizationId: user.organizationId,
    userId: user.userId,
  };

  if (project.kind === "youtube_video") {
    await generateVideoPlan(ctx, brief, { mediaProjectId: projectId });
  } else {
    await generatePresentation(ctx, brief, { mediaProjectId: projectId });
  }

  revalidatePath(`/media/${projectId}`);
  revalidatePath("/drafts");
}

/** YouTubeへ手動アップロード後の動画ID登録 + ステータス更新（uploaded / published） */
async function do_registerYoutubeVideo(projectId: string, videoId: string, status: string) {
  const supabase = await createSupabaseServerClient();
  const user = await getCurrentUser(supabase);
  if (!user) throw new Error("ログインが必要です");
  if (!["uploaded", "published"].includes(status)) throw new Error(`不正なステータス: ${status}`);
  const trimmed = videoId.trim();
  if (!/^[\w-]{6,20}$/.test(trimmed)) throw new Error("YouTube動画IDの形式が不正です");

  const db = new SupabaseDb(supabase);
  const before = await db.findById("media_projects", projectId);
  if (!before) throw new Error("案件が見つかりません");
  const after = await db.update("media_projects", projectId, {
    youtube_video_id: trimmed,
    status,
  });
  await writeAuditLog(db, { organizationId: user.organizationId, actorId: user.userId }, {
    action: "update",
    tableName: "media_projects",
    recordId: projectId,
    before,
    after,
    note: `YouTube動画ID登録（${status}）`,
  });
  revalidatePath(`/media/${projectId}`);
  revalidatePath("/media");
}

// ── 公開 server actions（エラーは ActionResult で返す） ──

export async function createMediaProject(formData: FormData): Promise<ActionResult> {
  return runAction(() => do_createMediaProject(formData));
}

export async function generateMediaPlanAction(projectId: string): Promise<ActionResult> {
  return runAction(() => do_generateMediaPlan(projectId));
}

export async function registerYoutubeVideoAction(
  projectId: string,
  videoId: string,
  status: string,
): Promise<ActionResult> {
  return runAction(() => do_registerYoutubeVideo(projectId, videoId, status));
}
